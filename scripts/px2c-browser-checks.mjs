#!/usr/bin/env node
// PX-2c local browser checks: the designed sign-in, recovery, password-setup and email-link screens, the signed-in indicator, sign-out and the session re-check
// on focus, in a REAL headless Chrome against the real local pilot Auth stack (see px2b-pilot.mjs), Mailpit and a fault-injecting proxy. Local only.
//   node scripts/px2b-pilot.mjs up ; npx next build ; node --conditions=react-server scripts/px2c-browser-checks.mjs
// Screenshots go to docs/ux/review-px2c/ (untracked). The service key is used only here (create/invite/delete test users); the app never receives it.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { launch, newPage, sleep } from './lib/cdp.mjs';

const SUPABASE = process.env.SUPABASE_BIN || 'supabase';
const APP_PORT = 3100, PROXY_PORT = 55499; const APP = `http://localhost:${APP_PORT}`;
const OUT = fileURLToPath(new URL('../docs/ux/review-px2c/', import.meta.url)); mkdirSync(OUT, { recursive: true });
const st = spawnSync(SUPABASE, ['status', '--workdir', 'supabase-pilot', '-o', 'json'], { encoding: 'utf8', timeout: 60_000 });
let cfg; try { cfg = JSON.parse(st.stdout.slice(st.stdout.indexOf('{'))); } catch { console.error('BLOCKED  the pilot Auth stack is not running'); process.exit(2); }
const API = cfg.API_URL, PUB = cfg.PUBLISHABLE_KEY, SECRET = cfg.SECRET_KEY, MAIL = cfg.MAILPIT_URL || cfg.INBUCKET_URL;
const admin = createClient(API, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });

const proxyState = { mode: 'pass' };
const proxy = http.createServer((req, res) => {
  if (proxyState.mode === 'down') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"message":"simulated outage"}'); return; }
  const up = http.request({ host: '127.0.0.1', port: Number(new URL(API).port), path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
}).listen(PROXY_PORT);

let failed = 0; const results = [];
async function check(id, title, fn) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(id)) return;
  let guard; try { const facts = await Promise.race([fn(), new Promise((_r, rej) => { guard = setTimeout(() => rej(new Error('check exceeded 150 s (hung)')), 150_000); })]); clearTimeout(guard); results.push({ id, ok: true }); console.log(`PASS  ${id}  ${title}${facts ? `  [${facts}]` : ''}`); }
  catch (e) { clearTimeout(guard); failed++; results.push({ id, ok: false }); console.log(`FAIL  ${id}  ${title}  -> ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m); };

const SECRETS = { CURSOR_SIGNING_SECRET: randomBytes(32).toString('base64url'), AUTH_THROTTLE_SECRET: randomBytes(32).toString('base64url'), AUTH_SETUP_MARKER_SECRET: randomBytes(32).toString('base64url') };
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(APP_PORT)], { env: { ...process.env, ...SECRETS, APP_ENV: 'local', APP_ORIGIN: APP, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${PROXY_PORT}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUB, TRUSTED_CLIENT_IP_HEADER: 'x-test-client-ip', NODE_ENV: 'production' }, stdio: 'ignore' });
let up = false; for (let i = 0; i < 60 && !up; i++) { try { up = !!(await fetch(`${APP}/auth/session`)).status; } catch { await sleep(500); } }
if (!up) { console.error('BLOCKED  the app did not start (run `npx next build` first)'); app.kill(); proxy.close(); process.exit(2); }

// ---- helpers -----------------------------------------------------------------------------------------------------------------------------------------------
const uniq = () => randomBytes(4).toString('hex'); const PW = 'correct horse battery staple';
let ipN = 50; const nextIp = () => `198.51.100.${(ipN++ % 250) + 1}`;
async function mailFor(address, tries = 30) { for (let i = 0; i < tries; i++) { const r = await (await fetch(`${MAIL}/api/v1/messages`)).json(); const hit = (r.messages || []).filter((m) => (m.To || []).some((t) => t.Address.toLowerCase() === address.toLowerCase())); if (hit.length) return hit; await sleep(300); } return []; }
async function mailLink(address) { const msgs = await mailFor(address); if (!msgs.length) return null; const m = await (await fetch(`${MAIL}/api/v1/message/${msgs[0].ID}`)).json(); const h = (m.HTML || '').match(/href="([^"]*\/auth\/callback[^"]*)"/); return h ? h[1].replace(/&amp;/g, '&') : null; }
async function mailClear() { await fetch(`${MAIL}/api/v1/messages`, { method: 'DELETE' }).catch(() => {}); }
async function newMember(tag) { const email = `px2c-${tag}-${uniq()}@example.test`; const r = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true }); if (r.error) throw new Error(r.error.message); return { email, id: r.data.user.id }; }

const { proc, port } = await launch(9300 + Math.floor(Math.random() * 600));
// Every test starts from a clean browser (no cookies left by an earlier test); `keep` is for a second tab that must share the first tab's session.
async function page(w = 1280, h = 800, mobile = false, ip = nextIp(), keep = false) { const p = await newPage(port); await p.viewport(w, h, mobile); await p.send('Network.enable'); if (!keep) await p.send('Network.clearBrowserCookies'); await p.send('Network.setExtraHTTPHeaders', { headers: { 'x-test-client-ip': ip } }); return p; }
const text = (p, sel = 'body') => p.ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const chip = (p) => text(p, '.account-chip');
async function waitFor(p, expr, ms = 8000, label = expr) { const t0 = Date.now(); for (;;) { try { if (await p.ev(`!!(${expr})`)) return true; } catch {} if (Date.now() - t0 > ms) { let where = ''; try { where = await p.ev("location.pathname + ' | ' + document.body.innerText.replace(/\\s+/g, ' ').slice(0, 260)"); } catch {} throw new Error(`timed out waiting for: ${label} (page: ${where})`); } await sleep(150); } }
const click = async (p, sel, text = '') => { await waitFor(p, `[...document.querySelectorAll(${JSON.stringify(sel)})].some((x) => x.textContent.includes(${JSON.stringify(text)}))`, 10000, `click target ${sel} "${text}"`); return p.click(sel, text); };
async function typeInto(p, sel, value) { await waitFor(p, `!!document.querySelector(${JSON.stringify(sel)})`, 10000, `element ${sel}`); await p.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select?.(); return true; })()`); await p.insertText(value); }
async function tabTo(p, pred, max = 40) { for (let i = 0; i < max; i++) { await p.key('Tab'); if (await p.ev(pred)) return i + 1; } throw new Error(`Tab never reached: ${pred}`); }
async function offenders(p) { return p.ev(`[...document.querySelectorAll('a[href],button,input,select,textarea,[role=tab]')].filter(e => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden' && e.type !== 'hidden' && !e.classList.contains('skip') && !e.closest('p, li')).map(e => { const r = e.getBoundingClientRect(); return { t: (e.innerText || e.id || e.name || e.tagName).trim().slice(0, 28), h: Math.round(r.height) }; }).filter(x => x.h < 44)`); }
const overflow = (p) => p.ev('document.documentElement.scrollWidth > innerWidth + 1');
async function signInViaUi(p, m, next = '') { await p.goto(`${APP}/account/sign-in${next}`); await typeInto(p, '#signin-email', m.email); await typeInto(p, '#signin-password', PW); await p.key('Enter'); }
async function getAuthCookies(p) { const { cookies } = await p.send('Network.getCookies', { urls: [APP] }); return cookies.filter((c) => /^sb-.+-auth-token/.test(c.name)); }
async function forgeExpired(p) {
  const cs = (await getAuthCookies(p)).sort((a, b) => a.name.localeCompare(b.name)); const raw = cs.map((c) => c.value).join(''); const b64 = raw.startsWith('base64-');
  const j = JSON.parse(Buffer.from(b64 ? raw.slice(7) : decodeURIComponent(raw), b64 ? 'base64url' : 'utf8').toString('utf8')); j.expires_at = 1000; const enc = 'base64-' + Buffer.from(JSON.stringify(j)).toString('base64url');
  const base = cs[0].name.replace(/\.\d+$/, ''); for (const c of cs) await p.send('Network.deleteCookies', { name: c.name, url: APP });
  const parts = enc.length <= 3180 ? [[base, enc]] : Array.from({ length: Math.ceil(enc.length / 3180) }, (_x, i) => [`${base}.${i}`, enc.slice(i * 3180, (i + 1) * 3180)]);
  for (const [name, value] of parts) await p.send('Network.setCookie', { name, value, url: APP, httpOnly: true, sameSite: 'Lax', path: '/' });
}
async function startDraft(p, draft = 'MY UNSAVED DRAFT') { await p.goto(`${APP}/spark/demo/meal`); await click(p, 'button', 'Adapt in The Lab'); await waitFor(p, "location.pathname === '/lab'"); await typeInto(p, '#fullPrompt', draft); await p.ev("window.__doc = 'same-document'; window.__unload = 0; window.addEventListener('beforeunload', () => { window.__unload++; }); true"); }
const draftIntact = (p, draft = 'MY UNSAVED DRAFT') => p.ev(`document.querySelector('#fullPrompt')?.value === ${JSON.stringify(draft)} && window.__doc === 'same-document' && window.__unload === 0`);
const shot = (p, name) => p.shot(`${OUT}${name}.png`);

try {
  // ======== A: screens, accessibility, design ========
  await check('A1', 'anonymous: the indicator says "Not signed in" with a Sign in link; no sign-up/register anywhere on sign-in, recovery, the shell or the email-link pages', async () => {
    const p = await page(); await p.goto(`${APP}/spark`); await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Not signed in')");
    ok(/Sign in/.test(await chip(p)), 'no sign-in link'); await shot(p, 'desktop-01-spark-anonymous');
    for (const path of ['/account/sign-in', '/account/recover', '/spark', '/lab']) { await p.goto(APP + path); const t = (await text(p)).toLowerCase(); ok(!/sign up|signup|register an|create (an )?account|create your account/.test(t.replace('registration is closed', '')), `${path}: registration wording`); }
    await p.goto(`${APP}/account/sign-in`); ok(/Registration is closed for now/.test(await text(p)), 'closed notice missing'); ok((await p.ev("[...document.querySelectorAll('a')].map(a => a.getAttribute('href')).some(h => /sign-?up|register/i.test(h || ''))")) === false, 'a sign-up link exists');
    const nf = await fetch(`${APP}/account/sign-up`); ok(nf.status === 404, `/account/sign-up ${nf.status}`); p.close(); return 'no registration path; /account/sign-up 404';
  });
  await check('A2', 'sign-in screen, desktop and 375 px mobile: one h1, labelled fields, correct autocomplete, tab order email -> password -> Sign in -> Forgot, every control at least 44 px, no horizontal scroll', async () => {
    for (const [name, w, h, mobile] of [['desktop', 1280, 800, false], ['mobile', 375, 812, true]]) {
      const p = await page(w, h, mobile); await p.goto(`${APP}/account/sign-in`);
      const f = await p.ev("({ h1: document.querySelectorAll('h1').length, le: document.querySelector('label[for=signin-email]')?.innerText, lp: document.querySelector('label[for=signin-password]')?.innerText, ac: [document.querySelector('#signin-email').autocomplete, document.querySelector('#signin-password').autocomplete], ty: [document.querySelector('#signin-email').type, document.querySelector('#signin-password').type] })");
      ok(f.h1 === 1 && f.le === 'Email' && f.lp === 'Password' && f.ac[0] === 'username' && f.ac[1] === 'current-password' && f.ty[0] === 'email' && f.ty[1] === 'password', JSON.stringify(f));
      const order = []; await p.ev("document.activeElement?.blur()"); for (let i = 0; i < 30 && order.length < 4; i++) { await p.key('Tab'); const id = await p.ev("document.activeElement?.id || document.activeElement?.innerText || ''"); if (['signin-email', 'signin-password', 'signin-submit', 'signin-forgot'].includes(id) && !order.includes(id)) order.push(id); }
      ok(JSON.stringify(order) === JSON.stringify(['signin-email', 'signin-password', 'signin-submit', 'signin-forgot']), `tab order ${JSON.stringify(order)}`);
      const off = await offenders(p); ok(off.length === 0, `${name}: controls under 44px: ${JSON.stringify(off)}`); ok(!(await overflow(p)), `${name}: horizontal scroll`); await shot(p, `${name}-02-sign-in`); p.close();
    }
    return 'desktop + mobile: structure, tab order, 44 px, no overflow';
  });
  await check('A3', 'keyboard-only sign-in: Tab to the fields, type, press Enter: the member is signed in, the indicator says "Signed in" and sign-out appears', async () => {
    const m = await newMember('kb'); const p = await page(); await p.goto(`${APP}/account/sign-in`);
    await tabTo(p, "document.activeElement?.id === 'signin-email'"); await p.insertText(m.email); await p.key('Tab'); await p.insertText(PW); await p.key('Enter');
    await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Signed in')", 10000); ok(/Sign out/.test(await chip(p)), 'no sign-out'); ok((await p.ev('location.pathname')) === '/spark', `landed on ${await p.ev('location.pathname')}`);
    ok((await getAuthCookies(p)).every((c) => c.httpOnly), 'session cookie readable by script'); ok((await p.ev('document.cookie')).indexOf('sb-') === -1, 'script can see the session cookie'); await shot(p, 'desktop-03-signed-in'); p.close(); return 'Enter submits; HttpOnly cookie; landed on /spark';
  });
  await check('A4', 'DRAFT SURVIVES sign-in: a draft in The Lab, then the Sign in link (client navigation), sign in, back to /lab: same document, same textarea value, no unload', async () => {
    const m = await newMember('draft'); const p = await page(); await startDraft(p); ok(await draftIntact(p), 'draft setup');
    await click(p, '.account-chip a', 'Sign in'); await waitFor(p, "location.pathname === '/account/sign-in'"); ok((await p.ev('location.search')).includes('next=%2Flab'), `next: ${await p.ev('location.search')}`);
    await typeInto(p, '#signin-email', m.email); await typeInto(p, '#signin-password', PW); await p.key('Enter'); await waitFor(p, "location.pathname === '/lab'", 10000);
    await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Signed in')"); ok(await draftIntact(p), 'the draft was lost'); await shot(p, 'desktop-04-draft-kept-after-sign-in'); p.close(); return 'same document, draft intact, returned to /lab';
  });
  await check('A5', 'wrong password: a clear message (alert, focused), uniform wording, the form is usable again, the draft is untouched', async () => {
    const m = await newMember('wrong'); const p = await page(); await startDraft(p); await click(p, '.account-chip a', 'Sign in'); await waitFor(p, "location.pathname === '/account/sign-in'");
    await typeInto(p, '#signin-email', m.email); await typeInto(p, '#signin-password', 'definitely not my password'); await p.key('Enter'); await waitFor(p, "document.querySelector('[role=alert]')");
    const t = await text(p, '[role=alert]'); ok(/email or password is not correct/.test(t), t); ok(await p.ev("document.activeElement?.contains?.(document.querySelector('[role=alert]')) || document.querySelector('[role=alert]').parentElement.contains(document.activeElement)"), 'focus did not move to the message');
    ok(await p.ev("!document.querySelector('button[type=submit]').disabled"), 'form still locked'); await shot(p, 'desktop-05-sign-in-wrong-password');
    await p.ev("document.querySelector('.account-chip a, nav a[href=\"/lab\"]'); true"); await click(p, 'nav a', 'The Lab'); await waitFor(p, "location.pathname === '/lab'"); ok(await draftIntact(p), 'draft lost after a failed sign-in'); p.close(); return 'alert focused; draft intact';
  });
  await check('A6', 'repeated wrong passwords: the rate-limit state ("Please wait a moment") appears in the UI; it names no account', async () => {
    const m = await newMember('rate'); const p = await page(); await p.goto(`${APP}/account/sign-in`);
    for (let i = 0; i < 6; i++) { await typeInto(p, '#signin-email', m.email); await typeInto(p, '#signin-password', 'wrong password ' + i); await p.key('Enter'); await waitFor(p, "!document.querySelector('button[type=submit]').disabled && document.querySelector('[role=alert]')", 8000); }
    const t = await text(p, '[role=alert]'); ok(/Please wait a moment/.test(t) && /Too many attempts/.test(t), t); await shot(p, 'desktop-06-sign-in-rate-limited'); p.close(); return 'rate-limit state shown on the 6th attempt';
  });
  await check('A7', 'Auth outage during sign-in: "temporarily unavailable" (the draft is mentioned as untouched and really is); after recovery the same form signs in', async () => {
    const m = await newMember('out'); const p = await page(); await startDraft(p); await click(p, '.account-chip a', 'Sign in'); await waitFor(p, "location.pathname === '/account/sign-in'");
    proxyState.mode = 'down'; await typeInto(p, '#signin-email', m.email); await typeInto(p, '#signin-password', PW); await p.key('Enter'); await waitFor(p, "document.querySelector('[role=alert]')", 12000);
    const t = await text(p, '[role=alert]'); ok(/temporarily unavailable/.test(t) && /unsaved work is untouched/.test(t), t); await shot(p, 'desktop-07-sign-in-outage'); proxyState.mode = 'pass';
    await typeInto(p, '#signin-password', PW); await p.key('Enter'); await waitFor(p, "location.pathname === '/lab'", 12000); ok(await draftIntact(p), 'draft lost across the outage'); p.close(); return 'outage message; retry works; draft intact';
  });

  // ======== B: indicator, sign-out, re-check on focus ========
  await check('B1', 'sign-out from the indicator: "Not signed in", cookies gone, toast says the work is still there, the draft is untouched', async () => {
    const m = await newMember('so'); const p = await page(); await signInViaUi(p, m); await waitFor(p, "location.pathname === '/spark'", 10000); await startDraft(p);
    await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Signed in')"); await click(p, '.account-chip button', 'Sign out'); await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Not signed in')");
    ok((await getAuthCookies(p)).length === 0, 'cookies remain'); ok(/Your unsaved work on this page is still here/.test(await text(p, '.toaster')), 'toast'); ok(await draftIntact(p), 'draft lost on sign-out'); p.close(); return 'cookies cleared; draft intact';
  });
  await check('B2', 'RE-CHECK ON FOCUS: sign-out in another tab is noticed when this tab regains focus ("You have been signed out"), without reload and with the draft intact', async () => {
    const m = await newMember('focus'); const ip = nextIp(); const a = await page(1280, 800, false, ip); await signInViaUi(a, m); await waitFor(a, "location.pathname === '/spark'", 10000); await startDraft(a);
    await waitFor(a, "document.querySelector('.account-chip')?.innerText.includes('Signed in')");
    const b = await page(1280, 800, false, ip, true); await b.goto(`${APP}/spark`); await waitFor(b, "document.querySelector('.account-chip')?.innerText.includes('Signed in')"); await click(b, '.account-chip button', 'Sign out'); await waitFor(b, "document.querySelector('.account-chip')?.innerText.includes('Not signed in')"); b.close();
    ok(/Signed in/.test(await chip(a)), 'tab A changed before focus'); await sleep(10_500); await a.send('Page.bringToFront');   // returning to the tab, as a member would   // the re-check is throttled to once per 10 s
    await a.ev("window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); true");
    await waitFor(a, "document.querySelector('.account-chip')?.innerText.includes('Not signed in')", 8000); ok(/You have been signed out/.test(await text(a, '.toaster')), 'no signed-out toast'); ok(await draftIntact(a), 'draft lost'); await shot(a, 'desktop-08-signed-out-elsewhere'); a.close(); return 'noticed on focus; toast; draft intact';
  });
  await check('B3', 'Auth OUTAGE during a re-check: the member stays shown as signed in with "can\'t check right now" + Try again; nothing is cleared, nothing navigates, the draft is intact; Try again recovers', async () => {
    const m = await newMember('degraded'); const p = await page(); await signInViaUi(p, m); await waitFor(p, "location.pathname === '/spark'", 10000); await startDraft(p);
    await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Signed in')"); await forgeExpired(p); proxyState.mode = 'down'; await sleep(10_500);
    await p.ev("window.dispatchEvent(new Event('focus')); true"); await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('can’t check right now')", 12000, 'degraded chip');
    ok(/Signed in/.test(await chip(p)) && /Try again/.test(await chip(p)), await chip(p)); ok((await getAuthCookies(p)).length >= 1, 'the outage cleared the cookie'); ok(await draftIntact(p), 'draft lost during the outage'); await shot(p, 'desktop-09-cant-check-right-now');
    proxyState.mode = 'pass'; await click(p, '.account-chip button', 'Try again'); await waitFor(p, "document.querySelector('.account-chip')?.innerText.trim().startsWith('Signed in') && !document.querySelector('.account-chip')?.innerText.includes('can’t check')", 12000, 'recovered chip'); ok(await draftIntact(p), 'draft lost after recovery'); p.close(); return 'degraded, nothing cleared, recovered with Try again';
  });
  await check('B4', 'indicator on mobile (375 px): chip wraps cleanly, controls >= 44 px, no horizontal scroll, in every state', async () => {
    const m = await newMember('mob'); const p = await page(375, 812, true); await p.goto(`${APP}/spark`); await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Not signed in')");
    ok((await offenders(p)).length === 0, `anon ${JSON.stringify(await offenders(p))}`); ok(!(await overflow(p)), 'overflow anon'); await shot(p, 'mobile-10-spark-anonymous');
    await signInViaUi(p, m); await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Signed in')", 10000); ok((await offenders(p)).length === 0, `member ${JSON.stringify(await offenders(p))}`); ok(!(await overflow(p)), 'overflow member'); await shot(p, 'mobile-11-signed-in');
    await forgeExpired(p); proxyState.mode = 'down'; await sleep(10_500); await p.ev("window.dispatchEvent(new Event('focus')); true"); await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('can’t check right now')", 12000);
    ok((await offenders(p)).length === 0, `degraded ${JSON.stringify(await offenders(p))}`); ok(!(await overflow(p)), 'overflow degraded'); await shot(p, 'mobile-12-cant-check'); proxyState.mode = 'pass'; p.close(); return 'anonymous / signed in / degraded: 44 px, no overflow';
  });

  await check('B5', 'STALE CHECKS cannot overwrite a newer action (real browser, /auth/session responses held back): a slow "member" answer cannot undo a sign-out, a slow "anonymous" answer cannot undo a sign-in, and a held refresh response cannot bring the old session cookies back', async () => {
    const hold = async (p) => { await p.send('Fetch.enable', { patterns: [{ urlPattern: '*/auth/session', requestStage: 'Response' }] }); p.events.length = 0; };
    const paused = async (p) => { await waitFor(p, 'true', 1); const t0 = Date.now(); for (;;) { const e = p.events.find((x) => x.method === 'Fetch.requestPaused'); if (e) return e.params.requestId; if (Date.now() - t0 > 12000) throw new Error('the check was never held'); await sleep(100); } };
    const release = async (p, id) => { try { await p.send('Fetch.continueResponse', { requestId: id }); } catch { /* the request was cancelled by the page: nothing to release */ } };
    const m = await newMember('race'); const p = await page(); await signInViaUi(p, m); await waitFor(p, "location.pathname === '/spark'", 10000); await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Signed in')");
    // direction 2: a member whose token has expired (so the held response would carry rotated Set-Cookie headers), a check is held, the member signs out
    await forgeExpired(p); await hold(p); await sleep(10_500); await p.ev("window.dispatchEvent(new Event('focus')); true"); const id1 = await paused(p);
    await click(p, '.account-chip button', 'Sign out'); await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Not signed in')", 12000);
    await release(p, id1); await sleep(1500);
    ok(/Not signed in/.test(await chip(p)), `a stale answer restored the session: ${await chip(p)}`); ok((await getAuthCookies(p)).length === 0, 'the held refresh response brought the old session cookies back');
    await p.send('Fetch.disable');
    // direction 1: anonymous, a check is held, the member signs in
    await p.goto(`${APP}/account/sign-in`); await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Not signed in')"); await hold(p); await sleep(10_500); await p.ev("window.dispatchEvent(new Event('focus')); true"); const id2 = await paused(p);
    await typeInto(p, '#signin-email', m.email); await typeInto(p, '#signin-password', PW); await p.key('Enter'); await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Signed in')", 12000);
    await release(p, id2); await sleep(1500);
    ok(/Signed in/.test(await chip(p)) && !/Not signed in/.test(await chip(p)), `a stale answer undid the sign-in: ${await chip(p)}`); ok((await getAuthCookies(p)).length >= 1, 'the session cookie is gone'); await p.send('Fetch.disable'); p.close();
    return 'held answers released after the action: sign-out and sign-in both stand; no old cookies returned';
  });

  // ======== C: recovery ========
  await check('C1', 'recovery screen: a member and an unknown address see the IDENTICAL confirmation; mail only to the member; empty/invalid input has a clear message; keyboard and 44 px', async () => {
    const m = await newMember('rec'); await mailClear(); const p = await page(); await p.goto(`${APP}/account/sign-in`); await click(p, 'a', 'Forgot your password?'); await waitFor(p, "location.pathname === '/account/recover'");
    const off = await offenders(p); ok(off.length === 0, `44px ${JSON.stringify(off)}`); await typeInto(p, '#recover-email', 'not-an-email'); await p.key('Enter'); await waitFor(p, "document.querySelector('[role=alert]')"); ok(/Enter an email address/.test(await text(p, '[role=alert]')), 'invalid email message'); await shot(p, 'desktop-13-recover-invalid');
    await typeInto(p, '#recover-email', m.email); await p.key('Enter'); await waitFor(p, "document.body.innerText.includes('Check your email')"); const known = await text(p, 'main');
    await p.goto(`${APP}/account/recover`); await typeInto(p, '#recover-email', `ghost-${uniq()}@example.test`); await p.key('Enter'); await waitFor(p, "document.body.innerText.includes('Check your email')"); const unknown = await text(p, 'main');
    ok(known === unknown, 'the two confirmations differ'); await shot(p, 'desktop-14-recover-sent'); ok((await mailFor(m.email)).length === 1, 'member mail missing'); await sleep(800); ok(!(await mailFor(`ghost`, 1)).length, '');
    p.close(); return 'identical confirmation; one mail (member only)';
  });
  await check('C2', 'recovery rate-limit and outage states are clear and uniform', async () => {
    const p = await page(); await p.goto(`${APP}/account/recover`);
    for (let i = 0; i < 6; i++) { await typeInto(p, '#recover-email', `bomb-${uniq()}@example.test`); await p.key('Enter'); await waitFor(p, "document.body.innerText.includes('Check your email') || document.querySelector('[role=alert]')", 8000); if (await p.ev("!!document.querySelector('[role=alert]')")) break; await p.goto(`${APP}/account/recover`); }
    ok(/Please wait a moment/.test(await text(p, '[role=alert]')), 'no rate-limit state'); await shot(p, 'desktop-15-recover-rate-limited'); p.close();
    const q = await page(); await q.goto(`${APP}/account/recover`); proxyState.mode = 'down'; await typeInto(q, '#recover-email', `down-${uniq()}@example.test`); await q.key('Enter'); await waitFor(q, "document.querySelector('[role=alert]')", 12000); ok(/Temporarily unavailable/.test(await text(q, '[role=alert]')), 'no outage state'); proxyState.mode = 'pass'; q.close(); return 'rate-limited + unavailable states';
  });

  // ======== D: email-link pages ========
  const invite = async (tag) => { const email = `px2c-${tag}-${uniq()}@example.test`; await mailClear(); const r = await admin.auth.admin.inviteUserByEmail(email); if (r.error) throw new Error(r.error.message); const link = await mailLink(email); if (!link) throw new Error('no invitation mail'); return { email, link, id: r.data.user.id }; };
  await check('D1', 'invitation link, anonymous (desktop + mobile): designed page with Hack, one h1, Continue reachable by keyboard (Enter), 44 px, no overflow; Continue leads to the password form', async () => {
    for (const [name, w, h, mobile] of [['desktop', 1280, 800, false], ['mobile', 375, 812, true]]) {
      const inv = await invite(`d1${name}`); const p = await page(w, h, mobile); await p.goto(inv.link);
      ok(/Accept your invitation/.test(await text(p, 'h1')) && (await p.ev("document.querySelectorAll('h1').length")) === 1 && (await p.ev("!!document.querySelector('img[alt^=Hack]')")), 'page structure'); ok(!(await text(p)).includes('signed in on this browser'), 'switch notice for an anonymous visitor');
      const off = await offenders(p); ok(off.length === 0, `${name} 44px ${JSON.stringify(off)}`); ok(!(await overflow(p)), `${name} overflow`); await shot(p, `${name}-16-invite-ready`);
      await tabTo(p, "document.activeElement?.tagName === 'BUTTON'"); await p.key('Enter'); await waitFor(p, "location.pathname === '/auth/set-password'", 10000); ok(/Choose your password/.test(await text(p, 'h1')), 'no password form'); ok((await offenders(p)).length === 0, `${name} set-password 44px`); await shot(p, `${name}-17-set-password`); p.close();
    }
    return 'ready page + keyboard Continue + password form, both sizes';
  });
  await check('D2', 'password setup states: weak password message, then success lands on the app signed in; replaying the link shows the expired state with a way forward', async () => {
    const inv = await invite('d2'); const p = await page(); await p.goto(inv.link); await click(p, 'button', 'Continue'); await waitFor(p, "location.pathname === '/auth/set-password'");
    await typeInto(p, '#password', 'short'); await p.key('Enter'); await waitFor(p, "document.querySelector('.alert')"); ok(/at least 12 characters/.test(await text(p, '.alert')), 'weak message'); await shot(p, 'desktop-18-set-password-weak');
    await typeInto(p, '#password', PW); await p.key('Enter'); await waitFor(p, "location.pathname === '/spark'", 10000); await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Signed in')", 10000); ok(!/Choose your password/.test(await chip(p)), 'still asks for a password'); p.close();
    const q = await page(); await q.goto(inv.link); await click(q, 'button', 'Continue'); await waitFor(q, "document.body.innerText.includes('expired or has already been used')"); ok(/Go to sign in/.test(await text(q)), 'no way forward'); ok((await offenders(q)).length === 0, '44px expired'); await shot(q, 'desktop-19-link-expired'); q.close(); return 'weak -> message; success -> signed in; replay -> expired state';
  });
  await check('D3', 'ACCOUNT SWITCH is explicit: signed in as A, B\'s invitation page names the switch and offers "Sign out and continue"; nothing changes until pressed; A\'s session ends only then', async () => {
    const a = await newMember('swA'); const inv = await invite('swB'); const p = await page(); await signInViaUi(p, a); await waitFor(p, "location.pathname === '/spark'", 10000);
    const before = (await getAuthCookies(p)).map((c) => c.value).join('|'); await p.goto(inv.link); const t = await text(p); ok(/signed in on this browser/.test(t) && /Sign out and continue/.test(t) && /Stay signed in/.test(t), t.slice(0, 200)); await shot(p, 'desktop-20-invite-while-signed-in');
    ok((await getAuthCookies(p)).map((c) => c.value).join('|') === before, 'cookies changed by viewing the page'); ok((await offenders(p)).length === 0, '44px switch page');
    await click(p, 'a', 'Stay signed in'); await waitFor(p, "location.pathname === '/spark'"); await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Signed in')"); ok((await getAuthCookies(p)).map((c) => c.value).join('|') !== '' , 'A lost the session by going back');
    await p.goto(inv.link); await click(p, 'button', 'Sign out and continue'); await waitFor(p, "location.pathname === '/auth/set-password'", 10000); await p.goto(`${APP}/spark`); await waitFor(p, "document.querySelector('.account-chip')?.innerText.includes('Choose your password')", 10000); p.close(); return 'notice; no change on view; going back keeps A; confirm -> B (asked to choose a password)';
  });
  await check('D4', 'link problems render designed states: invalid, registration closed (signup link), and an outage on Continue (link not used up); all keyboard reachable and >= 44 px', async () => {
    const p = await page(); await p.goto(`${APP}/auth/callback?type=invite&token_hash=short`); ok(/isn.t valid/.test(await text(p)) && (await offenders(p)).length === 0, 'invalid'); await shot(p, 'desktop-21-link-invalid');
    await p.goto(`${APP}/auth/callback?type=signup&token_hash=${'a'.repeat(40)}`); ok(/Registration is closed/.test(await text(p)) && /Go to sign in/.test(await text(p)), 'closed'); await shot(p, 'desktop-22-registration-closed'); p.close();
    const inv = await invite('d4'); const q = await page(); await q.goto(inv.link); proxyState.mode = 'down'; await click(q, 'button', 'Continue'); await waitFor(q, "document.body.innerText.includes('temporarily unavailable')", 12000); proxyState.mode = 'pass';
    ok(/couldn.t confirm whether this completed/.test(await text(q)) && !/not been used up|Nothing was lost/.test(await text(q)), 'wording'); await shot(q, 'desktop-23-link-unavailable'); await q.goto(inv.link); await click(q, 'button', 'Continue'); await waitFor(q, "location.pathname === '/auth/set-password'", 10000); q.close(); return 'invalid / closed / unavailable (and the link still works afterwards)';
  });
  await check('D5', 'design fidelity: shared tokens and focus ring on the email-link pages and the in-app screens (computed styles)', async () => {
    const p = await page(); await p.goto(`${APP}/auth/callback?type=invite&token_hash=short`); const a = await p.ev("({ bg: getComputedStyle(document.body).backgroundColor, btn: getComputedStyle(document.querySelector('.btn, button') || document.body).minHeight, font: getComputedStyle(document.body).fontFamily.slice(0, 20) })");
    ok(a.bg === 'rgb(17, 21, 28)' && a.btn === '44px', JSON.stringify(a)); await p.goto(`${APP}/account/sign-in`); const b = await p.ev("({ bg: getComputedStyle(document.querySelector('.hx')).backgroundColor, accent: getComputedStyle(document.querySelector('.btn.primary')).backgroundColor })");
    ok(b.bg === 'rgb(17, 21, 28)' && b.accent === 'rgb(243, 107, 81)', JSON.stringify(b)); p.close(); return 'bg #11151C, accent #F36B51, 44 px controls on both';
  });
} finally { proc.kill(); app.kill(); proxy.close(); }
console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
