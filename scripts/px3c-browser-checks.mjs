#!/usr/bin/env node
// PX-3c local browser checks: the saved-work journey in a REAL headless Chrome against the real app and the real local pilot stack (Auth + PostgREST + the PX-3a
// database functions), with two members. Local only. Screenshots go to docs/ux/review-px3c/ (untracked).
//   node scripts/px2b-pilot.mjs up ; npx next build ; node --conditions=react-server scripts/px3c-browser-checks.mjs      (ONLY=regex runs a subset)
// The service key is used only here (create/delete test members); the app never receives it. Direct SQL (docker exec psql) is used only to seed list sizes and to
// count rows. Exit 0 all passed, 1 a check failed, 2 stack or app unreachable.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { launch, newPage, sleep } from './lib/cdp.mjs';

const SUPABASE = process.env.SUPABASE_BIN || 'supabase';
const DOCKER = process.env.DOCKER_BIN || '/Applications/Docker.app/Contents/Resources/bin/docker';
const DB = process.env.PX_DB_CONTAINER || 'supabase_db_hackass-px2';
const APP_PORT = 3103, PROXY_PORT = 55497; const APP = `http://localhost:${APP_PORT}`;
const OUT = process.env.SHOT_DIR ? process.env.SHOT_DIR.replace(/\/?$/, '/') : fileURLToPath(new URL('../docs/ux/review-px3c/', import.meta.url)); mkdirSync(OUT, { recursive: true });
const st = spawnSync(SUPABASE, ['status', '--workdir', 'supabase-pilot', '-o', 'json'], { encoding: 'utf8', timeout: 60_000 });
let cfg; try { cfg = JSON.parse(st.stdout.slice(st.stdout.indexOf('{'))); } catch { console.error('BLOCKED  the pilot stack is not running'); process.exit(2); }
const API = cfg.API_URL, PUB = cfg.PUBLISHABLE_KEY, SECRET = cfg.SECRET_KEY;
const admin = createClient(API, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
const sql = (text) => { const r = spawnSync(DOCKER, ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], { input: text, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`sql: ${r.stderr.slice(0, 200)}`); return r.stdout.trim(); };

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
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(APP_PORT)], { env: { ...process.env, ...SECRETS, APP_ENV: 'local', APP_ORIGIN: APP, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${PROXY_PORT}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUB, TRUSTED_CLIENT_IP_HEADER: 'x-test-client-ip', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
let appLog = ''; app.stdout.on('data', (d) => { appLog += d; }); app.stderr.on('data', (d) => { appLog += d; });
let up = false; for (let i = 0; i < 60 && !up; i++) { try { up = !!(await fetch(`${APP}/auth/session`)).status; } catch { await sleep(500); } }
if (!up) { console.error('BLOCKED  the app did not start (run `npx next build` first)'); app.kill(); proxy.close(); process.exit(2); }

// ---- helpers ------------------------------------------------------------------------------------------------------------------------------------------
const uniq = () => randomBytes(4).toString('hex'); const PW = 'correct horse battery staple';
let ipN = 80; const nextIp = () => `198.51.100.${(ipN++ % 250) + 1}`;
const members = [];
async function newMember(tag) { const email = `px3c-${tag}-${uniq()}@example.test`; const r = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true }); if (r.error) throw new Error(r.error.message); const m = { email, id: r.data.user.id }; members.push(m); return m; }
const { proc, port } = await launch(9300 + Math.floor(Math.random() * 600));
const pages = [];
async function page(w = 1280, h = 800, mobile = false, ip = nextIp(), keep = false) { const p = await newPage(port); pages.push(p); await p.viewport(w, h, mobile); await p.send('Network.enable'); await p.send('Log.enable'); if (!keep) await p.send('Network.clearBrowserCookies'); await p.send('Network.setExtraHTTPHeaders', { headers: { 'x-test-client-ip': ip } }); return p; }
const text = (p, sel = 'body') => p.ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
async function waitFor(p, expr, ms = 10000, label = expr) { const t0 = Date.now(); for (;;) { try { if (await p.ev(`!!(${expr})`)) return true; } catch { /* page navigating */ } if (Date.now() - t0 > ms) { let where = ''; try { where = await p.ev("location.pathname + ' | ' + document.body.innerText.replace(/\\s+/g, ' ').slice(0, 260)"); } catch { /* gone */ } throw new Error(`timed out waiting for: ${label} @ ${where}`); } await sleep(120); } }
const click = async (p, sel, t = '') => { trace(`click ${sel} ${t}`); await waitFor(p, `[...document.querySelectorAll(${JSON.stringify(sel)})].some((x) => x.textContent.includes(${JSON.stringify(t)}) && !x.disabled)`, 10000, `click target ${sel} "${t}"`); return p.click(sel, t); };
// ---- role + accessible-name helpers (S2): the navigation is addressed the way a person finds it, not by class names or by visible-text guesses -----------------
// "name" is the aria-label, else the visible text; only visible, enabled elements count (the sidebar, the rail and the phone bar are never all visible at once).
const FIND_ROLE = `(role, name) => { const sel = { link: 'a[href]', button: 'button', tab: '[role=tab]' }[role]; const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }; const nm = (e) => (e.getAttribute('aria-label') ?? e.innerText ?? '').trim().replace(/\\s+/g, ' '); return [...document.querySelectorAll(sel)].find((e) => vis(e) && !e.disabled && nm(e).startsWith(name)) ?? null; }`;
const hasRole = (p, role, name) => p.ev(`!!(${FIND_ROLE})(${JSON.stringify(role)}, ${JSON.stringify(name)})`);
const clickRole = async (p, role, name) => { trace(`click ${role} "${name}"`); await waitFor(p, `(${FIND_ROLE})(${JSON.stringify(role)}, ${JSON.stringify(name)})`, 10000, `${role} "${name}"`); return p.ev(`(() => { (${FIND_ROLE})(${JSON.stringify(role)}, ${JSON.stringify(name)}).click(); return true; })()`); };
/** Sign out through whatever account entry is visible at this width: the sidebar's button, or the rail/header account menu (opened first). */
const signOutUi = async (p) => { if (!(await hasRole(p, 'button', 'Sign out'))) { await p.ev("(() => { const d = [...document.querySelectorAll('details.account-menu')].find((x) => x.getBoundingClientRect().width > 0); d.open = true; return true; })()"); } return clickRole(p, 'button', 'Sign out'); };
/** To the Lab with the current draft: the journey bar's "3 · Adapt / Create" step, or (from saved-work pages) Home → "Continue your draft". */
const goLab = async (p) => { if (await hasRole(p, 'link', '3 · Adapt')) return clickRole(p, 'link', '3 · Adapt'); await clickRole(p, 'link', 'Home'); await waitFor(p, "location.pathname === '/spark'"); return clickRole(p, 'link', 'Continue your draft'); };
/** To My hacks → Results (the tab), from anywhere. */
const goMyResults = async (p) => { if (!(await p.ev("['/account/prompts', '/account/results'].includes(location.pathname)"))) { await clickRole(p, 'link', 'My hacks'); await waitFor(p, "location.pathname === '/account/prompts'"); } return clickRole(p, 'link', 'Results'); };
/** The four canonical outcomes are a radio group (Reveal); pick one the way a person does. */
const chooseOutcome = async (p, v) => { await waitFor(p, `!!document.querySelector('input[name=outcome][value=${v}]')`, 10000, `outcome ${v}`); return p.ev(`(() => { document.querySelector('input[name=outcome][value=${v}]').click(); return true; })()`); };
async function typeInto(p, sel, value) { await waitFor(p, `!!document.querySelector(${JSON.stringify(sel)})`, 10000, `element ${sel}`); await p.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select?.(); return true; })()`); await p.insertText(value); }
async function selectValue(p, sel, v) { await p.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value'); d.set.call(e, ${JSON.stringify(v)}); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); }
const trace = (m) => { if (process.env.TRACE) console.error(`  · ${m}`); };
const shot = (p, name) => { trace(`shot ${name}`); return p.shot(`${OUT}${name}.png`); };
const status = (p, sel = '#save-status') => text(p, sel);
const warns = (p) => p.ev("(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()");
const overflow = (p) => p.ev('document.documentElement.scrollWidth > innerWidth + 1');
async function offenders(p) { return p.ev(`[...document.querySelectorAll('a[href],button,input,select,textarea,[role=tab]')].filter(e => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden' && e.type !== 'hidden' && !e.classList.contains('skip') && !e.closest('p, li, h3')).map(e => { const r = e.getBoundingClientRect(); return { n: (e.id || e.textContent || e.tagName).trim().slice(0, 28), h: Math.round(r.height), w: Math.round(r.width) }; }).filter(x => x.h < 43.5 && !(x.n === 'Skip to content'))`); }
async function signIn(p, m, next = '%2Fspark') { await p.goto(`${APP}/account/sign-in?next=${next}`); await typeInto(p, '#signin-email', m.email); await typeInto(p, '#signin-password', PW); await p.key('Enter'); await waitFor(p, "document.querySelector('.account-state')?.textContent.includes('Signed in')", 12000, 'signed in'); }
/** A draft started the normal way: a demo hack adapted in the Lab (client navigation), then edited. */
async function startDraft(p, { title = 'My meal plan', prompt = 'MY DRAFT PROMPT' } = {}) {
  await p.goto(`${APP}/spark/demo/meal`); await clickRole(p, 'button', 'Make it yours'); await waitFor(p, "location.pathname === '/lab'");
  await typeInto(p, '#promptTitle', title); await typeInto(p, '#fullPrompt', prompt); await p.ev("window.__doc = 'same-document'; true");
}
/** A full page load while the draft is unsaved raises the leave-page dialog (correct); this accepts it so a check can move on. */
async function gotoAccepting(p, url) { const nav = p.goto(url); for (let i = 0; i < 12; i++) { await sleep(250); try { await p.send('Page.handleJavaScriptDialog', { accept: true }); break; } catch { /* no dialog yet */ } } await nav; }
const sameDoc = (p) => p.ev("window.__doc === 'same-document'");
const confirmDialog = async (p, label) => { await waitFor(p, "document.querySelector('dialog.confirm[open]')", 5000, 'confirm dialog'); return p.ev(`(() => { const b = [...document.querySelectorAll('dialog.confirm[open] button')].find((x) => x.textContent.includes(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`); };
const dialogText = (p) => p.ev("document.querySelector('dialog.confirm[open]')?.innerText ?? ''");
async function slowWork(p, ms) { await p.ev(`(() => { if (!window.__origFetch) window.__origFetch = window.fetch; window.fetch = (u, i) => { const f = window.__origFetch(u, i); return String(u).startsWith('/work/') ? f.then((r) => new Promise((res) => setTimeout(() => res(r), ${ms}))) : f; }; return true; })()`); }
const count = (table, id) => Number(sql(`select count(*) from app.${table} where owner_id = '${id}'`));

try {
  // ======== Lab: save ========
  await check('S1', 'Lab: Not saved → Save (explicit) → Saved with a time; the button becomes "Save changes"; the leave-page warning clears; the draft is untouched', async () => {
    const m = await newMember('s1'); const p = await page(); await signIn(p, m); await startDraft(p);
    ok((await status(p)).trim() === 'Not saved', `initial status "${await status(p)}"`); ok(await warns(p), 'leave-page warning should be on while edits are unsaved');
    ok((await text(p, '#save-prompt')) === 'Save prompt', 'button label'); await shot(p, 'lab-not-saved');
    await click(p, '#save-prompt', 'Save prompt'); await waitFor(p, "document.querySelector('#save-status')?.textContent.startsWith('Saved')", 10000, 'Saved');
    ok(/^Saved · \d/.test((await status(p)).trim()), await status(p)); ok(!(await warns(p)), 'the warning should clear once saved'); ok((await text(p, '#save-prompt')) === 'Save changes', 'button after save');
    ok(await p.ev("document.querySelector('#fullPrompt').value === 'MY DRAFT PROMPT'") && await sameDoc(p), 'draft/page changed by saving'); ok(count('saved_prompts', m.id) === 1, 'row count');
    ok((await text(p, 'body')).includes("Private to your account; not shared with other members. Please don't store passwords or other secrets in prompts."), 'privacy note'); await shot(p, 'lab-saved');
    await p.ev("window.__t = 0; true"); await sleep(1500); ok(count('saved_prompts', m.id) === 1, 'no autosave / no duplicate'); return 'Not saved → Saved · time; warning cleared; 1 row';
  });
  await check('S2', 'TYPING DURING A SAVE: the response marks only the submitted text; the status shows "Changed since last save" and the leave-page warning stays on; the next Save completes', async () => {
    const m = await newMember('s2'); const p = await page(); await signIn(p, m); await startDraft(p); await slowWork(p, 1600);
    await click(p, '#save-prompt', 'Save prompt'); await waitFor(p, "document.querySelector('#save-status')?.textContent.includes('Saving')", 4000, 'Saving…');
    ok(await p.ev("document.querySelector('#save-prompt').disabled"), 'Save is disabled while saving (one at a time)');
    await typeInto(p, '#fullPrompt', 'MY DRAFT PROMPT + typed while saving'); await waitFor(p, "document.querySelector('#save-status')?.textContent.includes('Changed since last save')", 10000, 'Changed since last save');
    ok(await warns(p), 'warning must stay on'); ok(await p.ev("document.querySelector('#fullPrompt').value === 'MY DRAFT PROMPT + typed while saving'"), 'typing was kept'); await shot(p, 'lab-changed-during-save');
    await click(p, '#save-prompt', 'Save changes'); await waitFor(p, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved again'); ok(!(await warns(p)), 'cleared after the second save');
    const detail = await p.ev("fetch('/work/prompts').then((r) => r.json()).then((j) => j.items[0].snippet)"); ok(detail.includes('typed while saving'), `saved text ${detail}`); return 'Saving → Changed since last save (warning on) → Saved';
  });
  await check('S3', 'FAILURE keeps the draft: an outage gives "Couldn\'t save — your draft is still here" with Try again; nothing is lost; retry after recovery saves once', async () => {
    const m = await newMember('s3'); const p = await page(); await signIn(p, m); await startDraft(p);
    proxyState.mode = 'down'; try { await click(p, '#save-prompt', 'Save prompt'); await waitFor(p, "document.querySelector('#save-problem')", 10000, 'problem'); } finally { /* keep down for the screenshot */ }
    ok((await status(p)).includes('Couldn’t save — your draft is still here'), await status(p)); ok((await text(p, '#save-problem')).includes('Your draft is still here'), 'message'); ok(await warns(p), 'still unsaved');
    ok(await p.ev("document.querySelector('#fullPrompt').value === 'MY DRAFT PROMPT'") && await sameDoc(p), 'draft lost'); await shot(p, 'lab-save-failed'); proxyState.mode = 'pass';
    await click(p, '#save-retry', 'Try saving again'); await waitFor(p, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved after retry'); ok(count('saved_prompts', m.id) === 1, `rows ${count('saved_prompts', m.id)}`); return 'draft intact; retry saved exactly one row';
  });
  await check('S4', 'SIGN-IN: an anonymous member sees "Sign in to save"; the sign-in link keeps the draft (client navigation); after signing in the same page saves', async () => {
    const m = await newMember('s4'); const p = await page(); await startDraft(p); ok((await text(p, '#save-anon')).includes('not signed in'), 'proactive hint');
    await click(p, '#save-prompt', 'Save prompt'); await waitFor(p, "document.querySelector('#save-problem')", 8000, 'sign-in problem'); ok((await status(p)).trim() === 'Sign in to save', await status(p)); await shot(p, 'lab-sign-in-to-save');
    await click(p, '#save-signin', 'Sign in'); await waitFor(p, "location.pathname === '/account/sign-in'"); ok(await p.ev("new URL(location.href).searchParams.get('next') === '/lab'"), 'return path');
    await typeInto(p, '#signin-email', m.email); await typeInto(p, '#signin-password', PW); await p.key('Enter'); await waitFor(p, "location.pathname === '/lab'", 12000, 'back in the Lab');
    ok(await sameDoc(p) && await p.ev("document.querySelector('#fullPrompt').value === 'MY DRAFT PROMPT'"), 'the draft did not survive sign-in');
    await click(p, '#save-prompt', 'Save prompt'); await waitFor(p, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved'); return 'link → sign in → same page, same draft → Saved';
  });
  await check('S5', 'incomplete drafts are refused locally with a plain message (no title / no prompt); nothing is sent', async () => {
    const m = await newMember('s5'); const p = await page(); await signIn(p, m); await startDraft(p, { title: 'x', prompt: 'y' });
    await typeInto(p, '#promptTitle', '   '); await p.ev("document.querySelector('#promptTitle').value = '   '; true"); await click(p, '#save-prompt', 'Save prompt'); await waitFor(p, "document.querySelector('#save-problem')", 5000, 'problem');
    ok((await text(p, '#save-problem')).includes('Give your prompt a name'), await text(p, '#save-problem')); ok(count('saved_prompts', m.id) === 0, 'sent anyway'); return 'refused locally';
  });

  // ======== Conflicts ========
  async function twoTabs(tag) {
    const m = await newMember(tag); const a = await page(); await signIn(a, m); await startDraft(a, { title: 'Conflict prompt', prompt: 'version one' });
    await click(a, '#save-prompt', 'Save prompt'); await waitFor(a, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'a saved');
    const b = await page(1280, 800, false, nextIp(), true); await b.goto(`${APP}/account/prompts`); await click(b, 'a', 'Conflict prompt'); await click(b, '#continue-editing', 'Continue editing'); await waitFor(b, "location.pathname === '/lab'");
    await typeInto(b, '#fullPrompt', 'version two from the other tab'); await click(b, '#save-prompt', 'Save changes'); await waitFor(b, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'b saved');
    await typeInto(a, '#fullPrompt', 'my own edit in tab one'); await click(a, '#save-prompt', 'Save changes'); await waitFor(a, "document.querySelector('#conflict-load')", 10000, 'conflict panel');
    return { m, a, b };
  }
  await check('C1', 'CONFLICT: a save that meets a newer saved version shows "Saved elsewhere — choose" with both versions and three choices; nothing is overwritten and the draft is intact', async () => {
    const { m, a } = await twoTabs('c1'); ok((await status(a)).trim() === 'Saved elsewhere — choose', await status(a)); const t = await text(a, '.conflict-box');
    ok(t.includes('version two from the other tab') && t.includes('my own edit in tab one'), 'both versions shown'); for (const l of ['Load the saved version', 'Save mine as a copy', 'Overwrite the saved version', 'Keep editing']) ok(t.includes(l), `choice ${l}`);
    ok(await p0(a), 'draft intact'); ok(await warns(a), 'still unsaved'); const saved = sql(`select full_prompt from app.saved_prompts where owner_id = '${m.id}'`); ok(saved === 'version two from the other tab', `the saved prompt was overwritten: ${saved}`); await shot(a, 'lab-conflict'); return 'both versions shown; saved copy untouched';
    async function p0(pp) { return pp.ev("document.querySelector('#fullPrompt').value === 'my own edit in tab one'"); }
  });
  await check('C2', 'conflict → "Save mine as a copy": a second prompt is created, the draft is now linked to the copy, the other tab\'s version is untouched', async () => {
    const { m, a } = await twoTabs('c2'); await click(a, '#conflict-copy', 'Save mine as a copy'); await waitFor(a, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved copy');
    ok(count('saved_prompts', m.id) === 2, `rows ${count('saved_prompts', m.id)}`); ok(sql(`select count(*) from app.saved_prompts where owner_id = '${m.id}' and full_prompt = 'version two from the other tab'`) === '1', 'other version kept'); ok(await a.ev("document.querySelector('#fullPrompt').value === 'my own edit in tab one'"), 'draft'); return '2 prompts; both versions kept';
  });
  await check('C3', 'conflict → "Load the saved version": needs confirmation (Cancel is the default); then the draft becomes the saved copy and the status is Saved', async () => {
    const { a } = await twoTabs('c3'); await click(a, '#conflict-load', 'Load the saved version'); await waitFor(a, "document.querySelector('dialog.confirm[open]')", 5000, 'confirm');
    ok((await dialogText(a)).includes('Copy anything you want to keep first'), await dialogText(a)); ok(await a.ev("document.activeElement?.textContent === 'Keep mine'"), 'Cancel must be focused'); await shot(a, 'lab-conflict-confirm-load');
    await confirmDialog(a, 'Keep mine'); await sleep(300); ok(await a.ev("document.querySelector('#fullPrompt').value === 'my own edit in tab one'"), 'cancel changed the draft');
    await click(a, '#conflict-load', 'Load the saved version'); await confirmDialog(a, 'Load the saved version'); await waitFor(a, "document.querySelector('#fullPrompt').value === 'version two from the other tab'", 5000, 'loaded');
    ok(/^Saved/.test(await status(a)), await status(a)); ok(!(await warns(a)), 'clean'); return 'cancel keeps mine; confirm loads theirs';
  });
  await check('C4', 'conflict → "Overwrite the saved version": confirmed explicitly (danger wording); then my text is saved on top of the newer version', async () => {
    const { m, a } = await twoTabs('c4'); await click(a, '#conflict-overwrite', 'Overwrite the saved version'); await waitFor(a, "document.querySelector('dialog.confirm[open]')", 5000, 'confirm');
    ok((await dialogText(a)).includes('can’t be undone'), await dialogText(a)); ok(sql(`select full_prompt from app.saved_prompts where owner_id = '${m.id}'`) === 'version two from the other tab', 'overwritten before confirming');
    await confirmDialog(a, 'Overwrite the saved version'); await waitFor(a, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved');
    ok(sql(`select full_prompt from app.saved_prompts where owner_id = '${m.id}'`) === 'my own edit in tab one', 'not overwritten'); ok(sql(`select version from app.saved_prompts where owner_id = '${m.id}'`) === '3', 'version'); return 'saved on top of v2 → v3 after confirmation';
  });

  // ======== Reveal: results ========
  await check('R1', 'Reveal, prompt NOT saved: "Save prompt and result" saves both in one step; status "Result saved"; the result appears in My results with the prompt as tried; the prompt in My prompts', async () => {
    const m = await newMember('r1'); const p = await page(); await signIn(p, m); await startDraft(p, { title: 'Reveal prompt', prompt: 'THE PROMPT I TRIED' }); await click(p, 'button', 'Reflect'); await waitFor(p, "location.pathname === '/reveal'");
    ok((await text(p, '#result-save')) === 'Save prompt and result', await text(p, '#result-save')); await click(p, '#result-save', 'Save prompt and result'); await waitFor(p, "document.querySelector('#result-problem')", 5000, 'outcome needed');
    ok((await text(p, '#result-problem')).includes('Choose whether it worked'), 'outcome message'); await chooseOutcome(p, 'partial'); await typeInto(p, '#reflection', 'It half worked: needed a budget.'); await typeInto(p, '#nextVersion', 'Add a budget');
    await shot(p, 'reveal-before-save'); await click(p, '#result-save', 'Save prompt and result'); await waitFor(p, "/^Result saved/.test(document.querySelector('#result-status')?.textContent)", 10000, 'Result saved');
    ok(count('saved_prompts', m.id) === 1 && count('saved_reflections', m.id) === 1, 'rows'); ok(!(await warns(p)), 'clean'); await shot(p, 'reveal-saved');
    await clickRole(p, 'link', 'My results'); await waitFor(p, "location.pathname === '/account/results' && document.querySelector('.work-row')", 10000, 'results list'); const l = await text(p, '.work-list'); ok(l.includes('Reveal prompt') && l.includes('Partly'), l); await shot(p, 'my-results');
    await click(p, '.work-row a', 'Reveal prompt'); await waitFor(p, "location.pathname.startsWith('/account/results/')"); await waitFor(p, "document.querySelector('.sample')", 8000, 'detail'); const d = await text(p, 'main'); ok(d.includes('THE PROMPT I TRIED') && d.includes('It half worked') && d.includes('Add a budget'), d.slice(0, 300)); await shot(p, 'my-result-detail'); return 'both saved atomically; list + detail show the snapshot';
  });
  await check('R2', 'Reveal, prompt saved and unchanged: "Save this result" attaches to it; later edits offer "Update saved result" and "Save as a new result"; changing the prompt later does not change the saved result', async () => {
    const m = await newMember('r2'); const p = await page(); await signIn(p, m); await startDraft(p, { title: 'R2 prompt', prompt: 'ORIGINAL TEXT' }); await click(p, '#save-prompt', 'Save prompt'); await waitFor(p, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved');
    await click(p, 'button', 'Reflect'); await waitFor(p, "location.pathname === '/reveal'"); ok((await text(p, '#result-save')) === 'Save this result', await text(p, '#result-save'));
    await chooseOutcome(p, 'yes'); await typeInto(p, '#reflection', 'first words'); await click(p, '#result-save', 'Save this result'); await waitFor(p, "/^Result saved/.test(document.querySelector('#result-status')?.textContent)", 10000, 'result saved'); ok(count('saved_reflections', m.id) === 1, 'one result');
    await typeInto(p, '#reflection', 'first words, now improved'); await waitFor(p, "document.querySelector('#result-status')?.textContent.includes('Changed since last save')", 5000, 'changed'); ok(await warns(p), 'warning on');
    await click(p, '#result-update', 'Update saved result'); await waitFor(p, "/^Result saved/.test(document.querySelector('#result-status')?.textContent)", 10000, 'updated'); ok(count('saved_reflections', m.id) === 1, 'update must not add a result');
    await click(p, '#result-new', 'Save as a new result'); await waitFor(p, "document.querySelector('#result-update')?.disabled !== undefined", 5000); await sleep(800); ok(count('saved_reflections', m.id) === 2, `rows ${count('saved_reflections', m.id)}`);
    await goLab(p); await waitFor(p, "location.pathname === '/lab'"); await typeInto(p, '#fullPrompt', 'CHANGED AFTER'); await click(p, '#save-prompt', 'Save changes'); await waitFor(p, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'prompt v2');
    ok(sql(`select count(*) from app.saved_reflections where owner_id = '${m.id}' and attempted_prompt = 'ORIGINAL TEXT'`) === '2', 'the results must keep the prompt that was tried'); return 'attach → update (still 1) → new (2); snapshots unchanged after the prompt changed';
  });
  await check('R3', 'Reveal: a prompt changed in another tab → the result is NOT saved against the older version; the conflict choices appear', async () => {
    const m = await newMember('r3'); const a = await page(); await signIn(a, m); await startDraft(a, { title: 'R3 prompt', prompt: 'tried text' }); await click(a, '#save-prompt', 'Save prompt'); await waitFor(a, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved');
    const b = await page(1280, 800, false, nextIp(), true); await b.goto(`${APP}/account/prompts`); await click(b, 'a', 'R3 prompt'); await click(b, '#continue-editing', 'Continue editing'); await waitFor(b, "location.pathname === '/lab'"); await typeInto(b, '#fullPrompt', 'changed in tab b'); await click(b, '#save-prompt', 'Save changes'); await waitFor(b, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'b saved');
    await click(a, 'button', 'Reflect'); await waitFor(a, "location.pathname === '/reveal'"); await chooseOutcome(a, 'yes'); await click(a, '#result-save', 'Save this result'); await waitFor(a, "document.querySelector('#conflict-load')", 10000, 'conflict');
    ok(count('saved_reflections', m.id) === 0, 'a result was stored against a stale prompt version'); ok((await text(a, '#result-status')).includes('Saved elsewhere'), await text(a, '#result-status')); await shot(a, 'reveal-conflict'); return 'no result stored; conflict shown';
  });

  // ======== My prompts / My results / delete / export ========
  await check('M1', 'My prompts: loading → list (newest first) with Load more; Open → detail; Continue editing loads the Lab (confirmation if the current draft has unsaved changes); the saved link and "Saved" status come back', async () => {
    const m = await newMember('m1'); const p = await page(); await signIn(p, m); sql(`begin; set local role hackass_owner; insert into app.saved_prompts (owner_id, request_id, request_hash, request_receipt, title, goal, context, output_format, full_prompt, starting_prompt, origin_kind, updated_at) select '${m.id}', gen_random_uuid(), repeat('a', 64), '{}', 'Seed prompt ' || lpad(i::text, 2, '0'), '', '', 'Concise summary', 'seed text ' || i, '', 'scratch', now() - (i || ' minutes')::interval from generate_series(1, 30) i; commit;`);
    await p.goto(`${APP}/account/prompts`); await waitFor(p, "document.querySelector('.work-row')", 10000, 'rows'); ok((await p.ev("document.querySelectorAll('.work-row').length")) === 25, 'first page 25'); ok((await text(p, '.work-row h3')).includes('Seed prompt 01'), 'newest first'); await shot(p, 'my-prompts-list');
    await click(p, '#load-more', 'Load more'); await waitFor(p, "document.querySelectorAll('.work-row').length === 30", 10000, '30 rows'); ok(!(await p.ev("!!document.querySelector('#load-more')")), 'no more button');
    await click(p, '.work-row a', 'Seed prompt 03'); await waitFor(p, "location.pathname.startsWith('/account/prompts/')"); await waitFor(p, "document.querySelector('#continue-editing')", 8000, 'detail'); await shot(p, 'my-prompt-detail');
    await click(p, '#continue-editing', 'Continue editing'); await waitFor(p, "location.pathname === '/lab'"); ok(await p.ev("document.querySelector('#fullPrompt').value === 'seed text 3'"), 'loaded'); ok(/^Saved/.test(await status(p)), await status(p)); ok(!(await warns(p)), 'clean');
    await typeInto(p, '#fullPrompt', 'unsaved edit'); await clickRole(p, 'link', 'My hacks'); await waitFor(p, "location.pathname === '/account/prompts'"); await click(p, '.work-row a', 'Seed prompt 05'); await waitFor(p, "document.querySelector('#continue-editing')"); await click(p, '#continue-editing', 'Continue editing');
    await waitFor(p, "document.querySelector('dialog.confirm[open]')", 5000, 'confirm'); ok((await dialogText(p)).includes('unsaved work'), await dialogText(p)); await confirmDialog(p, 'Keep my draft'); await sleep(300); ok((await p.ev('location.pathname')).startsWith('/account/prompts/'), 'cancel must stay');
    await click(p, '#continue-editing', 'Continue editing'); await confirmDialog(p, 'Open the saved prompt'); await waitFor(p, "location.pathname === '/lab'"); ok(await p.ev("document.querySelector('#fullPrompt').value === 'seed text 5'"), 'second load'); return '25 + Load more → 30; reopen; confirm only when unsaved';
  });
  await check('M2', 'My prompts: the draft is untouched by browsing; empty state for a new member; a stranger\'s id shows "Not found" (no leak); B sees none of A\'s prompts', async () => {
    const a = await newMember('m2a'), b = await newMember('m2b'); const pa = await page(); await signIn(pa, a); await startDraft(pa, { title: 'A private', prompt: 'A text' }); await click(pa, '#save-prompt', 'Save prompt'); await waitFor(pa, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved');
    const id = await pa.ev("fetch('/work/prompts').then((r) => r.json()).then((j) => j.items[0].id)");
    await clickRole(pa, 'link', 'My hacks'); await waitFor(pa, "location.pathname === '/account/prompts'"); await goLab(pa); await waitFor(pa, "location.pathname === '/lab'"); ok(await sameDoc(pa) && await pa.ev("document.querySelector('#fullPrompt').value === 'A text'"), 'browsing changed the draft');
    const pb = await page(); await signIn(pb, b); await pb.goto(`${APP}/account/prompts`); await waitFor(pb, "document.querySelector('.state-box')", 10000, 'empty'); ok((await text(pb, 'main')).includes('No saved prompts yet'), await text(pb, 'main')); await shot(pb, 'my-prompts-empty');
    await pb.goto(`${APP}/account/prompts/${id}`); await waitFor(pb, "document.querySelector('.state-box')", 10000, 'not found'); const t = await text(pb, 'main'); ok(t.includes('Not found') && !t.includes('A private') && !t.includes('A text'), t.slice(0, 200)); await shot(pb, 'my-prompt-not-found'); return 'empty state; foreign id = Not found with no content';
  });
  await check('M3', 'DELETE a prompt: the confirmation states the cascade ("also permanently deletes its N saved results"), Cancel keeps it, confirm deletes the prompt AND its results, then the list shows the empty state; a linked draft stays and becomes unsaved', async () => {
    const m = await newMember('m3'); const p = await page(); await signIn(p, m); await startDraft(p, { title: 'To delete', prompt: 'delete me' }); await click(p, 'button', 'Reflect'); await waitFor(p, "location.pathname === '/reveal'"); await chooseOutcome(p, 'no'); await typeInto(p, '#reflection', 'it failed'); await click(p, '#result-save', 'Save prompt and result'); await waitFor(p, "/^Result saved/.test(document.querySelector('#result-status')?.textContent)", 10000, 'saved');
    await clickRole(p, 'link', 'My hacks'); await waitFor(p, "location.pathname === '/account/prompts'"); await click(p, '.work-row a', 'To delete'); await waitFor(p, "document.querySelector('#delete-prompt')"); await click(p, '#delete-prompt', 'Delete');
    await waitFor(p, "document.querySelector('dialog.confirm[open]')", 5000, 'dialog'); const t = await dialogText(p); ok(t.includes('also permanently deletes its 1 saved result. This can’t be undone.'), t); ok(await p.ev("document.activeElement?.textContent === 'Keep it'"), 'Cancel must be the default'); await shot(p, 'delete-confirm');
    await confirmDialog(p, 'Keep it'); await sleep(300); ok(count('saved_prompts', m.id) === 1, 'cancel deleted something');
    await click(p, '#delete-prompt', 'Delete'); await confirmDialog(p, 'Delete permanently'); await waitFor(p, "location.pathname === '/account/prompts' && document.querySelector('.state-box')", 10000, 'list empty'); ok(count('saved_prompts', m.id) === 0 && count('saved_reflections', m.id) === 0, 'cascade'); ok((await text(p, 'main')).includes('No saved prompts yet'), 'empty state');
    await p.ev("(() => { history.back(); return true; })()"); await goLab(p); await waitFor(p, "location.pathname === '/lab'"); ok(await p.ev("document.querySelector('#fullPrompt').value === 'delete me'") && (await status(p)).trim() === 'Not saved', `after delete: ${await status(p)}`); return 'cascade stated; cancel safe; prompt + result gone; draft kept as Not saved';
  });
  await check('M4', 'My results: filter by outcome, empty-filter state, edit my words (conflict choice when changed elsewhere), delete a result with confirmation', async () => {
    const m = await newMember('m4'); const p = await page(); await signIn(p, m); await startDraft(p, { title: 'M4 prompt', prompt: 'm4 text' }); await click(p, '#save-prompt', 'Save prompt'); await waitFor(p, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved');
    await click(p, 'button', 'Reflect'); await waitFor(p, "location.pathname === '/reveal'"); await chooseOutcome(p, 'yes'); await typeInto(p, '#reflection', 'worked well'); await click(p, '#result-save', 'Save this result'); await waitFor(p, "/^Result saved/.test(document.querySelector('#result-status')?.textContent)", 10000, 'r1');
    await chooseOutcome(p, 'no'); await typeInto(p, '#reflection', 'second try failed'); await click(p, '#result-new', 'Save as a new result'); await sleep(1200); ok(count('saved_reflections', m.id) === 2, 'two results');
    await p.goto(`${APP}/account/results`); await waitFor(p, "document.querySelectorAll('.work-row').length === 2", 10000, 'two rows'); await selectValue(p, '#outcome-filter', 'yes'); await waitFor(p, "document.querySelectorAll('.work-row').length === 1", 8000, 'filtered'); ok((await text(p, '.work-list')).includes('worked well'), 'filter result');
    await selectValue(p, '#outcome-filter', 'partial'); await waitFor(p, "document.querySelector('.state-box')", 8000, 'empty filter'); ok((await text(p, 'main')).includes('No results with that outcome'), 'filter empty state'); await selectValue(p, '#outcome-filter', 'yes');
    await waitFor(p, "document.querySelector('.work-row a')", 8000); await click(p, '.work-row a', 'M4 prompt'); await waitFor(p, "document.querySelector('#edit-words')", 8000, 'detail'); await click(p, '#edit-words', 'Edit my words'); await typeInto(p, '#edit-reflection', 'worked well, edited here');
    const rid = sql(`select id from app.saved_reflections where owner_id = '${m.id}' and outcome = 'yes'`); sql(`begin; set local role hackass_owner; update app.saved_reflections set reflection = 'changed from another place', version = version + 1 where id = '${rid}'; commit;`);
    await click(p, '#save-words', 'Save changes'); await waitFor(p, "document.querySelector('#result-conflict')", 10000, 'result conflict'); ok((await text(p, '#result-conflict')).includes('changed from another place'), 'server version shown'); await shot(p, 'result-conflict');
    await click(p, '#rc-overwrite', 'Overwrite'); await confirmDialog(p, 'Overwrite'); await waitFor(p, "!document.querySelector('#edit-reflection') && document.body.innerText.includes('worked well, edited here')", 10000, 'overwritten'); ok(sql(`select reflection from app.saved_reflections where id = '${rid}'`) === 'worked well, edited here', 'db');
    await click(p, '#delete-result', 'Delete'); ok((await dialogText(p).catch(() => '')) !== undefined, ''); await waitFor(p, "document.querySelector('dialog.confirm[open]')", 5000, 'dialog'); await confirmDialog(p, 'Delete permanently'); await waitFor(p, "location.pathname === '/account/results'", 10000, 'list'); ok(count('saved_reflections', m.id) === 1 && count('saved_prompts', m.id) === 1, 'only the result is deleted'); return 'filter, empty filter, edit with conflict → overwrite, delete';
  });

  // ======== PX-3c correction pass ========
  await check('F1', 'STALE LIST: a held "Load more" answer from the old filter never enters the new filter\'s list (no old rows, no old cursor); the new view pages normally', async () => {
    const m = await newMember('f1'); const p = await page(); await signIn(p, m);
    sql(`begin; set local role hackass_owner; do $$ declare pid uuid; k int; begin for k in 1..2 loop insert into app.saved_prompts (owner_id, request_id, request_hash, request_receipt, title, goal, context, output_format, full_prompt, starting_prompt, origin_kind) values ('${m.id}', gen_random_uuid(), repeat('a', 64), '{}', 'F1 prompt ' || k, '', '', 'Concise summary', 'x', '', 'scratch') returning id into pid;
      insert into app.saved_reflections (owner_id, prompt_id, request_id, request_hash, request_receipt, outcome, reflection, attempted_prompt, prompt_title, origin_kind, prompt_version, created_at) select '${m.id}', pid, gen_random_uuid(), repeat('a', 64), '{}', case when i % 2 = 0 then 'yes' else 'no' end, 'row ' || k || '-' || i, 'x', 'F1 prompt ' || k, 'scratch', 1, now() - ((k * 100 + i) || ' minutes')::interval from generate_series(1, 30) i; end loop; end $$; commit;`);
    await p.goto(`${APP}/account/results`); await waitFor(p, "document.querySelectorAll('.work-row').length === 25", 10000, 'first page'); ok(await p.ev("!!document.querySelector('#load-more')"), 'more available');
    await p.ev(`(() => { window.__held = []; window.__origFetch = window.fetch; window.fetch = (u, i) => (String(u).includes('after_id') ? new Promise((res, rej) => { window.__held.push(() => window.__origFetch(u, i).then(res, rej)); }) : window.__origFetch(u, i)); return true; })()`);
    await click(p, '#load-more', 'Load more'); await waitFor(p, "window.__held.length === 1", 5000, 'request held'); ok(await p.ev("document.querySelector('#load-more')?.textContent.includes('Loading')"), 'loading');
    await selectValue(p, '#outcome-filter', 'yes'); await waitFor(p, "document.querySelectorAll('.work-row').length === 25 && [...document.querySelectorAll('.outcome-badge')].every((b) => b.classList.contains('yes'))", 10000, 'yes view');
    await p.ev("window.__held.forEach((f) => f()); true"); await sleep(1500);
    ok(await p.ev("document.querySelectorAll('.work-row').length === 25 && [...document.querySelectorAll('.outcome-badge')].every((b) => b.classList.contains('yes'))"), `the old answer changed the new list: ${await p.ev("[...document.querySelectorAll('.outcome-badge')].map((b) => b.textContent[0]).join('')")}`);
    ok(await p.ev("!!document.querySelector('#load-more')") && !(await p.ev("document.querySelector('#load-more').disabled")), 'the new view\'s own cursor is intact'); await p.ev("window.fetch = window.__origFetch; true");
    await click(p, '#load-more', 'Load more'); await waitFor(p, "document.querySelectorAll('.work-row').length === 30", 10000, '30 yes rows'); ok(await p.ev("[...document.querySelectorAll('.outcome-badge')].every((b) => b.classList.contains('yes'))"), 'only yes rows'); return 'held old-filter answer dropped; new view pages to 30 yes rows';
  });
  await check('F2', 'ACCOUNT CHANGE: sign-out clears lists, details and a conflict copy at once (private text never lingers); signing in as another member in the same page shows only that member\'s work', async () => {
    const a = await newMember('f2a'), b = await newMember('f2b'); const p = await page(); await signIn(p, a); await startDraft(p, { title: 'A PRIVATE TITLE', prompt: 'A private text' });
    await click(p, '#save-prompt', 'Save prompt'); await waitFor(p, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved'); const id = await p.ev("fetch('/work/prompts').then((r) => r.json()).then((j) => j.items[0].id)");
    // a conflict copy of A's private saved text is on screen in the Lab
    sql(`begin; set local role hackass_owner; update app.saved_prompts set full_prompt = 'A PRIVATE SERVER COPY', version = version + 1 where id = '${id}'; commit;`); await typeInto(p, '#fullPrompt', 'A edit'); await click(p, '#save-prompt', 'Save changes'); await waitFor(p, "document.querySelector('.conflict-box')", 10000, 'conflict');
    ok((await text(p, '.conflict-box')).includes('A PRIVATE SERVER COPY'), 'conflict copy shown'); await clickRole(p, 'link', 'My hacks'); await waitFor(p, "location.pathname === '/account/prompts' && document.querySelector('.work-row')", 10000, 'list'); ok((await text(p, 'main')).includes('A PRIVATE TITLE'), 'list');
    await signOutUi(p); await waitFor(p, "document.querySelector('.account-state')?.textContent.includes('Not signed in')", 8000, 'sign-out completed');   // from the moment the sign-out takes effect, nothing private may be on screen
    const seen = []; for (let i = 0; i < 12; i++) { seen.push(await text(p, 'body')); await sleep(150); }
    ok(!seen.some((t) => t.includes('A PRIVATE TITLE') || t.includes('A PRIVATE SERVER COPY')), 'private text stayed visible after sign-out'); await waitFor(p, "document.querySelector('#work-signin')", 8000, 'sign-in state'); await shot(p, 'my-prompts-after-sign-out');
    await goLab(p); await waitFor(p, "location.pathname === '/lab'"); ok(!(await p.ev("!!document.querySelector('.conflict-box')")) && (await status(p)).trim() === 'Not saved', `Lab after sign-out: ${await status(p)}`); ok(await p.ev("document.querySelector('#fullPrompt').value === 'A edit'"), 'the draft text stays'); ok(await warns(p), 'and is unsaved');
    await clickRole(p, 'link', 'Sign in'); await waitFor(p, "location.pathname === '/account/sign-in'"); await typeInto(p, '#signin-email', b.email); await typeInto(p, '#signin-password', PW); await p.key('Enter'); await waitFor(p, "location.pathname === '/lab'", 12000, 'back');
    await clickRole(p, 'link', 'My hacks'); await waitFor(p, "document.querySelector('.state-box')", 10000, 'B empty'); const t = await text(p, 'main'); ok(t.includes('No saved prompts yet') && !t.includes('A PRIVATE TITLE'), t.slice(0, 160));
    await gotoAccepting(p, `${APP}/account/prompts/${id}`); await waitFor(p, "document.querySelector('.state-box')", 10000); ok(!(await text(p, 'main')).includes('A PRIVATE'), 'detail leaked'); return 'list/detail/conflict cleared at sign-out; B sees only B\'s';
  });
  await check('F3', 'RESET DURING A SAVE: the late acknowledgment for text A does not mark the reset draft saved; it stays "Not saved" with the starter text and no leave warning', async () => {
    const m = await newMember('f3'); const p = await page(); await signIn(p, m); await startDraft(p, { title: 'F3 prompt', prompt: 'TEXT A' }); const starter = await p.ev("window.__starter = 'unset'; true"); void starter;
    await slowWork(p, 2200); await click(p, '#save-prompt', 'Save prompt'); await waitFor(p, "document.querySelector('#save-status')?.textContent.includes('Saving')", 4000, 'saving');
    await click(p, 'button', 'Reset draft'); await confirmDialog(p, 'Reset my draft'); await waitFor(p, "document.querySelector('#fullPrompt').value !== 'TEXT A'", 5000, 'reset'); const reset = await p.ev("document.querySelector('#fullPrompt').value");
    await sleep(3200); const st = (await status(p)).trim(); ok(st === 'Not saved', `status after the late answer: "${st}"`); ok(await p.ev(`document.querySelector('#fullPrompt').value === ${JSON.stringify(reset)}`), 'the reset text changed'); ok(!(await warns(p)), 'a reset starter draft is not dirty'); ok(count('saved_prompts', m.id) === 1, 'the abandoned save still reached the server (visible in My prompts)');
    await shot(p, 'lab-reset-during-save'); return `Not saved after the late answer; draft = starter`;
  });
  await check('F4', 'RECONCILIATION: a lost create response + a newer saved version → the retry is reconciled into a conflict; "Overwrite" UPDATES that prompt (no second create, one row, v3); "Save mine as a copy" uses a fresh intent and ends saved', async () => {
    async function scenario(tag, choice) {
      const m = await newMember(tag); const a = await page(); await signIn(a, m); await startDraft(a, { title: 'F4 prompt', prompt: 'TEXT A' });
      await a.ev(`(() => { window.__origFetch = window.fetch; window.__lost = 0; window.fetch = (u, i) => (String(u) === '/work/prompts' && i?.method === 'POST' && window.__lost === 0 ? window.__origFetch(u, i).then(() => { window.__lost = 1; throw new TypeError('lost'); }) : window.__origFetch(u, i)); return true; })()`);
      await click(a, '#save-prompt', 'Save prompt'); await waitFor(a, "document.querySelector('#save-problem')", 10000, 'failure (response lost)'); ok(count('saved_prompts', m.id) === 1, 'the create reached the server');
      const b = await page(1280, 800, false, nextIp(), true); await b.goto(`${APP}/account/prompts`); await click(b, 'a', 'F4 prompt'); await click(b, '#continue-editing', 'Continue editing'); await waitFor(b, "location.pathname === '/lab'"); await typeInto(b, '#fullPrompt', 'TEXT B from the other tab'); await click(b, '#save-prompt', 'Save changes'); await waitFor(b, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'b saved v2');
      await click(a, '#save-retry', 'Try saving again'); await waitFor(a, "document.querySelector('.conflict-box')", 10000, 'reconciled conflict'); ok((await text(a, '.conflict-box')).includes('TEXT B from the other tab'), 'saved version shown'); ok(count('saved_prompts', m.id) === 1 && sql(`select version from app.saved_prompts where owner_id = '${m.id}'`) === '2', 'the retry must not have changed the server');
      if (choice === 'overwrite') { await click(a, '#conflict-overwrite', 'Overwrite'); await confirmDialog(a, 'Overwrite the saved version'); await waitFor(a, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved after overwrite'); ok(count('saved_prompts', m.id) === 1, `overwrite created another prompt (${count('saved_prompts', m.id)} rows)`); ok(sql(`select version || '|' || full_prompt from app.saved_prompts where owner_id = '${m.id}'`) === '3|TEXT A', 'overwrite result'); }
      else { await click(a, '#conflict-copy', 'Save mine as a copy'); await waitFor(a, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved copy'); ok(count('saved_prompts', m.id) === 2, `copy rows ${count('saved_prompts', m.id)}`); ok(!(await a.ev("!!document.querySelector('.conflict-box')")), 'no conflict loop'); ok(sql(`select count(*) from app.saved_prompts where owner_id = '${m.id}' and full_prompt = 'TEXT B from the other tab'`) === '1', 'the other version is kept'); }
      return a;
    }
    const a = await scenario('f4a', 'overwrite'); await shot(a, 'lab-after-overwrite'); await scenario('f4b', 'copy'); return 'overwrite → v3 on the same prompt; copy → fresh intent, 2 prompts, no loop';
  });
  await check('F5', 'RESULT EDITOR: typing during a save keeps the form open and unsaved; leaving with unsaved edits asks first (Stay is the default); "Load the saved version" over local edits needs confirmation', async () => {
    const m = await newMember('f5'); const p = await page(); await signIn(p, m); await startDraft(p, { title: 'F5 prompt', prompt: 'f5 text' }); await click(p, 'button', 'Reflect'); await waitFor(p, "location.pathname === '/reveal'"); await chooseOutcome(p, 'yes'); await typeInto(p, '#reflection', 'first words');
    await click(p, '#result-save', 'Save prompt and result'); await waitFor(p, "/^Result saved/.test(document.querySelector('#result-status')?.textContent)", 10000, 'saved'); await p.goto(`${APP}/account/results`); await click(p, '.work-row a', 'F5 prompt'); await waitFor(p, "document.querySelector('#edit-words')", 10000, 'detail');
    await click(p, '#edit-words', 'Edit my words'); await typeInto(p, '#edit-reflection', 'submitted words'); await slowWork(p, 1800); await click(p, '#save-words', 'Save changes'); await waitFor(p, "document.querySelector('#edit-status')?.textContent.includes('Saving')", 4000, 'saving');
    await typeInto(p, '#edit-reflection', 'submitted words + typed during the save'); await sleep(2600);
    ok(await p.ev("!!document.querySelector('#edit-reflection')"), 'the form closed although there was newer typing'); ok((await text(p, '#edit-status')).includes('Changed since last save'), await text(p, '#edit-status')); ok(await p.ev("document.querySelector('#edit-reflection').value === 'submitted words + typed during the save'"), 'newer typing lost');
    ok(sql(`select reflection from app.saved_reflections where owner_id = '${m.id}'`) === 'submitted words', 'the saved copy is exactly what was submitted'); ok(await warns(p), 'the leave-page warning must be on'); await shot(p, 'result-edit-changed-during-save');
    await clickRole(p, 'link', 'My hacks'); await waitFor(p, "document.querySelector('dialog.confirm[open]')", 5000, 'leave dialog'); ok((await dialogText(p)).includes('not saved'), await dialogText(p)); ok(await p.ev("document.activeElement?.textContent === 'Stay and keep editing'"), 'Stay must be the default'); await shot(p, 'result-edit-leave-confirm');
    await confirmDialog(p, 'Stay and keep editing'); await sleep(300); ok((await p.ev('location.pathname')).startsWith('/account/results/'), 'Stay must stay'); ok(await p.ev("document.querySelector('#edit-reflection').value === 'submitted words + typed during the save'"), 'edits kept');
    const rid = sql(`select id from app.saved_reflections where owner_id = '${m.id}'`); sql(`begin; set local role hackass_owner; update app.saved_reflections set reflection = 'changed from another place', version = version + 1 where id = '${rid}'; commit;`);
    await slowWork(p, 0); await click(p, '#save-words', 'Save changes'); await waitFor(p, "document.querySelector('#result-conflict')", 10000, 'conflict'); await click(p, '#rc-load', 'Load the saved version'); await waitFor(p, "document.querySelector('dialog.confirm[open]')", 5000, 'load confirm');
    ok((await dialogText(p)).includes('replaced by the saved version'), await dialogText(p)); await confirmDialog(p, 'Keep mine'); await sleep(300); ok(await p.ev("document.querySelector('#edit-reflection').value === 'submitted words + typed during the save'"), 'cancel must keep my words');
    await click(p, '#rc-load', 'Load the saved version'); await confirmDialog(p, 'Load the saved version'); await waitFor(p, "document.querySelector('#edit-reflection')?.value === 'changed from another place'", 5000, 'loaded'); ok(!(await warns(p)), 'clean after loading the saved version');
    await clickRole(p, 'link', 'My hacks'); await waitFor(p, "location.pathname === '/account/prompts'", 8000, 'no dialog when clean'); return 'newer typing kept and guarded; Stay default; load needs confirmation';
  });

  // ======== PX-3c second correction pass ========
  await check('B1', 'BROWSER BACK → FORWARD: unsaved result edits are restored from shared in-memory state (same page, no storage); sign-out clears them; an explicit "Leave and discard" removes them', async () => {
    const m = await newMember('b1'); const p = await page(); await signIn(p, m); await startDraft(p, { title: 'B1 prompt', prompt: 'b1 text' }); await click(p, 'button', 'Reflect'); await waitFor(p, "location.pathname === '/reveal'");
    await chooseOutcome(p, 'yes'); await typeInto(p, '#reflection', 'saved words'); await click(p, '#result-save', 'Save prompt and result'); await waitFor(p, "/^Result saved/.test(document.querySelector('#result-status')?.textContent)", 10000, 'saved');
    await goMyResults(p); await waitFor(p, "location.pathname === '/account/results' && document.querySelector('.work-row')", 10000, 'list'); await click(p, '.work-row a', 'B1 prompt'); await waitFor(p, "document.querySelector('#edit-words')", 10000, 'detail');
    const path = await p.ev('location.pathname'); await p.ev("window.__doc = 'same-document'; true");
    await click(p, '#edit-words', 'Edit my words'); await typeInto(p, '#edit-reflection', 'UNSAVED WORDS before Back'); await typeInto(p, '#edit-next', 'unsaved next step');
    await p.ev("history.back(); true"); await waitFor(p, "location.pathname === '/account/results'", 8000, 'Back → list'); ok(!(await p.ev("!!document.querySelector('#edit-reflection')")), 'the editor is not on the list page'); ok(await p.ev("window.__doc === 'same-document'"), 'Back must stay inside the app (no reload)');
    await p.ev("history.forward(); true"); await waitFor(p, `location.pathname === ${JSON.stringify(path)} && document.querySelector('#edit-reflection')`, 10000, 'Forward → editor');
    ok(await p.ev("document.querySelector('#edit-reflection').value === 'UNSAVED WORDS before Back' && document.querySelector('#edit-next').value === 'unsaved next step'"), `the edits were not restored: ${await p.ev("document.querySelector('#edit-reflection')?.value")}`);
    ok((await text(p, '#edit-status')).includes('Changed since last save'), await text(p, '#edit-status')); ok(await warns(p), 'the leave-page warning is on again'); ok(sql(`select reflection from app.saved_reflections where owner_id = '${m.id}'`) === 'saved words', 'nothing was saved by going Back'); await shot(p, 'result-edit-restored-after-forward');
    // no browser storage was used
    ok(await p.ev("(() => { try { return localStorage.length === 0 && sessionStorage.length === 0; } catch { return true; } })()"), 'storage was written');
    // an explicit discard removes the state: leave by link, choose "Leave and discard", come back
    await clickRole(p, 'link', 'My hacks'); await waitFor(p, "document.querySelector('dialog.confirm[open]')", 5000, 'leave dialog'); await confirmDialog(p, 'Leave and discard'); await waitFor(p, "location.pathname === '/account/prompts'", 8000, 'left');
    await p.ev("history.back(); true"); await waitFor(p, `location.pathname === ${JSON.stringify(path)} && document.querySelector('#edit-words')`, 10000, 'back on the detail'); ok(!(await p.ev("!!document.querySelector('#edit-reflection')")), 'discarded edits must not come back');
    // sign-out clears unsaved edits (private state of the old account)
    await click(p, '#edit-words', 'Edit my words'); await typeInto(p, '#edit-reflection', 'PRIVATE UNSAVED WORDS'); await signOutUi(p); await waitFor(p, "document.querySelector('.account-state')?.textContent.includes('Not signed in')", 8000, 'signed out');
    const seen = []; for (let i = 0; i < 8; i++) { seen.push(await text(p, 'body')); await sleep(150); } ok(!seen.some((t) => t.includes('PRIVATE UNSAVED WORDS')), 'unsaved words visible after sign-out');
    await clickRole(p, 'link', 'Sign in'); await waitFor(p, "location.pathname === '/account/sign-in'"); await typeInto(p, '#signin-email', m.email); await typeInto(p, '#signin-password', PW); await p.key('Enter'); await waitFor(p, "document.querySelector('.account-state')?.textContent.includes('Signed in')", 12000, 'signed in again');
    await p.ev("history.back(); true"); await sleep(600); await p.ev("history.forward(); true"); await sleep(600);
    await goMyResults(p); await waitFor(p, "location.pathname === '/account/results' && document.querySelector('.work-row')", 10000, 'list again'); await click(p, '.work-row a', 'B1 prompt'); await waitFor(p, "document.querySelector('#edit-words')", 10000, 'detail again');
    ok(!(await p.ev("!!document.querySelector('#edit-reflection')")) && !(await text(p, 'body')).includes('PRIVATE UNSAVED WORDS'), 'the old account\'s unsaved edits came back'); return 'Back → Forward restores (no reload, no storage); discard and sign-out clear it';
  });

  await check('B2', 'CONCURRENCY ON RETURN: edits made against v1, another tab saves v2, Forward restores the words AND an explicit conflict; Save does NOT overwrite v2 (stays a conflict) until the member chooses Overwrite', async () => {
    const m = await newMember('b2'); const p = await page(); await signIn(p, m); await startDraft(p, { title: 'B2 prompt', prompt: 'b2 text' }); await click(p, 'button', 'Reflect'); await waitFor(p, "location.pathname === '/reveal'");
    await chooseOutcome(p, 'yes'); await typeInto(p, '#reflection', 'version one words'); await click(p, '#result-save', 'Save prompt and result'); await waitFor(p, "/^Result saved/.test(document.querySelector('#result-status')?.textContent)", 10000, 'saved');
    await goMyResults(p); await waitFor(p, "location.pathname === '/account/results' && document.querySelector('.work-row')", 10000, 'list'); await click(p, '.work-row a', 'B2 prompt'); await waitFor(p, "document.querySelector('#edit-words')", 10000, 'detail'); const path = await p.ev('location.pathname');
    const rid = sql(`select id from app.saved_reflections where owner_id = '${m.id}'`); ok(sql(`select version from app.saved_reflections where id = '${rid}'`) === '1', 'starts at v1');
    await click(p, '#edit-words', 'Edit my words'); await typeInto(p, '#edit-reflection', 'MY UNSAVED WORDS based on v1');
    await p.ev("history.back(); true"); await waitFor(p, "location.pathname === '/account/results'", 8000, 'Back');
    sql(`begin; set local role hackass_owner; update app.saved_reflections set reflection = 'OTHER TAB WORDS v2', version = version + 1 where id = '${rid}'; commit;`);   // the other tab saves version 2
    await p.ev("history.forward(); true"); await waitFor(p, `location.pathname === ${JSON.stringify(path)} && document.querySelector('#edit-reflection')`, 10000, 'Forward → editor'); await waitFor(p, "document.querySelector('#result-conflict')", 10000, 'explicit conflict');
    ok(await p.ev("document.querySelector('#edit-reflection').value === 'MY UNSAVED WORDS based on v1'"), 'the restored words must be intact'); ok((await text(p, '#result-conflict')).includes('OTHER TAB WORDS v2'), 'the other tab\'s saved version is shown'); await shot(p, 'result-edit-restored-with-conflict');
    // Save must not overwrite version 2
    await click(p, '#save-words', 'Save changes'); await sleep(1500); await waitFor(p, "document.querySelector('#result-conflict') && !document.querySelector('#edit-status')?.textContent.includes('Saving')", 8000, 'still a conflict');
    ok(sql(`select reflection || '|' || version from app.saved_reflections where id = '${rid}'`) === 'OTHER TAB WORDS v2|2', `Save overwrote the other tab's version: ${sql(`select reflection || '|' || version from app.saved_reflections where id = '${rid}'`)}`);
    ok(await p.ev("document.querySelector('#edit-reflection').value === 'MY UNSAVED WORDS based on v1'"), 'words intact after the refused save'); ok(await warns(p), 'still unsaved');
    // only an explicit choice resolves it
    await click(p, '#rc-overwrite', 'Overwrite'); await confirmDialog(p, 'Overwrite'); await waitFor(p, "!document.querySelector('#edit-reflection') && document.body.innerText.includes('MY UNSAVED WORDS based on v1')", 10000, 'overwritten');
    ok(sql(`select reflection || '|' || version from app.saved_reflections where id = '${rid}'`) === 'MY UNSAVED WORDS based on v1|3', 'overwrite after explicit confirmation'); return 'words restored + explicit conflict; Save refused (v2 intact); Overwrite → v3';
  });
  await check('X1', 'Download my data: a bounded, paged export becomes a JSON file with only the member\'s own prompts and results (no owner id or request internals); progress and Cancel exist', async () => {
    const m = await newMember('x1'), other = await newMember('x1b'); const p = await page(); await signIn(p, m);
    sql(`begin; set local role hackass_owner; insert into app.saved_prompts (owner_id, request_id, request_hash, request_receipt, title, goal, context, output_format, full_prompt, starting_prompt, origin_kind) select u, gen_random_uuid(), repeat('a', 64), '{}', 'Export ' || i, '', '', 'Concise summary', 'text ' || i, '', 'scratch' from generate_series(1, 120) i, unnest(array['${m.id}'::uuid]) u; insert into app.saved_prompts (owner_id, request_id, request_hash, request_receipt, title, goal, context, output_format, full_prompt, starting_prompt, origin_kind) values ('${other.id}', gen_random_uuid(), repeat('b', 64), '{}', 'OTHER MEMBER SECRET', '', '', 'Concise summary', 'other text', '', 'scratch'); commit;`);
    const dir = mkdtempSync(join(tmpdir(), 'px3c-dl-')); await p.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    await p.goto(`${APP}/account/prompts`); await waitFor(p, "document.querySelector('#export-start')", 10000, 'export'); await shot(p, 'my-prompts-with-export'); await click(p, '#export-start', 'Download my data');
    await waitFor(p, "document.querySelector('#export-status')?.textContent.includes('Downloaded')", 20000, 'downloaded'); ok((await text(p, '#export-status')).includes('Downloaded 120 prompts and 0 results'), await text(p, '#export-status'));
    let f; for (let i = 0; i < 30 && !f; i++) { f = readdirSync(dir).find((x) => x.endsWith('.json')); if (!f) await sleep(200); } ok(f && /^hackass-my-data-\d{4}-\d\d-\d\d\.json$/.test(f), `file ${f}`);
    const raw = readFileSync(join(dir, f), 'utf8'); const j = JSON.parse(raw); ok(j.prompts.length === 120 && j.counts.prompts === 120, 'counts'); ok(!/OTHER MEMBER SECRET|owner_id|request_hash|request_receipt/.test(raw), 'foreign or internal data in the file'); return `120 prompts in ${f}; no foreign data`;
  });

  // ======== States, keyboard, responsive ========
  await check('E1', 'saved-work pages: signed-out → "Sign in to see your saved work" (with return path); outage → retryable error; loading skeleton; no sign-up anywhere', async () => {
    const p = await page(); await p.goto(`${APP}/account/prompts`); await waitFor(p, "document.querySelector('#work-signin')", 10000, 'sign-in state'); ok((await text(p, 'main')).includes('Sign in to see your saved work'), 'text'); ok(await p.ev("document.querySelector('#work-signin').getAttribute('href') === '/account/sign-in?next=%2Faccount%2Fprompts'"), 'return path'); await shot(p, 'my-prompts-signed-out');
    ok(!/sign.?up|register/i.test(await text(p, 'body').then((t) => t.replace(/Registration is closed/gi, ''))), 'sign-up wording');
    const m = await newMember('e1'); await signIn(p, m); proxyState.mode = 'down'; try { await p.goto(`${APP}/account/results`); await waitFor(p, "document.querySelector('#work-retry') || document.querySelector('#work-signin')", 12000, 'error state'); ok(await p.ev("!!document.querySelector('#work-retry')"), 'an outage must be a retryable error, not "sign in"'); await shot(p, 'my-results-outage'); } finally { proxyState.mode = 'pass'; }
    await click(p, '#work-retry', 'Try again'); await waitFor(p, "document.querySelector('.state-box')?.textContent.includes('No saved results yet')", 12000, 'recovered'); return 'signed-out, outage→retry→empty';
  });
  await check('K1', 'KEYBOARD: Tab reaches Save and Enter saves; the confirm dialog traps focus and Escape cancels; the status is a live region', async () => {
    const m = await newMember('k1'); const p = await page(); await signIn(p, m); await startDraft(p, { title: 'Keyboard prompt', prompt: 'kb text' }); await p.ev("document.querySelector('#fullPrompt').focus(); true");
    let reached = false; for (let i = 0; i < 30 && !reached; i++) { await p.key('Tab'); reached = await p.ev("document.activeElement?.id === 'save-prompt'"); } ok(reached, 'Tab never reached Save'); await p.key('Enter'); await waitFor(p, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved by keyboard');
    ok(await p.ev("document.querySelector('#save-status').getAttribute('role') === 'status' && document.querySelector('#save-status').getAttribute('aria-live') === 'polite'"), 'live region'); await p.goto(`${APP}/account/prompts`); await click(p, '.work-row a', 'Keyboard prompt'); await waitFor(p, "document.querySelector('#delete-prompt')"); await click(p, '#delete-prompt', 'Delete');
    await waitFor(p, "document.querySelector('dialog.confirm[open]')", 5000, 'dialog'); for (let i = 0; i < 6; i++) await p.key('Tab'); ok(await p.ev("!!document.activeElement?.closest('dialog.confirm')"), 'focus escaped the dialog'); await p.key('Escape'); await sleep(300); ok(!(await p.ev("!!document.querySelector('dialog.confirm[open]')")), 'Escape should close'); ok(count('saved_prompts', m.id) === 1, 'Escape must not delete'); return 'Tab → Save → Enter; dialog traps focus; Escape cancels';
  });
  await check('D1', 'DESKTOP 1280: no horizontal overflow and every control ≥ 44px on the Lab (with Save), Reveal (with Save), My prompts, My results and the detail pages', async () => {
    const m = await newMember('d1'); const p = await page(1280, 900); await signIn(p, m); await startDraft(p, { title: 'Desktop prompt', prompt: 'desktop text' }); await click(p, '#save-prompt', 'Save prompt'); await waitFor(p, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved'); const small = [];
    const audit = async (name) => { ok(!(await overflow(p)), `${name}: horizontal overflow`); const o = await offenders(p); if (o.length) small.push(`${name}: ${JSON.stringify(o)}`); };
    await audit('lab'); await shot(p, 'desktop-lab'); await click(p, 'button', 'Reflect'); await waitFor(p, "location.pathname === '/reveal'"); await chooseOutcome(p, 'yes'); await click(p, '#result-save', 'Save this result'); await waitFor(p, "/^Result saved/.test(document.querySelector('#result-status')?.textContent)", 10000); await audit('reveal'); await shot(p, 'desktop-reveal');
    await p.goto(`${APP}/account/prompts`); await waitFor(p, "document.querySelector('.work-row')"); await audit('my-prompts'); await shot(p, 'desktop-my-prompts'); await click(p, '.work-row a', 'Desktop prompt'); await waitFor(p, "document.querySelector('#delete-prompt')"); await audit('prompt-detail'); await shot(p, 'desktop-prompt-detail');
    await p.goto(`${APP}/account/results`); await waitFor(p, "document.querySelector('.work-row')"); await audit('my-results'); await click(p, '.work-row a', 'Desktop prompt'); await waitFor(p, "document.querySelector('#edit-words')"); await audit('result-detail'); ok(small.length === 0, small.join(' | ')); return '5 screens + 2 details audited';
  });
  await check('D2', 'MOBILE 375: no horizontal overflow, every control ≥ 44px, the bottom navigation has My hacks, and the Save area, lists, details and confirm dialog fit', async () => {
    const m = await newMember('d2'); const p = await page(375, 812, true); await signIn(p, m); await startDraft(p, { title: 'Mobile prompt', prompt: 'mobile text' }); const small = [];
    const audit = async (name) => { ok(!(await overflow(p)), `${name}: horizontal overflow`); const o = await offenders(p); if (o.length) small.push(`${name}: ${JSON.stringify(o)}`); };
    await audit('lab'); await p.ev("document.querySelector('.save-panel').scrollIntoView(); true"); await shot(p, 'mobile-lab-save'); await click(p, '#save-prompt', 'Save prompt'); await waitFor(p, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000); await shot(p, 'mobile-lab-saved');
    ok(await p.ev("[...document.querySelectorAll('.mobile-nav a, .mobile-nav button')].some((x) => x.textContent.includes('My hacks'))"), 'My hacks in the bottom nav'); await click(p, 'button', 'Reflect'); await waitFor(p, "location.pathname === '/reveal'"); await chooseOutcome(p, 'yes'); await audit('reveal'); await shot(p, 'mobile-reveal');
    await click(p, '#result-save', 'Save this result'); await waitFor(p, "/^Result saved/.test(document.querySelector('#result-status')?.textContent)", 10000, 'result saved'); await shot(p, 'mobile-reveal-saved'); ok(!(await warns(p)), 'clean before leaving'); // an unsaved reflection would (correctly) raise the leave-page warning
    await p.goto(`${APP}/account/prompts`); await waitFor(p, "document.querySelector('.work-row')"); await audit('my-prompts'); await shot(p, 'mobile-my-prompts'); await click(p, '.work-row a', 'Mobile prompt'); await waitFor(p, "document.querySelector('#delete-prompt')"); await audit('detail'); await shot(p, 'mobile-prompt-detail');
    await click(p, '#delete-prompt', 'Delete'); await waitFor(p, "document.querySelector('dialog.confirm[open]')"); ok(await p.ev("(() => { const r = document.querySelector('dialog.confirm[open]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()"), 'dialog fits'); await shot(p, 'mobile-delete-confirm'); await p.key('Escape');
    await p.goto(`${APP}/account/results`); await waitFor(p, "document.querySelector('.work-row')"); await audit('my-results'); await shot(p, 'mobile-my-results'); ok(small.length === 0, small.join(' | ')); return 'overflow-free, controls ≥44px, dialog fits';
  });
  // ======== S2: Home and navigation alignment (roles and accessible names only) ========
  const centred = (p, sel) => p.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, dx: Math.abs((r.left + r.right) / 2 - innerWidth / 2), dy: Math.abs((r.top + r.bottom) / 2 - innerHeight / 2) }; })()`);
  await check('N1', 'NAVIGATION: exactly Home and My hacks plus a New hack button; New hack asks before replacing unsaved work; Escape keeps the draft; "Replace my draft" starts a blank one; the dialog is centred, fully visible and traps focus', async () => {
    const m = await newMember('n1'); const p = await page(1440, 900); await signIn(p, m); await startDraft(p, { title: 'Nav prompt', prompt: 'NAV DRAFT TEXT' });
    const names = await p.ev("[...document.querySelectorAll('nav[aria-label=Primary] a')].map((a) => a.getAttribute('aria-label'))"); ok(JSON.stringify(names) === '["Home","My hacks"]', `primary nav ${JSON.stringify(names)}`);
    ok(await hasRole(p, 'button', 'New hack'), 'New hack button'); await clickRole(p, 'link', 'Home'); await waitFor(p, "location.pathname === '/spark'");
    await waitFor(p, "document.querySelector('main')?.innerText.includes('Your draft is still here')", 8000, 'contextual guidance for an unsaved draft'); ok(await hasRole(p, 'link', 'Continue your draft'), 'continue link');
    await clickRole(p, 'button', 'New hack'); await confirmDialog(p, 'Keep my draft'); // the dialog opens; press Keep
    ok(await sameDoc(p), 'same document'); await goLab(p); await waitFor(p, "document.getElementById('fullPrompt')?.value === 'NAV DRAFT TEXT'", 8000, 'draft kept');
    await clickRole(p, 'link', 'Home'); await waitFor(p, "location.pathname === '/spark'"); await clickRole(p, 'button', 'New hack'); await waitFor(p, "document.querySelector('dialog.confirm[open]')", 5000, 'dialog');
    const c = await centred(p, 'dialog.confirm[open]'); ok(c && c.inside && c.dx < 3 && c.dy < 40, `dialog centred and fully visible ${JSON.stringify(c)}`); await shot(p, 'n1-new-hack-dialog');
    ok(await p.ev("document.activeElement?.closest('dialog.confirm')?.querySelector('button') !== null && !!document.activeElement.closest('dialog.confirm')"), 'focus inside the dialog');
    for (let i = 0; i < 6; i++) { await p.key('Tab'); ok(await p.ev(`(() => { const a = document.activeElement; return !a || a === document.body || a === document.documentElement || !!a.closest('dialog.confirm[open]'); })()`), `focus reached the page behind the dialog on Tab ${i + 1}`); }
    await p.key('Escape'); await waitFor(p, "!document.querySelector('dialog.confirm[open]')", 5000, 'closed by Escape'); ok(await p.ev("location.pathname === '/spark'"), 'Escape must not navigate');
    await goLab(p); ok(await p.ev("document.getElementById('fullPrompt').value === 'NAV DRAFT TEXT'"), 'Escape kept the draft');
    await clickRole(p, 'link', 'Home'); await waitFor(p, "location.pathname === '/spark'"); await clickRole(p, 'button', 'New hack'); await confirmDialog(p, 'Replace my draft'); await waitFor(p, "location.pathname === '/lab'");
    await waitFor(p, "document.getElementById('fullPrompt')", 8000, 'Lab prompt box'); ok(await p.ev("document.getElementById('fullPrompt').value === ''"), 'a blank draft'); ok(count('saved_prompts', m.id) === 0, 'nothing saved by any of this'); return 'Home + My hacks + New hack; dialog centred/visible/trapped; Escape keeps; Replace starts blank';
  });
  await check('N2', 'MANUAL-COPY DIALOG: when the clipboard is refused the text is shown selected in a centred, fully visible dialog; keyboard: focus inside, Escape closes, Enter on Done closes', async () => {
    const m = await newMember('n2'); const p = await page(1280, 800); await signIn(p, m); await startDraft(p, { title: 'Copy prompt', prompt: 'COPY ME PLEASE' });
    await p.ev("Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } }, configurable: true }); document.execCommand = () => false; true");
    await clickRole(p, 'button', 'Copy prompt'); await waitFor(p, "document.querySelector('dialog[open] textarea.manual-copy')", 5000, 'manual copy dialog');
    const c = await centred(p, 'dialog[open]'); ok(c && c.inside && c.dx < 3 && c.dy < 40, `dialog centred ${JSON.stringify(c)}`); ok(await p.ev("document.querySelector('textarea.manual-copy').value === 'COPY ME PLEASE' && document.activeElement === document.querySelector('textarea.manual-copy')"), 'text shown and focused');
    ok(await p.ev("(() => { const t = document.querySelector('textarea.manual-copy'); return t.selectionStart === 0 && t.selectionEnd === t.value.length; })()"), 'text selected'); await shot(p, 'n2-manual-copy-dialog');
    for (let i = 0; i < 6; i++) { await p.key('Tab'); ok(await p.ev(`(() => { const a = document.activeElement; return !a || a === document.body || a === document.documentElement || !!a.closest('dialog[open]'); })()`), `focus reached the page behind the dialog on Tab ${i + 1}: ${await p.ev('document.activeElement?.tagName + " " + (document.activeElement?.className || "")')}`); } // native modal: the page behind is inert; focus may rest on the browser's own UI (reported as body)
    await p.key('Escape'); await waitFor(p, "!document.querySelector('dialog[open]')", 5000, 'Escape closes');
    ok(await p.ev("document.getElementById('fullPrompt').value === 'COPY ME PLEASE'"), 'draft untouched'); await clickRole(p, 'button', 'Copy prompt'); await waitFor(p, "document.querySelector('dialog[open] textarea.manual-copy')", 5000, 'reopened');
    for (let i = 0; i < 4; i++) { await p.key('Tab'); if (await p.ev("document.activeElement?.textContent.trim() === 'Done'")) break; } await p.key('Enter'); await waitFor(p, "!document.querySelector('dialog[open]')", 5000, 'Enter on Done closes'); return 'centred, text selected, trapped, Escape and Enter close';
  });
  await check('N3', 'CARDS: each card is one link (the title) reachable by keyboard with a visible ring on the card; Enter opens it; no per-card button; demo cards stay labelled; category chips carry an icon and text', async () => {
    const p = await page(1280, 900); await p.goto(`${APP}/spark/demo`); await waitFor(p, "document.querySelector('.hack-card .card-link')");
    const shape = await p.ev("[...document.querySelectorAll('.hack-card')].map((c) => ({ links: c.querySelectorAll('a').length, buttons: c.querySelectorAll('button').length, demo: c.textContent.includes('Demo example · draft'), title: c.querySelector('h3 a')?.textContent.trim() }))");
    ok(shape.length === 3 && shape.every((c) => c.links === 1 && c.buttons === 0 && c.demo && c.title), `cards ${JSON.stringify(shape)}`);
    ok(await p.ev("[...document.querySelectorAll('.chip')].every((c) => c.querySelector('.chip-icon svg') && c.textContent.trim().length > 0)"), 'chips: icon and text');
    ok(await p.ev("!document.body.innerText.includes('Explore hack')"), 'no per-card Explore button');
    let reached = false; for (let i = 0; i < 40 && !reached; i++) { await p.key('Tab'); reached = await p.ev("document.activeElement?.classList.contains('card-link')"); } ok(reached, 'Tab never reached a card link');
    const ring = await p.ev("(() => { const c = document.activeElement.closest('.hack-card'); const s = getComputedStyle(c); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), name: document.activeElement.textContent.trim() }; })()"); ok(ring.style === 'solid' && ring.width >= 2, `focus ring on the card ${JSON.stringify(ring)}`); await shot(p, 'n3-card-focus');
    await p.key('Enter'); await waitFor(p, "location.pathname.startsWith('/spark/demo/')", 8000, 'card opened by Enter'); ok((await text(p, 'main')).includes(ring.name), 'the opened hack is the focused card');
    const whole = await page(1280, 900); await whole.goto(`${APP}/spark/demo`); await waitFor(whole, "document.querySelector('.hack-card')");
    ok(await whole.ev("(() => { const q = document.querySelector('.hack-card p').getBoundingClientRect(); return !!document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2)?.closest('.card-link'); })()"), 'a click anywhere on the card (not just the title) opens it');
    return 'one link per card, keyboard ring and Enter work, icons on chips, demo label kept';
  });
  await check('N4', 'BREAKPOINTS: labelled sidebar at 1200+, rail at 768 / 820 / 1199, bottom bar at 767; controls unobscured, no overflow, usable content width', async () => {
    const m = await newMember('n4'); const p = await page(1280, 900); await signIn(p, m); const rows = [];
    for (const [w, h, mode] of [[1200, 800, 'sidebar'], [1199, 800, 'rail'], [820, 1180, 'rail'], [768, 1024, 'rail'], [767, 900, 'bar']]) {
      await p.viewport(w, h, false); await p.goto(`${APP}/spark/demo`); await waitFor(p, "document.querySelector('.hack-card')"); await sleep(300);
      const f = await p.ev(`(() => { const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; const sb = document.querySelector('.sidebar'), mb = document.querySelector('.mobile-nav'), main = document.querySelector('main.page');
        const top = (sel, scope) => { const e = [...document.querySelectorAll(sel)].find(vis); if (!e) return 'missing'; const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e === hit || e.contains(hit) ? 'ok' : 'obscured'; };
        const labelled = !!sb && vis(sb) && [...sb.querySelectorAll('.nav-label')].every((l) => l.getBoundingClientRect().width > 8);
        return { sidebar: vis(sb) ? Math.round(sb.getBoundingClientRect().width) : 0, bar: vis(mb), labelled, content: Math.round(main.getBoundingClientRect().width), overflow: document.documentElement.scrollWidth > innerWidth + 1,
          ctl: [top('.new-hack'), top('nav[aria-label=Primary] a, .mobile-nav a'), top('.card-link'), top('.chip')] }; })()`);
      ok(!f.overflow, `${w}: horizontal overflow`); ok(f.ctl.every((x) => x === 'ok'), `${w}: ${JSON.stringify(f.ctl)}`);
      if (mode === 'sidebar') ok(f.sidebar === 248 && f.labelled && !f.bar, `${w} sidebar ${JSON.stringify(f)}`); if (mode === 'rail') ok(f.sidebar === 76 && !f.bar && f.content >= 600, `${w} rail ${JSON.stringify(f)}`); if (mode === 'bar') ok(f.sidebar === 0 && f.bar, `${w} bar ${JSON.stringify(f)}`);
      if (mode === 'bar') { const last = await p.ev("(() => { window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }); const cs = [...document.querySelectorAll('.footer, .hack-card')].pop().getBoundingClientRect(); const mb = document.querySelector('.mobile-nav').getBoundingClientRect(); return cs.bottom <= mb.top + 1; })()"); ok(last, `${w}: the end of the page is hidden behind the bottom bar`); }
      await shot(p, `n4-${w}`); rows.push(`${w}:${mode}/${f.content}px`);
    } return rows.join(' ');
  });
  await check('N5', 'SIGNED-IN My hacks: one destination (current on both pages), Prompts and Results tabs over the existing routes, rows listed, no Collections or Links tab, at desktop, rail and phone widths', async () => {
    const m = await newMember('n5'); const p = await page(1440, 900); await signIn(p, m); await startDraft(p, { title: 'N5 prompt', prompt: 'n5 text' });
    await clickRole(p, 'button', 'Save prompt'); await waitFor(p, "/^Saved/.test(document.querySelector('#save-status')?.textContent)", 10000, 'saved'); await clickRole(p, 'button', 'I\'ve tried it'); await waitFor(p, "location.pathname === '/reveal'");
    await chooseOutcome(p, 'yes'); await click(p, '#result-save', 'Save this result'); await waitFor(p, "/^Result saved/.test(document.querySelector('#result-status')?.textContent)", 10000, 'result saved');
    await clickRole(p, 'link', 'My hacks'); await waitFor(p, "location.pathname === '/account/prompts' && document.querySelector('.work-row')", 10000, 'prompts list');
    ok(await p.ev("document.querySelector('nav[aria-label=Primary] a[aria-current=page]')?.getAttribute('aria-label') === 'My hacks'"), 'My hacks current on Prompts');
    const tabs = await p.ev("[...document.querySelectorAll('nav[aria-label=\"My hacks\"] a')].map((a) => a.textContent.trim() + (a.getAttribute('aria-current') ? '*' : ''))"); ok(JSON.stringify(tabs) === '["Prompts*","Results"]', `tabs ${JSON.stringify(tabs)}`);
    ok((await text(p, '.work-row')).includes('N5 prompt'), 'prompt row'); await shot(p, 'n5-my-hacks-prompts-1440');
    await clickRole(p, 'link', 'Results'); await waitFor(p, "location.pathname === '/account/results' && document.querySelector('.work-row')", 10000, 'results list');
    ok(await p.ev("document.querySelector('nav[aria-label=Primary] a[aria-current=page]')?.getAttribute('aria-label') === 'My hacks'"), 'My hacks current on Results');
    const tabs2 = await p.ev("[...document.querySelectorAll('nav[aria-label=\"My hacks\"] a')].map((a) => a.textContent.trim() + (a.getAttribute('aria-current') ? '*' : ''))"); ok(JSON.stringify(tabs2) === '["Prompts","Results*"]', `tabs ${JSON.stringify(tabs2)}`);
    ok(!(await text(p, 'main')).match(/Collections|Links/), 'no non-functional tabs'); await shot(p, 'n5-my-hacks-results-1440');
    await clickRole(p, 'link', 'Prompts'); await waitFor(p, "location.pathname === '/account/prompts'");
    for (const [w, h, mobile, tag] of [[1100, 800, false, '1100'], [390, 844, true, '390']]) { await p.viewport(w, h, mobile); await p.goto(`${APP}/account/prompts`); await waitFor(p, "document.querySelector('.work-row')"); ok(!(await overflow(p)), `${tag}: overflow`); await shot(p, `n5-my-hacks-prompts-${tag}`); await clickRole(p, 'link', 'Results'); await waitFor(p, "location.pathname === '/account/results' && document.querySelector('.work-row')"); ok(!(await overflow(p)), `${tag}: overflow (results)`); await shot(p, `n5-my-hacks-results-${tag}`); }
    ok(count('saved_prompts', m.id) === 1, 'row count'); return 'signed in: Prompts and Results tabs, My hacks current on both, rows listed, 1440/1100/390 clean';
  });
  await check('N6', 'ACCOUNT ACCESS and PREVIEW NOTICE at every width: sidebar controls on desktop; an accessible account menu in the rail (1199, 820, 768) and in a compact phone header (390); the notice is visible without a tall header; sign-in state and sign-out work from the menu', async () => {
    const m = await newMember('n6'); const p = await page(1440, 900); const rows = [];
    const probe = () => p.ev(`(() => { const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; const sum = [...document.querySelectorAll('details.account-menu > summary')].find(vis); const strip = document.querySelector('.preview-strip'); const side = document.querySelector('.side-note'); const top = document.querySelector('.topbar');
      return { notice: vis(strip) ? { where: 'strip', h: Math.round(strip.getBoundingClientRect().height), ok: strip.textContent.includes('PRIVATE PREVIEW') } : vis(side) ? { where: 'sidebar', h: 0, ok: side.textContent.includes('PRIVATE PREVIEW') } : null, summary: sum ? { label: sum.getAttribute('aria-label'), w: Math.round(sum.getBoundingClientRect().width), h: Math.round(sum.getBoundingClientRect().height) } : null, chip: vis(document.querySelector('.side-account .account-chip')), header: vis(top) ? Math.round(top.getBoundingClientRect().height) : 0, overflow: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
    for (const [w, h, mode] of [[1440, 900, 'sidebar'], [1199, 800, 'rail'], [820, 1180, 'rail'], [768, 1024, 'rail'], [390, 844, 'phone']]) {
      await p.viewport(w, h, mode === 'phone'); await p.goto(`${APP}/spark/demo`); await waitFor(p, "document.querySelector('.hack-card')"); await sleep(300); const f = await probe();
      ok(!f.overflow, `${w}: overflow`); ok(f.notice && f.notice.ok, `${w}: the private-preview notice is not visible ${JSON.stringify(f.notice)}`);
      if (mode === 'sidebar') { ok(f.chip && f.header === 0 && !f.summary, `${w}: sidebar account controls ${JSON.stringify(f)}`); ok(await hasRole(p, 'link', 'Sign in'), `${w}: Sign in link`); }
      else {
        ok(f.notice.where === 'strip' && f.notice.h <= 40, `${w}: notice strip ${JSON.stringify(f.notice)}`); ok(f.summary && f.summary.label.startsWith('Account menu: Not signed in') && f.summary.w >= 44 && f.summary.h >= 44, `${w}: account entry ${JSON.stringify(f.summary)}`);
        if (mode === 'phone') ok(f.header > 0 && f.header <= 64 && await hasRole(p, 'link', 'HackAss home'), `${w}: compact header ${f.header}px with the brand`); else ok(f.header === 0, `${w}: no top bar beside the rail`);
        await p.ev("(() => { const s = [...document.querySelectorAll('details.account-menu > summary')].find((x) => x.getBoundingClientRect().width > 0); s.focus(); return true; })()"); await p.key('Enter');
        await waitFor(p, "[...document.querySelectorAll('details.account-menu')].some((d) => d.open && d.getBoundingClientRect().width > 0)", 4000, 'menu opens with the keyboard');
        const panel = await p.ev("(() => { const d = [...document.querySelectorAll('details.account-menu')].find((x) => x.open && x.getBoundingClientRect().width > 0); const r = d.querySelector('.account-menu-panel').getBoundingClientRect(); return { inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, text: d.querySelector('.account-menu-panel').innerText }; })()");
        ok(panel.inside && /Not signed in/.test(panel.text) && await hasRole(p, 'link', 'Sign in'), `${w}: menu panel ${JSON.stringify(panel)}`); await shot(p, `n6-account-menu-${w}`);
        await p.key('Escape'); ok(await p.ev("![...document.querySelectorAll('details.account-menu')].some((d) => d.open) && document.activeElement?.tagName === 'SUMMARY'"), `${w}: Escape closes the menu and returns focus to its button`);
      }
      await shot(p, `n6-anonymous-${w}`); rows.push(`${w}:${mode}`);
    }
    await signIn(p, m); await p.viewport(820, 1180, false); await p.goto(`${APP}/spark/demo`); await waitFor(p, "document.querySelector('.hack-card')"); await waitFor(p, "document.querySelector('details.account-menu-rail > summary')?.getAttribute('aria-label') === 'Account menu: Signed in'", 8000, 'rail shows signed in');
    await signOutUi(p); await waitFor(p, "document.querySelector('details.account-menu-rail > summary')?.getAttribute('aria-label') === 'Account menu: Not signed in'", 10000, 'signed out from the rail menu');
    await signIn(p, m); await p.viewport(390, 844, true); await p.goto(`${APP}/spark/demo`); await waitFor(p, "document.querySelector('details.account-menu-header > summary')?.getAttribute('aria-label') === 'Account menu: Signed in'", 8000, 'header shows signed in');
    await shot(p, 'n6-signed-in-390'); await signOutUi(p); await waitFor(p, "document.querySelector('details.account-menu-header > summary')?.getAttribute('aria-label') === 'Account menu: Not signed in'", 10000, 'signed out from the phone header menu');
    return `${rows.join(' ')}; notice visible everywhere; menu opens by keyboard, stays on screen, closes on Escape; sign-out works from the rail and the phone header`;
  });
  await check('N7', 'JOURNEY BAR: none on Home; compact on the hack, Lab and Reveal screens with working step links; the unsaved draft survives stepping around and New hack still asks first', async () => {
    const m = await newMember('n7'); const p = await page(1280, 900); await signIn(p, m); await startDraft(p, { title: 'N7 prompt', prompt: 'N7 DRAFT' });
    const bar = () => p.ev("(() => { const o = document.querySelector('ol[aria-label=Journey]'); return o ? { h: Math.round(o.getBoundingClientRect().height), cur: o.querySelector('[aria-current=step]')?.textContent.trim() } : null; })()");
    let b = await bar(); ok(b && b.cur.startsWith('3'), `Lab bar ${JSON.stringify(b)}`); ok(b.h <= 56, `compact: ${b.h}px`);
    await clickRole(p, 'link', '1 · Discover'); await waitFor(p, "location.pathname === '/spark'"); await sleep(300); ok((await bar()) === null, 'Home must have no journey bar'); ok(await p.ev("!document.querySelector('ol[aria-label=Journey]')"), 'no journey list on Home');
    await clickRole(p, 'link', 'Demo examples'); await waitFor(p, "location.pathname === '/spark/demo' && document.querySelector('.card-link')"); await p.ev("document.querySelector('.card-link').click(); true"); await waitFor(p, "location.pathname.startsWith('/spark/demo/')"); await sleep(300);
    b = await bar(); ok(b && b.cur.startsWith('2'), `hack page bar ${JSON.stringify(b)}`); await clickRole(p, 'link', '3 · Adapt'); await waitFor(p, "location.pathname === '/lab'"); await waitFor(p, "document.getElementById('fullPrompt')?.value === 'N7 DRAFT'", 8000, 'the draft survived stepping around');
    await clickRole(p, 'link', '4 · Reflect'); await waitFor(p, "location.pathname === '/reveal'"); b = await bar(); ok(b && b.cur.startsWith('4'), `Reveal bar ${JSON.stringify(b)}`); await clickRole(p, 'link', '3 · Adapt'); await waitFor(p, "location.pathname === '/lab'");
    ok(await p.ev("document.getElementById('fullPrompt').value === 'N7 DRAFT'") && await warns(p), 'draft intact and still unsaved'); await clickRole(p, 'link', '1 · Discover'); await waitFor(p, "location.pathname === '/spark'"); await clickRole(p, 'button', 'New hack'); await waitFor(p, "document.querySelector('dialog.confirm[open]')", 5000, 'New hack still asks first');
    await p.key('Escape'); ok(count('saved_prompts', m.id) === 0, 'nothing saved'); await p.viewport(390, 844, true); await gotoAccepting(p, `${APP}/spark/demo/meal`); await sleep(500); b = await bar(); ok(b && b.h <= 56, `phone bar ${JSON.stringify(b)}`); return 'no bar on Home; compact bar with working links on hack/Lab/Reveal; draft intact; New hack guarded';
  });
  await check('N8', 'PHONE CHIPS: the category chips are one horizontally scrollable row; Tab brings an off-screen chip into view with its focus ring fully visible', async () => {
    const p = await page(340, 800, true); await p.goto(`${APP}/spark/demo`); await waitFor(p, "document.querySelectorAll('.chips .chip').length >= 4"); await sleep(300);
    const f = await p.ev("(() => { const c = document.querySelector('.chips'); const tops = new Set([...c.querySelectorAll('.chip')].map((x) => Math.round(x.getBoundingClientRect().top))); return { rows: tops.size, scrolls: c.scrollWidth > c.clientWidth + 1, page: document.documentElement.scrollWidth > innerWidth + 1 }; })()");
    ok(f.rows === 1 && f.scrolls && !f.page, `one scrolling row ${JSON.stringify(f)}`);
    await p.ev("document.querySelector('.chips .chip').focus(); true"); let last = false; for (let i = 0; i < 6 && !last; i++) { await p.key('Tab'); last = await p.ev("document.activeElement === [...document.querySelectorAll('.chips .chip')].pop()"); } ok(last, 'Tab never reached the last chip'); await sleep(400);
    const v = await p.ev("(() => { const c = document.querySelector('.chips').getBoundingClientRect(); const a = document.activeElement; const r = a.getBoundingClientRect(); const s = getComputedStyle(a); return { scrolled: document.querySelector('.chips').scrollLeft > 0, inside: r.left >= c.left && r.right <= c.right, ring: parseFloat(s.outlineWidth), style: s.outlineStyle, offset: parseFloat(s.outlineOffset), room: Math.min(r.top - c.top, c.bottom - r.bottom) }; })()");
    ok(v.scrolled && v.inside && v.style !== 'none' && v.ring >= 2 && v.room >= v.ring + v.offset, `focused chip visible with its ring ${JSON.stringify(v)}`); await shot(p, 'n8-chips-focus-340'); return 'one row, scrolls, focused chip scrolled into view with a full ring';
  });
  await check('Z1', 'no Content-Security-Policy violation, blocked resource or uncaught exception was logged by any page in this run (meaningful when the app runs with the private-preview gate, PREVIEW_GATE=on)', async () => {
    let n = 0; const bad = [];
    for (const pg of pages) for (const e of pg.history) { n++; const t = JSON.stringify(e.params ?? {}); if (/Content Security Policy|Refused to (load|execute|connect|apply|frame|navigate)|violates the following/i.test(t) || e.method === 'Runtime.exceptionThrown') bad.push(`${e.method}: ${t.slice(0, 220)}`); }
    ok(bad.length === 0, bad.slice(0, 3).join(' | ')); return `${pages.length} pages, ${n} log/console events inspected, 0 violations; gate ${process.env.PREVIEW_GATE === 'on' ? 'ON' : 'off'}`;
  });
  await check('L1', 'logs: no prompt text, title, reflection, email, cookie or token appears in the app\'s output after all these journeys', async () => {
    const needles = ['MY DRAFT PROMPT', 'version two from the other tab', 'my own edit in tab one', 'THE PROMPT I TRIED', 'It half worked', 'ORIGINAL TEXT', 'delete me', 'second try failed', 'Reveal prompt', 'Conflict prompt', 'OTHER MEMBER SECRET', PW, 'px3c-', '@example.test', 'sb-127-auth-token='];
    for (const n of needles) if (appLog.includes(n)) throw new Error(`the log contains ${JSON.stringify(n.slice(0, 24))} in: ${(appLog.split('\n').find((l) => l.includes(n)) || '').replace(/eyJ[A-Za-z0-9_.-]+/g, '[jwt]').slice(0, 200)}`);
    const events = [...new Set([...appLog.matchAll(/"event":"([a-z_]+)"/g)].map((m) => m[1]))]; ok(events.some((e) => e.startsWith('work_')), `no work events (${events.join(',')})`); return `${appLog.split('\n').filter(Boolean).length} lines; events ${events.filter((e) => e.startsWith('work_')).join(', ')}`;
  });
} finally {
  for (const pg of pages) { try { pg.close(); } catch { /* gone */ } }
  proc.kill(); app.kill(); proxy.close();
  for (const m of members) { try { await admin.auth.admin.deleteUser(m.id); } catch { /* best effort on a disposable stack */ } }
}
console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
