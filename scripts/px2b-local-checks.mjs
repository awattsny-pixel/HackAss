#!/usr/bin/env node
// PX-2b local integration checks: the real Auth handlers of this app against a REAL local Auth stack (the separate `hackass-px2` pilot project: public
// sign-up disabled, 12-character passwords, templates pointing at /auth/callback) and Mailpit. Local only; nothing hosted is contacted.
//   1. node scripts/px2b-pilot.mjs up      (starts the separate local pilot Auth stack)
//   2. npx next build            (once)
//   3. node --conditions=react-server scripts/px2b-local-checks.mjs
// The script starts the app itself (port 3100, with throwaway secrets generated in memory and passed only to that process), puts a small fault-injecting
// proxy between the app and Auth, and prints facts and PASS/FAIL only. The service key (read from the local stack) is used ONLY by this test to invite and
// delete test users; the application never receives it. Exit 0 all passed, 1 a check failed, 2 stack or app unreachable.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { launch, newPage, sleep } from './lib/cdp.mjs';

const SUPABASE = process.env.SUPABASE_BIN || 'supabase';
const APP_PORT = 3100, APP2_PORT = 3101, PROXY_PORT = 55499;
const APP = `http://localhost:${APP_PORT}`, APP2 = `http://localhost:${APP2_PORT}`;

const st = spawnSync(SUPABASE, ['status', '--workdir', 'supabase-pilot', '-o', 'json'], { encoding: 'utf8', timeout: 60_000 });
let cfg; try { cfg = JSON.parse(st.stdout.slice(st.stdout.indexOf('{'))); } catch { console.error('BLOCKED  the pilot Auth stack is not running (supabase status failed)'); process.exit(2); }
const API = cfg.API_URL, PUB = cfg.PUBLISHABLE_KEY, SECRET = cfg.SECRET_KEY, MAIL = cfg.MAILPIT_URL || cfg.INBUCKET_URL;
if (!API || !PUB || !SECRET || !MAIL) { console.error('BLOCKED  the stack did not report its URLs and keys'); process.exit(2); }
const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = createClient(API, SECRET, noPersist);        // TEST ONLY (invite / delete users); never given to the app
const anon = () => createClient(API, PUB, noPersist);

// ---- fault-injecting proxy in front of Auth ---------------------------------------------------------------------------------------------------------------
const proxyState = { mode: 'pass', hangPath: null, hangMs: 0, weirdPath: null, count: { token: 0, user: 0, jwks: 0, other: 0 } };
const proxy = http.createServer((req, res) => {
  const u = req.url || '';
  if (u.includes('/auth/v1/token')) proxyState.count.token++; else if (u.includes('/auth/v1/user')) proxyState.count.user++; else if (u.includes('jwks')) proxyState.count.jwks++; else proxyState.count.other++;
  const forward = () => { const up = http.request({ host: '127.0.0.1', port: Number(new URL(API).port), path: u, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up); };
  if (proxyState.mode === 'down') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"message":"simulated outage"}'); return; }
  if (proxyState.mode === 'weird' && proxyState.weirdPath && u.includes(proxyState.weirdPath)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"code":400,"error_code":"mystery_code","msg":"something nobody has seen before"}'); return; }
  if (proxyState.mode === 'hang' && (!proxyState.hangPath || u.includes(proxyState.hangPath))) { setTimeout(forward, proxyState.hangMs); return; }
  forward();
}).listen(PROXY_PORT);

// ---- results ------------------------------------------------------------------------------------------------------------------------------------------------
let failed = 0; const results = [];
async function check(id, title, fn) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(id)) return;
  let guard; try { const facts = await Promise.race([fn(), new Promise((_r, rej) => { guard = setTimeout(() => rej(new Error('check exceeded 120 s (hung)')), 120_000); })]); clearTimeout(guard); results.push({ id, ok: true }); console.log(`PASS  ${id}  ${title}${facts ? `  [${facts}]` : ''}`); }
  catch (e) { clearTimeout(guard); failed++; results.push({ id, ok: false }); console.log(`FAIL  ${id}  ${title}  -> ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m); };

// ---- app processes ---------------------------------------------------------------------------------------------------------------------------------------
const SECRETS = { CURSOR_SIGNING_SECRET: randomBytes(32).toString('base64url'), AUTH_THROTTLE_SECRET: randomBytes(32).toString('base64url'), AUTH_SETUP_MARKER_SECRET: randomBytes(32).toString('base64url') };
function startApp(port, origin) {
  const env = { ...process.env, ...SECRETS, APP_ENV: 'local', APP_ORIGIN: origin, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${PROXY_PORT}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUB, TRUSTED_CLIENT_IP_HEADER: 'x-test-client-ip', NODE_ENV: 'production' };
  const p = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = { text: '' }; p.stdout.on('data', (d) => { log.text += d; }); p.stderr.on('data', (d) => { log.text += d; });
  return { p, log };
}
async function waitUp(base) { for (let i = 0; i < 60; i++) { try { const r = await fetch(`${base}/auth/session`); if (r.status) return true; } catch {} await sleep(500); } return false; }

// ---- HTTP helpers -------------------------------------------------------------------------------------------------------------------------------------------
class Jar {
  constructor() { this.c = new Map(); this.attrs = new Map(); }
  absorb(res) { for (const raw of res.headers.getSetCookie()) { const [pair, ...attrs] = raw.split(';').map((s) => s.trim()); const i = pair.indexOf('='); const name = pair.slice(0, i), value = pair.slice(i + 1); const a = attrs.join(';').toLowerCase(); this.attrs.set(name, { raw, attrs: a }); if (/max-age=0/.test(a) || value === '') this.c.delete(name); else this.c.set(name, value); } }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
  clone() { const j = new Jar(); j.c = new Map(this.c); return j; }
  names() { return [...this.c.keys()]; }
}
async function call(base, path, { method = 'GET', jar, ip = '198.51.100.1', origin = base, json, form, headers = {}, redirect = 'manual', noOrigin = false } = {}) {
  const h = { 'x-test-client-ip': ip, ...headers }; if (jar && jar.c.size) h.cookie = jar.header();
  if (method !== 'GET' && !noOrigin) h.origin = origin;
  let body; if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); } else if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  const res = await fetch(base + path, { method, headers: h, body, redirect });
  if (jar) jar.absorb(res);
  const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { res, status: res.status, text, json: j, location: res.headers.get('location') };
}
const authCookies = (jar) => jar.names().filter((n) => /^sb-.+-auth-token(\.\d+)?$/.test(n));
const hasFlags = (jar, name) => { const a = jar.attrs.get(name)?.attrs ?? ''; return { httpOnly: /httponly/.test(a), lax: /samesite=lax/.test(a), path: /path=\//.test(a), secure: /(^|;\s*)secure/.test(a), maxAge: Number((a.match(/max-age=(\d+)/) || [])[1] ?? -1) }; };

// ---- Mailpit -----------------------------------------------------------------------------------------------------------------------------------------------
async function mailClear() { await fetch(`${MAIL}/api/v1/messages`, { method: 'DELETE' }).catch(() => {}); }
async function mailFor(address, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await (await fetch(`${MAIL}/api/v1/messages`)).json();
    const hit = (r.messages || []).filter((m) => (m.To || []).some((t) => t.Address.toLowerCase() === address.toLowerCase()));
    if (hit.length) return hit;
    await sleep(300);
  }
  return [];
}
async function mailLink(address) {
  const msgs = await mailFor(address); if (!msgs.length) return null;
  const m = await (await fetch(`${MAIL}/api/v1/message/${msgs[0].ID}`)).json();
  const href = (m.HTML || '').match(/href="([^"]*\/auth\/callback[^"]*)"/); if (!href) return null;
  return href[1].replace(/&amp;/g, '&');
}
const uniq = () => randomBytes(4).toString('hex');
const newEmail = (tag) => `px2b-${tag}-${uniq()}@example.test`;
const GOOD_PW = 'correct horse battery staple';
async function inviteAndExchange(tag, ip) {
  const email = newEmail(tag); await mailClear();
  const inv = await admin.auth.admin.inviteUserByEmail(email); ok(!inv.error, `invite: ${inv.error?.message}`);
  const link = await mailLink(email); ok(link, 'no invitation email arrived');
  const u = new URL(link); const jar = new Jar();
  const ex = await call(APP, `/auth/callback/exchange`, { method: 'POST', jar, ip, form: { type: u.searchParams.get('type'), token_hash: u.searchParams.get('token_hash'), next: u.searchParams.get('next') } });
  return { email, link, jar, ex, userId: inv.data.user.id, tokenHash: u.searchParams.get('token_hash') };
}
async function setPassword(jar, password, ip = '198.51.100.2') { return call(APP, '/auth/set-password', { method: 'POST', jar, ip, form: { password, next: '/spark' } }); }
async function newMember(tag, ip) { const m = await inviteAndExchange(tag, ip); ok(m.ex.status === 303, `exchange ${m.ex.status}`); const sp = await setPassword(m.jar, GOOD_PW, ip); ok(sp.status === 303, `set-password ${sp.status} ${sp.text.slice(0, 80)}`); return m; }
function sessionCookie(jar) {
  const names = authCookies(jar).sort((a, b) => Number((a.match(/\.(\d+)$/) || [0, 0])[1]) - Number((b.match(/\.(\d+)$/) || [0, 0])[1]));
  const raw = names.map((n) => jar.c.get(n)).join(''); const isB64 = raw.startsWith('base64-');
  const json = JSON.parse(Buffer.from(isB64 ? raw.slice(7) : decodeURIComponent(raw), isB64 ? 'base64url' : 'utf8').toString('utf8'));
  return { names, isB64, json };
}
/** The same session, but the cookie claims the access token expired long ago, which forces the server to refresh it. */
function forgedExpired(jar) {
  const s = sessionCookie(jar); const j = { ...s.json, expires_at: 1000 }; const enc = 'base64-' + Buffer.from(JSON.stringify(j)).toString('base64url');
  const c = jar.clone(); for (const n of s.names) c.c.delete(n); const base = s.names[0].replace(/\.\d+$/, '');
  if (enc.length <= 3180) c.c.set(base, enc); else for (let i = 0; i * 3180 < enc.length; i++) c.c.set(`${base}.${i}`, enc.slice(i * 3180, (i + 1) * 3180));
  return c;
}

// ---- go ---------------------------------------------------------------------------------------------------------------------------------------------------
const app = startApp(APP_PORT, APP);
if (!(await waitUp(APP))) { console.error('BLOCKED  the app did not start (run `npx next build` first)'); app.p.kill(); proxy.close(); process.exit(2); }
let ipN = 10; const nextIp = () => `203.0.113.${(ipN++ % 250) + 1}`;
try {
  // ======== registration is closed ========
  await check('R1', 'public registration is refused BY THE PROVIDER (sign-up disabled), not only hidden in the UI', async () => {
    const r = await anon().auth.signUp({ email: newEmail('signup'), password: GOOD_PW });
    ok(r.error && r.error.code === 'signup_disabled' && r.error.status === 422, `expected signup_disabled/422, got ${JSON.stringify(r.error?.code)}/${r.error?.status}`); ok(!r.data.user, 'a user was created');
    return `${r.error.status} ${r.error.code}`;
  });
  await check('R2', 'the app has no sign-up route; a signup/magiclink callback link is refused with the "registration is closed" page; the legacy sign-up API stays 503', async () => {
    for (const p of ['/auth/sign-up', '/auth/register', '/api/auth/register']) { const r = await call(APP, p, { method: 'POST', json: { email: 'a@example.test', password: GOOD_PW } }); ok(r.status === 404 || r.status === 405, `${p}: ${r.status}`); }
    for (const t of ['signup', 'magiclink']) { const g = await call(APP, `/auth/callback?type=${t}&token_hash=${'a'.repeat(40)}`); ok(g.status === 403 && /Registration is closed/.test(g.text), `${t} GET ${g.status}`); const x = await call(APP, '/auth/callback/exchange', { method: 'POST', form: { type: t, token_hash: 'a'.repeat(40), next: '/spark' } }); ok(x.status === 403, `${t} POST ${x.status}`); }
    const legacy = await call(APP, '/api/auth/signup', { method: 'POST', json: {} }); ok(legacy.status === (process.env.PREVIEW_GATE === 'on' ? 404 : 503), `legacy ${legacy.status}`); /* with the private-preview gate on, the legacy API is refused even earlier (uniform 404) than its 503 stub */
    return 'POST routes 404/405; signup+magiclink 403; legacy 503';
  });

  // ======== invitation: callback, replay, cookies ========
  let inv;
  await check('I1', 'invitation: GET /auth/callback is read-only (no cookie, no provider call, token not consumed, repeatable); safe page headers', async () => {
    const email = newEmail('inv'); await mailClear(); const r = await admin.auth.admin.inviteUserByEmail(email); ok(!r.error, r.error?.message);
    const link = await mailLink(email); ok(link && link.startsWith(`${APP}/auth/callback?type=invite&token_hash=`), `link shape: ${link && link.slice(0, 60)}`);
    const before = { ...proxyState.count }; const jar = new Jar(); const lu = new URL(link);
    const a = await call(APP, lu.pathname + lu.search, { jar }); const b = await call(APP, lu.pathname + lu.search, { jar });
    ok(a.status === 200 && b.status === 200 && /Accept your invitation/.test(a.text) && /name="token_hash"/.test(a.text), 'ready page not shown twice');
    ok(jar.c.size === 0, 'a cookie was set on GET'); ok(proxyState.count.token === before.token && proxyState.count.user === before.user, 'GET reached the provider');
    const h = a.res.headers; ok(/no-store/.test(h.get('cache-control')) && h.get('referrer-policy') === 'same-origin' && h.get('x-frame-options') === 'DENY' && /default-src 'none'/.test(h.get('content-security-policy')), 'page headers');
    inv = { email, link, userId: r.data.user.id, tokenHash: lu.searchParams.get('token_hash') };
    return 'GET x2 -> 200, no Set-Cookie, no provider call';
  });
  await check('I2', 'exchange is same-origin only: missing Origin, foreign Origin and a null Origin are refused; nothing is consumed', async () => {
    const f = { type: 'invite', token_hash: inv.tokenHash, next: '/spark' };
    for (const [label, o] of [['missing', { noOrigin: true }], ['foreign', { origin: 'https://evil.example' }], ['null', { origin: 'null' }], ['same host other port', { origin: 'http://localhost:3999' }]]) { const r = await call(APP, '/auth/callback/exchange', { method: 'POST', form: f, ...o }); ok(r.status === 403, `${label}: ${r.status}`); }
    return '4 refusals (403)';
  });
  await check('I3', 'exchange succeeds once: 303 to set-password, session cookies HttpOnly + SameSite=Lax + Path=/ + 7-day Max-Age, marker cookie HttpOnly 15 min', async () => {
    const jar = new Jar(); const r = await call(APP, '/auth/callback/exchange', { method: 'POST', jar, ip: nextIp(), form: { type: 'invite', token_hash: inv.tokenHash, next: '/lab' } });
    ok(r.status === 303 && r.location === '/auth/set-password?next=%2Flab', `${r.status} ${r.location}`);
    ok(authCookies(jar).length >= 1, 'no session cookie'); for (const n of authCookies(jar)) { const f = hasFlags(jar, n); ok(f.httpOnly && f.lax && f.path && f.maxAge === 604800 && !f.secure, `${n}: ${JSON.stringify(f)}`); }
    const mf = hasFlags(jar, 'hx_setup'); ok(mf.httpOnly && mf.lax && mf.path && mf.maxAge === 900, `marker: ${JSON.stringify(mf)}`);
    inv.jar = jar; return `${authCookies(jar).length} session cookie(s) + marker; local http so no Secure flag (Secure is applied for staging/production by createUserDb)`;
  });
  await check('I4', 'replay: the same link used again is refused with the "expired or already used" page and creates no session', async () => {
    const jar = new Jar(); const r = await call(APP, '/auth/callback/exchange', { method: 'POST', jar, ip: nextIp(), form: { type: 'invite', token_hash: inv.tokenHash, next: '/spark' } });
    ok(r.status === 400 && /expired or has already been used/.test(r.text), `${r.status}`); ok(jar.c.size === 0, 'cookie set on a failed exchange'); return '400, no cookie';
  });
  await check('I5', 'callback input states: missing, malformed, unsupported type, provider error parameters; `next` can never leave the app', async () => {
    const cases = [['/auth/callback', 400, /isn.t valid/], ['/auth/callback?type=invite&token_hash=short', 400, /isn.t valid/], [`/auth/callback?type=admin&token_hash=${'a'.repeat(40)}`, 400, /isn.t valid/], ['/auth/callback?error=access_denied&error_code=otp_expired', 400, /expired/]];
    for (const [p, s, re] of cases) { const r = await call(APP, p); ok(r.status === s && re.test(r.text), `${p}: ${r.status}`); }
    for (const evil of ['https://evil.example', '//evil.example', '/%2F%2Fevil.example', 'javascript:alert(1)']) { const r = await call(APP, `/auth/callback?type=recovery&token_hash=${'b'.repeat(40)}&next=${encodeURIComponent(evil)}`); ok(r.status === 200 && /name="next" value="\/spark"/.test(r.text), `next ${evil}: ${r.text.match(/name="next" value="[^"]*"/)}`); }
    return '4 input states + 4 hostile next values -> /spark';
  });

  // ======== password setup + the marker (UX rule) ========
  await check('P1', 'a fresh invitation session cannot use a private (T2) operation until a password is set; the indicator (T1) shows it and flags setupPending', async () => {
    const s = await call(APP, '/auth/session', { jar: inv.jar }); ok(s.status === 200 && s.json.state === 'member' && s.json.verification === 'claims' && s.json.setupPending === true, JSON.stringify(s.json));
    const v = await call(APP, '/auth/session/verified', { jar: inv.jar }); ok(v.status === 403 && v.json.error.code === 'setup_required', `${v.status} ${v.text}`); return 'T1 member + setupPending; T2 403 setup_required';
  });
  await check('P2', 'set-password: weak (11 chars), too long (73 bytes), control characters and a missing session are refused; same-origin and form size are enforced', async () => {
    const w = await setPassword(inv.jar, 'a'.repeat(11)); ok(w.status === 400 && /at least 12 characters/.test(w.text), `weak ${w.status}`);
    const l = await setPassword(inv.jar, 'a'.repeat(73)); ok(l.status === 400 && /72 bytes/.test(l.text), `long ${l.status}`);
    const c = await setPassword(inv.jar, 'a'.repeat(12) + '\u0007'); ok(c.status === 400, `control ${c.status}`);
    const none = await call(APP, '/auth/set-password', { method: 'POST', ip: nextIp(), form: { password: GOOD_PW, next: '/spark' } }); ok(none.status === 401, `no session ${none.status}`);
    const xo = await call(APP, '/auth/set-password', { method: 'POST', jar: inv.jar, origin: 'https://evil.example', form: { password: GOOD_PW } }); ok(xo.status === 403, `cross-origin ${xo.status}`);
    const big = await call(APP, '/auth/set-password', { method: 'POST', jar: inv.jar, form: { password: 'a'.repeat(9000) } }); ok(big.status === 413, `oversized ${big.status}`);
    return 'weak/long/control/no-session/cross-origin refused; 9 KB form -> 413';
  });
  await check('P3', 'a valid password: 303 to the safe `next`, the marker is cleared, the member can now use T2, and signs in with the new password', async () => {
    const r = await setPassword(inv.jar, GOOD_PW, nextIp()); ok(r.status === 303 && r.location === '/spark', `${r.status} ${r.location}`); ok(!inv.jar.c.has('hx_setup'), 'marker still present');
    const v = await call(APP, '/auth/session/verified', { jar: inv.jar }); ok(v.status === 200 && v.json.verification === 'server', `${v.status} ${v.text}`);
    const s = await call(APP, '/auth/session', { jar: inv.jar }); ok(s.json.setupPending === false, 'still pending');
    const jar2 = new Jar(); const si = await call(APP, '/auth/sign-in', { method: 'POST', jar: jar2, ip: nextIp(), json: { email: inv.email, password: GOOD_PW } }); ok(si.status === 200 && si.json.ok, `sign-in ${si.status}`); return 'T2 ok after set; sign-in with new password ok';
  });
  await check('P4', 'DOCUMENTED LIMIT: the marker is a UX rule only: removing the cookie lifts the restriction for that session (nothing else depends on it)', async () => {
    const m = await inviteAndExchange('bypass', nextIp()); ok(m.ex.status === 303, `${m.ex.status}`);
    const blocked = await call(APP, '/auth/session/verified', { jar: m.jar }); ok(blocked.status === 403, `with marker ${blocked.status}`);
    const lifted = m.jar.clone(); lifted.c.delete('hx_setup'); const v = await call(APP, '/auth/session/verified', { jar: lifted }); ok(v.status === 200, `without marker ${v.status}`);
    const tampered = m.jar.clone(); tampered.c.set('hx_setup', tampered.c.get('hx_setup').slice(0, -3) + 'AAA'); const t = await call(APP, '/auth/session/verified', { jar: tampered }); ok(t.status === 200, `tampered marker is simply not valid (${t.status})`);
    return 'blocked with marker (403); 200 without or with an invalid marker';
  });

  // ======== sign-in, throttling, uniform failures ========
  const member = await newMember('member', nextIp());
  await check('S1', 'sign-in: success sets the session cookies; wrong password and unknown email return the IDENTICAL response and set no cookie', async () => {
    const jar = new Jar(); const good = await call(APP, '/auth/sign-in', { method: 'POST', jar, ip: nextIp(), json: { email: member.email, password: GOOD_PW } }); ok(good.status === 200 && authCookies(jar).length >= 1, `${good.status}`);
    const jw = new Jar(), ju = new Jar(); const wrong = await call(APP, '/auth/sign-in', { method: 'POST', jar: jw, ip: nextIp(), json: { email: member.email, password: 'definitely not the password' } }); const unknown = await call(APP, '/auth/sign-in', { method: 'POST', jar: ju, ip: nextIp(), json: { email: newEmail('nobody'), password: 'definitely not the password' } });
    ok(wrong.status === 401 && unknown.status === 401 && wrong.text === unknown.text, `${wrong.status}/${unknown.status} bodies equal: ${wrong.text === unknown.text}`); ok(jw.c.size === 0 && ju.c.size === 0, 'cookie on failure');
    ok(!/supabase|gotrue|jwt|token|sql/i.test(wrong.text), 'provider text leaked'); return '401 identical bodies';
  });
  await check('S2', 'sign-in throttling: the 6th attempt for one address+email in the window is 429 with Retry-After AND does not reach the provider; another address is unaffected', async () => {
    const ip = nextIp(), email = newEmail('guess'); const out = []; let providerBefore;
    for (let i = 0; i < 7; i++) { if (i === 5) providerBefore = proxyState.count.token; const r = await call(APP, '/auth/sign-in', { method: 'POST', ip, json: { email, password: 'wrong password ' + i } }); out.push(r.status); if (i === 5) ok(r.res.headers.get('retry-after'), 'no Retry-After'); }
    ok(out.slice(0, 5).every((s) => s === 401) && out[5] === 429 && out[6] === 429, JSON.stringify(out)); ok(proxyState.count.token === providerBefore, 'a throttled attempt reached the provider');
    const other = await call(APP, '/auth/sign-in', { method: 'POST', ip: nextIp(), json: { email, password: 'wrong password' } }); ok(other.status === 401, `other address ${other.status}`);
    return JSON.stringify(out);
  });
  await check('S3', 'cross-origin and origin-less mutations are refused on every auth endpoint', async () => {
    for (const p of ['/auth/sign-in', '/auth/sign-out', '/auth/recovery/request', '/auth/set-password', '/auth/callback/exchange']) for (const o of [{ origin: 'https://evil.example' }, { noOrigin: true }]) { const r = await call(APP, p, { method: 'POST', jar: member.jar, json: { email: 'a@example.test', password: GOOD_PW }, ...o }); ok(r.status === 403, `${p} ${JSON.stringify(o)} -> ${r.status}`); }
    return '10 refusals';
  });

  // ======== session, refresh, concurrency ========
  await check('F1', 'refresh: an expired access token is refreshed by the session endpoint and the rotated cookies work', async () => {
    const jar = new Jar(); await call(APP, '/auth/sign-in', { method: 'POST', jar, ip: nextIp(), json: { email: member.email, password: GOOD_PW } });
    const forged = forgedExpired(jar); const r = await call(APP, '/auth/session', { jar: forged }); ok(r.status === 200 && r.json.state === 'member', `${r.status} ${r.text}`);
    ok(r.res.headers.getSetCookie().length >= 1, 'no rotated cookie was issued'); const v = await call(APP, '/auth/session/verified', { jar: forged }); ok(v.status === 200, `after refresh T2 ${v.status}`); return 'refreshed: member + rotated Set-Cookie + T2 ok';
  });
  await check('F2', 'CONCURRENT refresh: 8 simultaneous requests carrying the same expired session all succeed, and the session is still valid afterwards', async () => {
    const jar = new Jar(); await call(APP, '/auth/sign-in', { method: 'POST', jar, ip: nextIp(), json: { email: member.email, password: GOOD_PW } });
    const tokenBefore = proxyState.count.token; const forged = forgedExpired(jar);
    const rs = await Promise.all(Array.from({ length: 8 }, () => call(APP, '/auth/session', { jar: forged.clone() })));
    const statuses = rs.map((r) => `${r.status}:${r.json?.state}`); ok(rs.every((r) => r.status === 200 && r.json.state === 'member'), statuses.join(' '));
    const withCookies = rs.filter((r) => r.res.headers.getSetCookie().length > 0).length; const refreshes = proxyState.count.token - tokenBefore;
    const best = new Jar(); best.absorb(rs[rs.length - 1].res); ok(best.c.size > 0, 'no cookies on the last response'); const v = await call(APP, '/auth/session/verified', { jar: best }); ok(v.status === 200, `after the race, T2 with the last response's cookies: ${v.status}`);
    const first = new Jar(); first.absorb(rs[0].res); const v0 = await call(APP, '/auth/session/verified', { jar: first }); ok(v0.status === 200, `after the race, T2 with the FIRST response's cookies: ${v0.status}`);
    return `8x 200 member; ${withCookies}/8 issued cookies; ${refreshes} refresh call(s) reached the provider`;
  });
  await check('F4', 'AFTER the provider\'s 10-second reuse interval: a browser that ends up holding ANY response of a concurrent refresh race can still refresh (no accidental revocation of the session family)', async () => {
    const jar = new Jar(); await call(APP, '/auth/sign-in', { method: 'POST', jar, ip: nextIp(), json: { email: member.email, password: GOOD_PW } });
    const forged = forgedExpired(jar); const rs = await Promise.all(Array.from({ length: 6 }, () => call(APP, '/auth/session', { jar: forged.clone() }))); ok(rs.every((r) => r.status === 200), 'race failed');
    await sleep(11_500); const out = [];
    for (const idx of [0, 3, 5]) { const j = new Jar(); j.absorb(rs[idx].res); const again = await call(APP, '/auth/session', { jar: forgedExpired(j) }); const v = await call(APP, '/auth/session/verified', { jar: j }); out.push(`resp#${idx}: refresh ${again.status}/${again.json?.state}, T2 ${v.status}`); ok(again.status === 200 && again.json.state === 'member' && v.status === 200, out.join(' | ')); }
    return out.join(' | ');
  });
  await check('F3', 'sign-out: cookies expired, session revoked at the provider: the OLD cookie still passes the provisional indicator (T1, documented) but is refused at T2 and cannot be refreshed', async () => {
    const jar = new Jar(); await call(APP, '/auth/sign-in', { method: 'POST', jar, ip: nextIp(), json: { email: member.email, password: GOOD_PW } }); const old = jar.clone(); const oldForged = forgedExpired(jar);
    const so = await call(APP, '/auth/sign-out', { method: 'POST', jar, ip: nextIp() }); ok(so.status === 200 && so.json.revoked === true, `${so.status} ${so.text}`);
    ok(authCookies(jar).length === 0 && !jar.c.has('hx_setup'), 'cookies not cleared'); for (const raw of so.res.headers.getSetCookie().filter((c) => /auth-token/.test(c))) ok(/max-age=0/i.test(raw) && /httponly/i.test(raw), raw.slice(0, 80));
    const t1 = await call(APP, '/auth/session', { jar: old }); ok(t1.status === 200 && t1.json.state === 'member', `T1 with the old cookie ${t1.status} ${t1.text}`);
    const t2 = await call(APP, '/auth/session/verified', { jar: old }); ok(t2.status === 401 && t2.json.error.code === 'unauthenticated', `T2 ${t2.status} ${t2.text}`);
    const rf = await call(APP, '/auth/session', { jar: oldForged }); ok(rf.status === 200 && rf.json.state === 'anonymous', `refresh with the revoked session: ${rf.status} ${rf.text}`);
    return 'T1 still member until expiry (documented); T2 401; refresh impossible';
  });

  // ======== recovery ========
  await check('V1', 'recovery request: identical 202 for a member and an unknown address; mail only to the member; per-email limit stops email bombing', async () => {
    await mailClear(); const m = member.email, u = newEmail('ghost');
    const a = await call(APP, '/auth/recovery/request', { method: 'POST', ip: nextIp(), json: { email: m } }); const b = await call(APP, '/auth/recovery/request', { method: 'POST', ip: nextIp(), json: { email: u } });
    ok(a.status === 202 && b.status === 202 && a.text === b.text, `${a.status}/${b.status} equal=${a.text === b.text}`);
    const mails = await mailFor(m); ok(mails.length === 1, `member mails ${mails.length}`); await sleep(800); const ghost = await mailFor(u, 2); ok(ghost.length === 0, 'mail sent to an unknown address');
    // our per-email limit (3 per hour across addresses), shown on an address that is not a member so the provider's own per-user limits do not interfere
    const c = await call(APP, '/auth/recovery/request', { method: 'POST', ip: nextIp(), json: { email: u } }); const d = await call(APP, '/auth/recovery/request', { method: 'POST', ip: nextIp(), json: { email: u } }); const e = await call(APP, '/auth/recovery/request', { method: 'POST', ip: nextIp(), json: { email: u } });
    ok(c.status === 202 && d.status === 202 && e.status === 429 && e.res.headers.get('retry-after') && e.json.error.code === 'rate_limited', `2nd/3rd/4th request for one email across addresses: ${c.status}/${d.status}/${e.status} retry-after ${e.res.headers.get('retry-after')}`); return '202 identical; 1 mail (member only); 4th request for one email from 4 addresses -> 429 with Retry-After';
  });
  await check('V2', 'recovery link: GET does not consume it; exchange -> set-password; old password stops working; replay refused', async () => {
    const email = newEmail('rec'); await mailClear(); const created = await admin.auth.admin.createUser({ email, password: 'initial password 123', email_confirm: true }); ok(!created.error, created.error?.message);
    const rq = await call(APP, '/auth/recovery/request', { method: 'POST', ip: nextIp(), json: { email } }); ok(rq.status === 202, `${rq.status}`);
    const link = await mailLink(email); ok(link && /type=recovery/.test(link), 'no recovery link'); const u = new URL(link); const path = u.pathname + u.search;
    const g1 = await call(APP, path); const g2 = await call(APP, path); ok(g1.status === 200 && g2.status === 200 && /Reset your password/.test(g1.text), 'GET not repeatable');
    const jar = new Jar(); const ex = await call(APP, '/auth/callback/exchange', { method: 'POST', jar, ip: nextIp(), form: { type: 'recovery', token_hash: u.searchParams.get('token_hash'), next: '/lab' } }); ok(ex.status === 303 && /\/auth\/set-password/.test(ex.location), `${ex.status} ${ex.location}`);
    const sp = await call(APP, '/auth/set-password', { method: 'POST', jar, ip: nextIp(), form: { password: 'a brand new password 456', next: '/lab' } }); ok(sp.status === 303 && sp.location === '/lab', `${sp.status} ${sp.location}`);
    const oldPw = await call(APP, '/auth/sign-in', { method: 'POST', ip: nextIp(), json: { email, password: 'initial password 123' } }); ok(oldPw.status === 401, `old password ${oldPw.status}`);
    const newPw = await call(APP, '/auth/sign-in', { method: 'POST', jar: new Jar(), ip: nextIp(), json: { email, password: 'a brand new password 456' } }); ok(newPw.status === 200, `new password ${newPw.status}`);
    const replay = await call(APP, '/auth/callback/exchange', { method: 'POST', jar: new Jar(), ip: nextIp(), form: { type: 'recovery', token_hash: u.searchParams.get('token_hash'), next: '/lab' } }); ok(replay.status === 400 && /already been used/.test(replay.text), `replay ${replay.status}`);
    await admin.auth.admin.deleteUser(created.data.user.id); return 'consumed once; password changed; replay 400';
  });

  // ======== password limits against the INSTALLED provider ========
  await check('W1', 'provider password limits match the module constants: 11 refused, 12 ok, 72 bytes ok, 73 bytes refused, multi-byte counted in bytes, never truncated', async () => {
    const { MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES } = await import('../src/modules/identity/index.ts'); ok(MIN_PASSWORD_LENGTH === 12 && MAX_PASSWORD_BYTES === 72, 'constants changed');
    const tryPw = async (pw) => { const e = newEmail('pw'); const r = await admin.auth.admin.createUser({ email: e, password: pw, email_confirm: true }); if (r.error) return { refused: `${r.error.status}/${r.error.code}` }; const si = await anon().auth.signInWithPassword({ email: e, password: pw }); await admin.auth.admin.deleteUser(r.data.user.id); return { created: true, fullPasswordSignsIn: !si.error }; };
    const t = { eleven: await tryPw('a'.repeat(11)), twelve: await tryPw('a'.repeat(12)), b72: await tryPw('a'.repeat(72)), b73: await tryPw('a'.repeat(73)), m72: await tryPw('é'.repeat(36)), m74: await tryPw('é'.repeat(37)) };
    ok(t.eleven.refused && t.twelve.fullPasswordSignsIn && t.b72.fullPasswordSignsIn && t.b73.refused && t.m72.fullPasswordSignsIn && t.m74.refused, JSON.stringify(t)); return JSON.stringify(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.refused ?? 'ok'])));
  });

  // ======== outages: bounded calls, no downgrade, cookies untouched, drafts preserved ========
  const outMember = new Jar(); await call(APP, '/auth/sign-in', { method: 'POST', jar: outMember, ip: nextIp(), json: { email: member.email, password: GOOD_PW } });
  await check('O1', 'Auth DOWN: a refresh that needs the network gives a retryable 503; the response sets NO cookie (the session is not cleared) and does not redirect; T2 is never served at T1 level; recovery restores everything', async () => {
    const forged = forgedExpired(outMember); proxyState.mode = 'down';
    const r = await call(APP, '/auth/session', { jar: forged.clone() }); ok(r.status === 503 && r.json.error.code === 'unavailable' && r.res.headers.getSetCookie().length === 0 && !r.location, `${r.status} cookies=${r.res.headers.getSetCookie().length} loc=${r.location}`);
    const v = await call(APP, '/auth/session/verified', { jar: outMember.clone() }); ok(v.status === 503 && v.json.error.code === 'unavailable' && v.json.state === undefined, `T2 during outage: ${v.status} ${v.text}`);
    const t1 = await call(APP, '/auth/session', { jar: outMember.clone() }); ok(t1.status === 200 && t1.json.state === 'member', `T1 with a still-valid token and cached keys: ${t1.status} (no network needed)`);
    proxyState.mode = 'pass'; const after = await call(APP, '/auth/session/verified', { jar: outMember.clone() }); ok(after.status === 200, `after recovery ${after.status}`);
    const refreshed = await call(APP, '/auth/session', { jar: forged.clone() }); ok(refreshed.status === 200 && refreshed.json.state === 'member', `the same session still refreshes after the outage: ${refreshed.status}`);
    return 'refresh 503 no Set-Cookie; T2 503; T1 200; all fine after recovery';
  });
  await check('O2', 'sign-in and the callback exchange during an outage: retryable 503; no cookie; the one-time token is not lost by the outage', async () => {
    proxyState.mode = 'down'; const si = await call(APP, '/auth/sign-in', { method: 'POST', jar: new Jar(), ip: nextIp(), json: { email: member.email, password: GOOD_PW } }); ok(si.status === 503 && si.json.error.code === 'unavailable', `sign-in ${si.status}`); proxyState.mode = 'pass';
    const email = newEmail('outinv'); await mailClear(); await admin.auth.admin.inviteUserByEmail(email); const link = await mailLink(email); const u = new URL(link); const f = { type: 'invite', token_hash: u.searchParams.get('token_hash'), next: '/spark' };
    proxyState.mode = 'down'; const jar = new Jar(); const x = await call(APP, '/auth/callback/exchange', { method: 'POST', jar, ip: nextIp(), form: f }); ok(x.status === 503 && jar.c.size === 0, `exchange during the outage ${x.status}`);
    proxyState.mode = 'pass'; const x2 = await call(APP, '/auth/callback/exchange', { method: 'POST', jar, ip: nextIp(), form: f }); ok(x2.status === 303, `the same link works after the outage: ${x2.status}`); return 'sign-in 503; exchange 503 then the same link still works';
  });
  await check('O3', 'SLOW Auth (hangs): calls are bounded: a cold-cache session check (signing-key retrieval) and a T2 check each return 503 within the bound, not after the provider answers', async () => {
    const app2 = startApp(APP2_PORT, APP2); ok(await waitUp(APP2), 'second app did not start');
    try {
      proxyState.mode = 'hang'; proxyState.hangPath = '.well-known/jwks'; proxyState.hangMs = 12_000;
      let t0 = Date.now(); const r = await call(APP2, '/auth/session', { jar: outMember.clone() }); const dt1 = Date.now() - t0; ok(r.status === 503 && dt1 < 4500, `cold JWKS hang: ${r.status} after ${dt1} ms`);
      proxyState.mode = 'pass'; const warm = await call(APP2, '/auth/session', { jar: outMember.clone() }); ok(warm.status === 200, `warm cache ${warm.status}`);
      proxyState.mode = 'hang'; proxyState.hangPath = '/auth/v1/user'; proxyState.hangMs = 12_000;
      t0 = Date.now(); const v = await call(APP2, '/auth/session/verified', { jar: outMember.clone() }); const dt2 = Date.now() - t0; ok(v.status === 503 && dt2 < 4500, `T2 hang: ${v.status} after ${dt2} ms`);
      return `JWKS hang -> 503 in ${dt1} ms; user-check hang -> 503 in ${dt2} ms (bound 3000 ms per call, 5000 ms per request)`;
    } finally { proxyState.mode = 'pass'; proxyState.hangPath = null; app2.p.kill(); }
  });
  await check('O4', 'the member\'s UNSAVED DRAFT survives a failed session verification (real browser): the check returns 503 as data; the page, the textarea and the draft are untouched, no navigation, no reload', async () => {
    const { proc, port } = await launch(9300 + Math.floor(Math.random() * 600));
    try {
      const pg = await newPage(port); await pg.viewport(1100, 800); await pg.goto(`${APP}/spark/demo/meal`); await pg.click('button', 'Adapt in The Lab'); await sleep(1200);
      const si = await pg.ev(`fetch('/auth/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(member.email)}, password: ${JSON.stringify(GOOD_PW)} }) }).then((x) => x.status)`); ok(si === 200, `in-page sign-in ${si}`);
      await pg.type('#fullPrompt', 'MY UNSAVED DRAFT'); await sleep(200); ok((await pg.ev('location.pathname')) === '/lab', 'not on the lab');
      await pg.ev("window.__nav = 0; window.addEventListener('beforeunload', () => { window.__nav++; }); window.__marker = 'same-document'; true");
      proxyState.mode = 'down'; const r = await pg.ev("fetch('/auth/session/verified', { credentials: 'same-origin' }).then(async (x) => ({ status: x.status, redirected: x.redirected, body: await x.text() }))"); proxyState.mode = 'pass';
      ok(r.status === 503 && !r.redirected, `fetch ${r.status}`);
      const after = await pg.ev("({ path: location.pathname, draft: document.querySelector('#fullPrompt').value, marker: window.__marker, nav: window.__nav, dialog: !!document.querySelector('dialog[open]') })");
      ok(after.path === '/lab' && after.draft === 'MY UNSAVED DRAFT' && after.marker === 'same-document' && after.nav === 0 && !after.dialog, JSON.stringify(after)); pg.close(); return 'draft intact, same document, no unload';
    } finally { proxyState.mode = 'pass'; proc.kill(); }
  });


  // ======== FIX 1: recovery cooldowns must not reveal whether an address belongs to a member ========
  await check('X1', 'recovery: the provider\'s own per-user cooldown does not reveal membership: an immediate repeat for a MEMBER answers exactly like an unknown address (202, same body, same headers), and no second mail is sent', async () => {
    const email = newEmail('cool'); await mailClear(); const created = await admin.auth.admin.createUser({ email, password: 'initial password 123', email_confirm: true }); ok(!created.error, created.error?.message);
    const ghost = newEmail('cool-ghost');
    const first = await call(APP, '/auth/recovery/request', { method: 'POST', ip: nextIp(), json: { email } }); ok(first.status === 202, `first ${first.status}`); ok((await mailFor(email)).length === 1, 'first mail missing');
    const repeat = await call(APP, '/auth/recovery/request', { method: 'POST', ip: nextIp(), json: { email } });          // inside the provider's cooldown for this member
    const g1 = await call(APP, '/auth/recovery/request', { method: 'POST', ip: nextIp(), json: { email: ghost } }); const g2 = await call(APP, '/auth/recovery/request', { method: 'POST', ip: nextIp(), json: { email: ghost } });
    const sig = (r) => `${r.status}|${r.text}|${r.res.headers.get('content-type')}|${r.res.headers.get('cache-control')}|${r.res.headers.get('retry-after')}`;
    ok(repeat.status === 202 && sig(repeat) === sig(g1) && sig(g1) === sig(g2), `member repeat ${sig(repeat)} vs unknown ${sig(g1)} / ${sig(g2)}`);
    await sleep(1500); ok((await mailFor(email)).length === 1, 'a second mail was sent inside the cooldown'); await admin.auth.admin.deleteUser(created.data.user.id);
    return 'member repeat == unknown address (status, body, headers); still exactly 1 mail';
  });

  // ======== FIX 2: an email link must never silently switch accounts ========
  await check('X2', 'switching accounts needs explicit confirmation: with a session present the link page says so; the exchange WITHOUT confirmation is refused (409), consumes nothing and leaves the session untouched; WITH confirmation the old session is revoked first and the new one starts', async () => {
    const a = new Jar(); await call(APP, '/auth/sign-in', { method: 'POST', jar: a, ip: nextIp(), json: { email: member.email, password: GOOD_PW } }); const aUser = sessionCookie(a).json.user.id; const aOld = a.clone();
    const email = newEmail('switch'); await mailClear(); const r = await admin.auth.admin.inviteUserByEmail(email); ok(!r.error, r.error?.message); const link = await mailLink(email); const lu = new URL(link); const f = { type: 'invite', token_hash: lu.searchParams.get('token_hash'), next: '/spark' };
    const anonPage = await call(APP, lu.pathname + lu.search); ok(!/confirm_switch/.test(anonPage.text) && /Press the button/.test(anonPage.text), 'anonymous page has a switch notice');
    const page = await call(APP, lu.pathname + lu.search, { jar: a }); ok(/signed in on this browser/.test(page.text) && /name="confirm_switch" value="1"/.test(page.text) && /Sign out and continue/.test(page.text), 'signed-in page lacks the explicit notice/confirmation'); ok(a.header() === aOld.header(), 'GET changed the cookies');
    const before = a.header(); const noConfirm = await call(APP, '/auth/callback/exchange', { method: 'POST', jar: a, ip: nextIp(), form: f });
    ok(noConfirm.status === 409 && /Sign out and continue/.test(noConfirm.text), `no confirmation: ${noConfirm.status}`); ok(a.header() === before && noConfirm.res.headers.getSetCookie().length === 0, 'the session was touched without confirmation');
    const stillA = await call(APP, '/auth/session/verified', { jar: a }); ok(stillA.status === 200, `A after the refused exchange ${stillA.status}`);
    const confirmed = await call(APP, '/auth/callback/exchange', { method: 'POST', jar: a, ip: nextIp(), form: { ...f, confirm_switch: '1' } }); ok(confirmed.status === 303 && /set-password/.test(confirmed.location), `confirmed: ${confirmed.status} (the token was NOT consumed by the refused attempt)`);
    const bUser = sessionCookie(a).json.user.id; ok(bUser !== aUser, 'the session is still A');
    const oldT2 = await call(APP, '/auth/session/verified', { jar: aOld }); ok(oldT2.status === 401, `A's old session after the switch: T2 ${oldT2.status}`);
    return 'notice shown; unconfirmed -> 409, nothing consumed or changed; confirmed -> A revoked, B signed in';
  });
  await check('X2b', 'the same protection for a RECOVERY link opened while signed in as someone else: unconfirmed -> 409, link not consumed, A untouched; confirmed -> A revoked, the link\'s owner signs in', async () => {
    const a = new Jar(); await call(APP, '/auth/sign-in', { method: 'POST', jar: a, ip: nextIp(), json: { email: member.email, password: GOOD_PW } }); const aUser = sessionCookie(a).json.user.id; const aOld = a.clone();
    const bEmail = newEmail('recswitch'); await mailClear(); const created = await admin.auth.admin.createUser({ email: bEmail, password: 'initial password 123', email_confirm: true }); ok(!created.error, created.error?.message);
    ok((await call(APP, '/auth/recovery/request', { method: 'POST', ip: nextIp(), json: { email: bEmail } })).status === 202, 'recovery request'); const lu = new URL(await mailLink(bEmail)); ok(lu.searchParams.get('type') === 'recovery', 'not a recovery link'); const f = { type: 'recovery', token_hash: lu.searchParams.get('token_hash'), next: '/spark' };
    const page = await call(APP, lu.pathname + lu.search, { jar: a }); ok(/signed in on this browser/.test(page.text) && /name="confirm_switch" value="1"/.test(page.text), 'no explicit notice');
    const before = a.header(); const refused = await call(APP, '/auth/callback/exchange', { method: 'POST', jar: a, ip: nextIp(), form: f }); ok(refused.status === 409 && refused.res.headers.getSetCookie().length === 0 && a.header() === before, `unconfirmed ${refused.status}`);
    ok((await call(APP, '/auth/session/verified', { jar: a })).status === 200, 'A was disturbed by the refusal');
    const ok2 = await call(APP, '/auth/callback/exchange', { method: 'POST', jar: a, ip: nextIp(), form: { ...f, confirm_switch: '1' } }); ok(ok2.status === 303 && /set-password/.test(ok2.location), `confirmed ${ok2.status} (the refused attempt did not consume the link)`);
    ok(sessionCookie(a).json.user.id !== aUser, 'still A'); ok((await call(APP, '/auth/session/verified', { jar: aOld })).status === 401, 'A\'s old session still valid'); await admin.auth.admin.deleteUser(created.data.user.id);
    return 'unconfirmed 409 (link intact, A untouched); confirmed: A revoked, link owner signed in';
  });
  await check('X3', 'a confirmed switch during an outage stops BEFORE the one-time token is consumed: 503, cookies untouched, and the same link still works afterwards', async () => {
    const a = new Jar(); await call(APP, '/auth/sign-in', { method: 'POST', jar: a, ip: nextIp(), json: { email: member.email, password: GOOD_PW } });
    const email = newEmail('switchout'); await mailClear(); await admin.auth.admin.inviteUserByEmail(email); const lu = new URL(await mailLink(email)); const f = { type: 'invite', token_hash: lu.searchParams.get('token_hash'), next: '/spark', confirm_switch: '1' };
    const before = a.header(); proxyState.mode = 'down'; const r = await call(APP, '/auth/callback/exchange', { method: 'POST', jar: a, ip: nextIp(), form: f }); proxyState.mode = 'pass';
    ok(r.status === 503 && r.res.headers.getSetCookie().length === 0 && a.header() === before, `outage: ${r.status} cookies=${r.res.headers.getSetCookie().length}`);
    const again = await call(APP, '/auth/callback/exchange', { method: 'POST', jar: a, ip: nextIp(), form: f }); ok(again.status === 303, `the link after the outage: ${again.status}`); return '503, cookies untouched, link intact';
  });

  // ======== FIX 3: the 8 KiB body limit is enforced while streaming, with a deadline ========
  const rawPost = (path, { headers = {}, write }) => new Promise((resolve) => {
    const t0 = Date.now(); const req = http.request({ host: 'localhost', port: APP_PORT, path, method: 'POST', headers: { origin: APP, 'x-test-client-ip': nextIp(), ...headers } }, (res) => { let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, ms: Date.now() - t0, body, headers: res.headers }); }); });
    req.on('error', () => {}); write(req);
  });
  await check('B1', 'streaming limit: an oversize CHUNKED upload (no Content-Length) gets 413 promptly, the server stops reading, and nothing reaches the provider', async () => {
    const before = proxyState.count.token; let sent = 0; const res = await rawPost('/auth/sign-in', { headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, write: (req) => { const chunk = Buffer.alloc(16 * 1024, 97); let n = 0; const go = () => { if (n++ >= 256 || req.destroyed) return; sent += chunk.length; if (req.write(chunk)) setImmediate(go); else req.once('drain', go); }; req.write('{"email":"'); go(); } });
    ok(res.status === 413 && res.ms < 2500, `${res.status} after ${res.ms} ms`); ok(/payload_too_large/.test(res.body), res.body.slice(0, 100)); ok(/close/i.test(res.headers?.connection ?? 'close'), 'connection not closed'); ok(proxyState.count.token === before, 'the provider was called'); ok(sent < 4 * 1024 * 1024, `the client managed to push ${sent} bytes (offered 4 MiB)`);
    return `413 in ${res.ms} ms; client could push ${Math.round(sent / 1024)} KiB of the 4096 KiB offered`;
  });
  await check('B2', 'deadline: an upload that stalls (sends 10 bytes, then nothing) or drips is answered 408 at about the 3 s deadline, not held open', async () => {
    const res = await rawPost('/auth/recovery/request', { headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, write: (req) => { req.write('{"email":"'); setTimeout(() => { try { req.write('a'); } catch {} }, 8000); } });
    ok(res.status === 408 && res.ms >= 2500 && res.ms < 5000, `${res.status} after ${res.ms} ms`);
    const drip = await rawPost('/auth/sign-in', { headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, write: (req) => { let i = 0; const t = setInterval(() => { if (req.destroyed || i++ > 60) { clearInterval(t); return; } req.write('x'); }, 200); } });
    ok(drip.status === 408 && drip.ms < 5000, `drip ${drip.status} after ${drip.ms} ms`); return `stall -> 408 after ${res.ms} ms; 1 byte/200 ms drip -> 408 after ${drip.ms} ms`;
  });
  await check('B3', 'body validation: declared oversize (Content-Length) is 413 with nothing read; missing or wrong Content-Type is 415; invalid UTF-8 and malformed JSON are 400; a small valid body still works', async () => {
    const big = await call(APP, '/auth/sign-in', { method: 'POST', ip: nextIp(), json: { email: 'a@example.test', password: 'x'.repeat(9000) } }); ok(big.status === 413 && big.json.error.code === 'payload_too_large', `declared oversize ${big.status}`);
    const noType = await call(APP, '/auth/sign-in', { method: 'POST', ip: nextIp(), headers: {} }); ok(noType.status === 415, `no content-type ${noType.status}`);
    const text = await call(APP, '/auth/recovery/request', { method: 'POST', ip: nextIp(), headers: { 'content-type': 'text/plain' } }); ok(text.status === 415, `text/plain ${text.status}`);
    const bad = await rawPost('/auth/recovery/request', { headers: { 'content-type': 'application/json', 'content-length': '3' }, write: (req) => req.end(Buffer.from([0xff, 0xfe, 0x41])) }); ok(bad.status === 400, `invalid utf-8 ${bad.status}`);
    const junk = await rawPost('/auth/recovery/request', { headers: { 'content-type': 'application/json', 'content-length': '5' }, write: (req) => req.end('{nope') }); ok(junk.status === 400, `malformed json ${junk.status}`);
    const fine = await call(APP, '/auth/recovery/request', { method: 'POST', ip: nextIp(), json: { email: newEmail('small') } }); ok(fine.status === 202, `valid small body ${fine.status}`);
    const html = await call(APP, '/auth/set-password', { method: 'POST', ip: nextIp(), form: { password: 'a'.repeat(9000) } }); ok(html.status === 413 && /too large/.test(html.text), `set-password page ${html.status}`);
    return '413 / 415 / 415 / 400 / 400 / 202 / 413(page)';
  });

  // ======== FIX 4: unknown or unavailable provider failures are retryable 503, never revocation ========
  await check('U1', 'an UNKNOWN provider failure (HTTP 400, unrecognised code) is a retryable 503 everywhere, never a 401, never "expired", never a cleared session; the same session and the same link work afterwards', async () => {
    const jar = new Jar(); await call(APP, '/auth/sign-in', { method: 'POST', jar, ip: nextIp(), json: { email: member.email, password: GOOD_PW } });
    const forged = forgedExpired(jar);
    proxyState.mode = 'weird'; proxyState.weirdPath = '/auth/v1/user'; const t2 = await call(APP, '/auth/session/verified', { jar: jar.clone() }); ok(t2.status === 503 && t2.json.error.code === 'unavailable', `T2 with an unknown user-check failure: ${t2.status} ${t2.text.slice(0, 80)}`);
    proxyState.weirdPath = '/auth/v1/token'; const rf = await call(APP, '/auth/session', { jar: forged.clone() }); ok(rf.status === 503 && rf.res.headers.getSetCookie().length === 0, `refresh with an unknown token-endpoint failure: ${rf.status} cookies=${rf.res.headers.getSetCookie().length}`);
    const si = await call(APP, '/auth/sign-in', { method: 'POST', ip: nextIp(), json: { email: member.email, password: GOOD_PW } }); ok(si.status === 503 && si.json.error.code === 'unavailable', `sign-in with an unknown failure: ${si.status} (must not read as wrong credentials)`);
    const email = newEmail('weird'); proxyState.mode = 'pass'; await mailClear(); await admin.auth.admin.inviteUserByEmail(email); const lu = new URL(await mailLink(email)); const f = { type: 'invite', token_hash: lu.searchParams.get('token_hash'), next: '/spark' };
    proxyState.mode = 'weird'; proxyState.weirdPath = '/auth/v1/verify'; const ex = await call(APP, '/auth/callback/exchange', { method: 'POST', jar: new Jar(), ip: nextIp(), form: f }); const DEFINITIVE = /This link has expired|expired or has already been used\.|used up/i; /* PX-2c wording: the 503 page may say "If the link has expired or was already used, request a new one" (conditional); it must never STATE the link is expired */ ok(ex.status === 503 && !DEFINITIVE.test(ex.text), `exchange with an unknown failure: ${ex.status} ${DEFINITIVE.test(ex.text) ? 'SHOWN AS EXPIRED' : ''}`);
    proxyState.mode = 'pass'; proxyState.weirdPath = null;
    const after = await call(APP, '/auth/session/verified', { jar: jar.clone() }); ok(after.status === 200, `the same session afterwards: ${after.status}`);
    const refreshed = await call(APP, '/auth/session', { jar: forged.clone() }); ok(refreshed.status === 200 && refreshed.json.state === 'member', `the same expired session still refreshes: ${refreshed.status}`);
    const ex2 = await call(APP, '/auth/callback/exchange', { method: 'POST', jar: new Jar(), ip: nextIp(), form: f }); ok(ex2.status === 303, `the same link afterwards: ${ex2.status}`);
    return 'T2 503; refresh 503 w/o cookie change; sign-in 503; exchange 503 (not "expired"); session, refresh and link all fine afterwards';
  });

  // ======== logs ========
  await check('L1', 'logs: no token, link parameter, password, cookie value or email address appears in the app\'s output; the app logged events by name only', async () => {
    const out = app.log.text; ok(out.length > 0, 'the app produced no log output'); const tok = (j) => { try { const c = sessionCookie(j).json; return [c.access_token, c.refresh_token]; } catch { return []; } };
    const needles = [GOOD_PW, 'a brand new password 456', 'initial password 123', 'px2b-', '@example.test', 'token_hash=', 'hx_setup=', 'sb-127-auth-token=', 'Set-Cookie', inv.tokenHash, inv.email, ...tok(member.jar), ...tok(outMember), ...tok(inv.jar)].filter(Boolean);
    for (const n of needles) { if (out.includes(n)) { const line = out.split('\n').find((l) => l.includes(n)) || ''; throw new Error(`the log contains ${JSON.stringify(n.slice(0, 20))} in: ${line.replace(/eyJ[A-Za-z0-9_.-]+/g, '[jwt]').slice(0, 260)}`); } } ok(!/eyJ[A-Za-z0-9_-]{10,}\./.test(out), 'a JWT-shaped string is in the log');
    const events = [...out.matchAll(/"event":"([a-z_]+)"/g)].map((m) => m[1]); const set = [...new Set(events)]; ok(set.some((e) => e.startsWith('auth_')), `no auth events logged (${set.join(',')})`); return `${out.split('\n').filter(Boolean).length} lines; events: ${set.join(', ')}`;
  });
} finally { if (process.env.LOGDUMP) console.log('---- app log (scrubbed) ----\n' + app.log.text.replace(/eyJ[A-Za-z0-9_.-]+/g, '[jwt]').replace(/[A-Za-z0-9_-]{40,}/g, '[long]')); app.p.kill(); proxy.close(); }
console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
