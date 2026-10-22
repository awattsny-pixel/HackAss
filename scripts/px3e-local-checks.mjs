#!/usr/bin/env node
// PX-3e local checks: the private-preview gate on REAL built servers (route allowlist, legacy blocking, headers, health, robots, environment validation), and proof that
// the working protections are unchanged. Local only; nothing hosted is contacted.
//   node scripts/px2b-pilot.mjs up ; APP_ENV=local npx next build ; NEXT_DIST_DIR=.next-gate PREVIEW_GATE=on APP_ENV=local npx next build ; node --conditions=react-server scripts/px3e-local-checks.mjs
// The gate is compiled into the BUILD (next.config.js), so two builds are used: `.next-gate` (NEXT_DIST_DIR=.next-gate PREVIEW_GATE=on APP_ENV=local npx next build) and `.next` (local development,
// open: build it with APP_ENV=local; a build with APP_ENV unset or invalid fails CLOSED into a gated build). It starts four servers with throwaway secrets: gate ON, gate OPEN, gate ON with a forbidden variable (health must say "not ready"), and the OPEN build run with the preview environment
// (health must say "not ready": a preview environment must never serve a build without the gate). The Supabase URL is the local pilot stack's; no check needs a session.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { decidePath } from '../src/platform/preview-gate.ts';

const SUPABASE = process.env.SUPABASE_BIN || 'supabase';
const st = spawnSync(SUPABASE, ['status', '--workdir', 'supabase-pilot', '-o', 'json'], { encoding: 'utf8', timeout: 60_000 });
let cfg; try { cfg = JSON.parse(st.stdout.slice(st.stdout.indexOf('{'))); } catch { console.error('BLOCKED  the pilot stack is not running'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRETS = { CURSOR_SIGNING_SECRET: randomBytes(32).toString('base64url'), AUTH_THROTTLE_SECRET: randomBytes(32).toString('base64url'), AUTH_SETUP_MARKER_SECRET: randomBytes(32).toString('base64url') };
const TOKEN = `px3e-token-${randomBytes(6).toString('hex')}`;
// assembled at run time so this file holds no literal credential-shaped value (the repository's secret scan would flag it)
const FAKE_SERVICE_VALUE = ['THE', 'SECRET', 'VALUE', randomBytes(12).toString('hex')].join('-');
const procs = [];
function start(port, extra = {}) {
  const env = { ...process.env, ...SECRETS, APP_ENV: 'local', APP_ORIGIN: `http://localhost:${port}`, NEXT_PUBLIC_SUPABASE_URL: cfg.API_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: cfg.PUBLISHABLE_KEY, TRUSTED_CLIENT_IP_HEADER: 'x-test-client-ip', NODE_ENV: 'production', ...extra };
  for (const k of ['PREVIEW_GATE']) if (!(k in extra)) delete env[k];
  const p = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = { text: '' }; p.stdout.on('data', (d) => { log.text += d; }); p.stderr.on('data', (d) => { log.text += d; });
  const rec = { p, log, base: `http://localhost:${port}` }; procs.push(rec); return rec;
}
async function up(rec) { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${rec.base}/robots.txt`)).status) return true; } catch { /* not yet */ } await sleep(400); } return false; }

let failed = 0; const results = [];
async function check(id, title, fn) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(id)) return;
  try { const facts = await fn(); results.push({ id, ok: true }); console.log(`PASS  ${id}  ${title}${facts ? `  [${facts}]` : ''}`); }
  catch (e) { failed++; results.push({ id, ok: false }); console.log(`FAIL  ${id}  ${title}  -> ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m); };
const get = (base, path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });

const GATE_DIR = { NEXT_DIST_DIR: '.next-gate' };
// the origin-lock build: NEXT_DIST_DIR=.next-lock PREVIEW_GATE=on APP_ENV=local EDGE_LOCK_SECRET=<the value below> npx next build   (the secret is compiled into the build, so it is fixed here and is not a credential)
const LOCK_SECRET = ['lock', 'secret', 'for', 'the', 'local', 'px3e', 'check', 'only', '0123456789'].join('-');
const gate = start(3104, { PREVIEW_GATE: 'on', ...GATE_DIR }), open = start(3105), bad = start(3106, { PREVIEW_GATE: 'on', ...GATE_DIR, SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_VALUE }), mismatch = start(3107, { PREVIEW_GATE: 'on' }), locked = start(3108, { PREVIEW_GATE: 'on', NEXT_DIST_DIR: '.next-lock' });
try {
  if (!(await up(gate)) || !(await up(open)) || !(await up(bad)) || !(await up(mismatch)) || !(await up(locked))) { console.error('BLOCKED  an app did not start (run `npx next build` first)'); process.exitCode = 2; throw new Error('blocked'); }
  const G = gate.base;
  // base headers on every response; the page-only set (CSP, framing, referrer) everywhere except /auth/**, whose routes own those headers
  const hasHeaders = (res, { auth = false, https = false } = {}) => {
    for (const n of ['x-robots-tag', 'x-content-type-options', 'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy']) ok(res.headers.get(n), `missing ${n}`);
    ok(res.headers.get('x-robots-tag') === 'noindex, nofollow, noarchive', `x-robots-tag "${res.headers.get('x-robots-tag')}"`); ok(res.headers.get('x-content-type-options') === 'nosniff', 'nosniff');
    ok(Boolean(res.headers.get('strict-transport-security')) === https, `hsts ${res.headers.get('strict-transport-security')}`);
    if (!auth) { ok(res.headers.get('x-frame-options') === 'DENY', 'x-frame-options'); ok(res.headers.get('referrer-policy') === 'same-origin', `referrer-policy "${res.headers.get('referrer-policy')}" (a duplicate would be comma-joined)`); const csp = res.headers.get('content-security-policy'); ok(csp && csp.startsWith("default-src 'self'") && csp.includes("frame-ancestors 'none'") && !csp.includes(','), `csp ${csp}`); }
  };

  await check('G1', 'the legacy pages, legacy API, registration page and everything else outside the allowlist are refused with ONE uniform 404 that carries the headers and no detail', async () => {
    const paths = ['/browse', '/categories', '/hack/12', '/profile/x', '/submit', '/admin', '/top-creators', '/manifesto', '/states', '/auth/login', '/auth/signup', '/api/hacks', '/api/hacks/1', '/api/users/x', '/api/auth/login', '/api/auth/signup', '/api/admin/hacks', '/api/me/profile', '/work', '/spark/other', '/account', '/package.json', '/.env', '/favicon.ico', '/hack/other.png'];
    let body = null;
    for (const p of paths) for (const [m, init] of [['GET', {}], ['POST', { method: 'POST', headers: { origin: G, 'content-type': 'application/json' }, body: '{}' }], ['DELETE', { method: 'DELETE', headers: { origin: G } }]]) {
      const r = await get(G, `${p}?x=${TOKEN}`, init); const t = await r.text();
      ok(r.status === 404, `${m} ${p}: ${r.status}`); hasHeaders(r, { auth: p.startsWith('/auth/') }); ok(r.headers.get('cache-control') === 'no-store', `${m} ${p}: cache-control "${r.headers.get('cache-control')}"`); body = body ?? t; ok(t === body && t === 'Not found', `${m} ${p}: body differs`);
    }
    return `${paths.length} paths × 3 methods: identical 404`;
  });
  await check('G2', 'every route the preview serves is reachable: pages 200, JSON routes answer for themselves (401 without a session), the same-origin check still refuses foreign and missing Origin', async () => {
    for (const p of ['/spark', '/lab', '/reveal', '/account/sign-in', '/account/recover', '/account/prompts', '/account/results', '/account/prompts/x', '/account/results/x', '/spark/demo', '/spark/demo/meal']) { const r = await get(G, p); ok(r.status === 200, `${p}: ${r.status}`); hasHeaders(r); }
    { const a = await get(G, '/auth/session'); ok(a.status === 200, '/auth/session'); hasHeaders(a, { auth: true }); }
    for (const p of ['/work/prompts', '/work/results', '/work/export?kind=summary', '/work/prompts/x', '/work/results/x', '/auth/session/verified']) { const r = await get(G, p); ok(r.status === 401, `${p}: ${r.status}`); hasHeaders(r, { auth: p.startsWith('/auth/') }); }
    for (const [p, m] of [['/work/prompts', 'POST'], ['/work/saves', 'POST'], ['/auth/sign-in', 'POST'], ['/auth/sign-out', 'POST'], ['/auth/set-password', 'POST'], ['/auth/callback/exchange', 'POST'], ['/auth/recovery/request', 'POST']]) {
      for (const h of [{ origin: 'https://evil.example' }, {}]) { const r = await get(G, p, { method: m, headers: { 'content-type': 'application/json', ...h }, body: '{}' }); ok(r.status === 403, `${m} ${p} ${JSON.stringify(h)}: ${r.status}`); }
    }
    return 'pages 200; private routes 401; foreign and missing Origin 403';
  });
  await check('G3', '/ redirects (307) to /spark on the same host; the redirect is a config rule, not a request-reading proxy', async () => {
    const r = await get(G, '/?token_hash=abc'); ok(r.status === 307 && new URL(r.headers.get('location'), G).pathname === '/spark', `${r.status} ${r.headers.get('location')}`); ok((await get(G, '/', { method: 'HEAD' })).status === 307, 'HEAD'); const f = await fetch(G + '/'); ok(f.status === 200 && new URL(f.url).pathname === '/spark', `followed: ${f.status} ${f.url}`); return '307 → /spark → 200';
  });
  await check('G4', 'headers: exact single values on a page, a JSON route, a refusal, a static chunk, the artwork and the optimizer; the email-link pages keep their OWN stricter CSP/framing/referrer (not replaced, not duplicated); no HSTS over HTTP', async () => {
    const page = await (await get(G, '/lab')).text(); const chunk = page.match(/\/_next\/static\/[^"']+\.(?:js|css)/)?.[0]; ok(chunk, 'a static chunk URL in the page');
    for (const p of ['/lab', '/browse', chunk, '/hack/hack-official.png', '/_next/image?url=%2Fhack%2Fhack-official.png&w=96&q=75', '/robots.txt', '/health']) { const r = await get(G, p); ok(r.status !== 404 || p === '/browse', `${p}: ${r.status}`); hasHeaders(r, { auth: p.startsWith('/_next/image') }); }   // the image optimizer sets its own CSP (script-src none; sandbox)
    const cb = await get(G, '/auth/callback?type=invite&token_hash=abc'); hasHeaders(cb, { auth: true }); const h = cb.headers; ok(/no-store/.test(h.get('cache-control')) && h.get('referrer-policy') === 'same-origin' && h.get('x-frame-options') === 'DENY' && h.get('content-security-policy').startsWith("default-src 'none'") && !h.get('content-security-policy').includes("default-src 'self'") && !h.get('content-security-policy').includes(','), `email-link page headers: ${h.get('content-security-policy')} | ${h.get('referrer-policy')}`);
    return 'one value per header everywhere; the email-link page keeps default-src none';
  });
  await check('G5', 'the image optimizer serves only the preview\'s own artwork: remote, internal and traversal URLs are refused', async () => {
    ok((await get(G, '/_next/image?url=%2Fhack%2Fhack-official.png&w=96&q=75')).status === 200, 'own artwork');
    for (const u of ['https://evil.example/x.png', 'http://169.254.169.254/latest', '//evil.example/x.png', '/hack/../../etc/passwd', '/hack/other.png', '/']) { const r = await get(G, `/_next/image?url=${encodeURIComponent(u)}&w=96&q=75`); ok(r.status === 404, `${u}: ${r.status}`); }
    return 'own artwork 200; 6 other URLs 404';
  });
  await check('G6', 'robots.txt disallows everything; /health reports readiness, the built gate mode and a stable process id without any variable name or value; an invalid environment, or a preview environment on a build without the gate, is "not ready" (503)', async () => {
    const rt = await (await get(G, '/robots.txt')).text(); ok(/User-Agent: \*/i.test(rt) && /Disallow: \//.test(rt), rt);
    const ids = new Set(); for (let i = 0; i < 5; i++) { const r = await get(G, '/health'); const j = await r.json(); ok(r.status === 200 && j.ready === true && j.status === 'ok' && j.gate === 'preview', JSON.stringify(j)); ok(Object.keys(j).sort().join() === 'boot,gate,lock,ready,status', 'only status, ready, gate, lock, boot'); ids.add(j.boot); } ok(ids.size === 1, `process id changed: ${ids.size}`);
    const b = await get(bad.base, '/health'); const t = await b.text(); ok(b.status === 503 && JSON.parse(t).ready === false, `${b.status} ${t}`); ok(!/SERVICE_ROLE/.test(t) && !t.includes(FAKE_SERVICE_VALUE), 'health leaked a name or value'); ok(b.headers.get('x-robots-tag') === 'noindex, nofollow, noarchive', 'headers on 503 too');
    const mm = await get(mismatch.base, '/health'); const mj = await mm.json(); ok(mm.status === 503 && mj.ready === false && mj.gate === 'open', `a preview environment on a build without the gate must not be ready: ${mm.status} ${JSON.stringify(mj)}`);
    const og = await get(open.base, '/health'); ok(og.status === 200 && (await og.json()).gate === 'open', 'open build in local development is ready');
    return 'ready:true, one boot id; invalid env → 503; preview env on an open build → 503';
  });
  await check('G7', 'the gate never reads or logs the emailed-link token: a callback request carrying a token in the query (allowed path and refused path) leaves it out of the app\'s output', async () => {
    const a = await get(G, `/auth/callback?type=invite&token_hash=${TOKEN}&next=%2Flab`); ok(a.status === 200, `callback ${a.status}`); const b = await get(G, `/admin?token_hash=${TOKEN}`); ok(b.status === 404, 'refused');
    await sleep(500); ok(!gate.log.text.includes(TOKEN), 'the token appears in the application output'); return 'token absent from the log';
  });
  await check('G8', 'path tricks never reach a legacy page or leak content: case variants (matching is case-insensitive in Next.js, so an allowed path in another case is a plain Next 404), double slash, encoded slashes and dots, trailing slash', async () => {
    for (const p of ['/Lab', '/LAB', '//lab', '/%2e%2e/admin', '/lab%2F', '/..%2Fadmin', '/api/../api/hacks', '/hack/hack-official.png/../../hack/1', '/work/prompts/%2e%2e/%2e%2e/api/hacks']) { const r = await get(G, p); ok([404, 308, 307, 400].includes(r.status), `${p}: ${r.status}`); if (r.status === 308 || r.status === 307) { const loc = r.headers.get('location'); ok(loc !== null, `${p}: redirect without Location`); const u = new URL(loc, G); ok(u.origin === new URL(G).origin, `${p}: redirect leaves the origin: ${u.origin}`); ok(decidePath('GET', u.pathname, u.searchParams).kind === 'allow', `${p}: redirect target ${u.pathname} is not an allowed path`); } }
    const t = await get(G, '/lab/'); ok(t.status === 308 && new URL(t.headers.get('location'), G).pathname === '/lab', `/lab/: ${t.status} ${t.headers.get('location')}`); return 'no variant reached a legacy page';
  });
  await check('G9', 'local development is unchanged: with the gate open the legacy routes are reachable and no preview headers are added', async () => {
    const r = await get(open.base, '/browse'); ok(r.status !== 404, `/browse: ${r.status}`); ok(!r.headers.get('content-security-policy') && !r.headers.get('x-robots-tag'), 'headers added while open');
    const a = await get(open.base, '/auth/session'); ok(a.status === 200 && !a.headers.get('x-robots-tag'), 'auth route unchanged'); return 'open mode: legacy reachable, no headers';
  });
  await check('G10', 'scripts/check-env.mjs: a valid private-preview environment passes; each forbidden name, a missing secret and an unset APP_ENV fail by NAME, never by value', async () => {
    const run = (env) => spawnSync(process.execPath, ['scripts/check-env.mjs'], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
    const good = { APP_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://p.example.test', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: cfg.PUBLISHABLE_KEY, APP_ORIGIN: 'https://pilot.example.test', ...SECRETS, TRUSTED_PROXY_HOPS: '1', EDGE_LOCK_SECRET: LOCK_SECRET };
    const g = run(good); ok(g.status === 0 && /environment OK \(gate: preview\)/.test(g.stdout), g.stdout + g.stderr);
    for (const [name, val] of [['SUPABASE_SERVICE_ROLE_KEY', 'VALUE-1'], ['SUPABASE_URL', 'https://x.example.test'], ['WORKER_DATABASE_URL', 'VALUE-2'], ['DATABASE_URL', 'VALUE-3'], ['JOB_ENDPOINT_SECRET', 'V'.repeat(40)]]) { const r = run({ ...good, [name]: val }); ok(r.status === 1 && r.stderr.includes(name) && !(r.stdout + r.stderr).includes(val), `${name}: ${r.status} ${r.stderr}`); }
    { const r = run({ ...good, EDGE_LOCK_SECRET: 'short and has spaces' }); ok(r.status === 1 && r.stderr.includes('EDGE_LOCK_SECRET') && !r.stderr.includes('short and has spaces'), 'malformed lock'); }
    for (const drop of ['AUTH_THROTTLE_SECRET', 'AUTH_SETUP_MARKER_SECRET', 'TRUSTED_PROXY_HOPS', 'APP_ENV', 'EDGE_LOCK_SECRET']) { const e = { ...good }; delete e[drop]; const r = run(e); ok(r.status === 1, `${drop} missing: ${r.status}`); }
    return 'valid → 0; 5 forbidden names, a malformed lock and 5 missing values → 1, names only';
  });
  await check('G11', 'ORIGIN LOCK (a build with the edge secret): without the exact edge header EVERYTHING except /health answers the uniform 404 (any method); with it the app works; a wrong, partial, extended or empty value is refused; the secret is never logged', async () => {
    const L = locked.base, H = { 'x-hackass-edge': LOCK_SECRET };
    for (const p of ['/lab', '/spark', '/account/sign-in', '/auth/session', '/auth/callback?type=invite&token_hash=abc', '/work/prompts', '/robots.txt', '/mascot.png', '/browse', '/api/hacks']) { const r = await get(L, p); ok(r.status === 404 && (await r.text()) === 'Not found', `without the header ${p}: ${r.status}`); }
    for (const m of ['POST', 'PUT', 'DELETE']) { const r = await get(L, '/work/prompts', { method: m, headers: { origin: L, 'content-type': 'application/json' }, body: m === 'DELETE' ? undefined : '{}' }); ok(r.status === 404, `${m} without the header: ${r.status}`); }
    const page = await get(L, '/lab', { headers: H }); ok(page.status === 200, `with the header /lab: ${page.status}`); const html = await page.text(); const chunk = html.match(/\/_next\/static\/[^"']+\.(?:js|css)/)?.[0]; ok(chunk, 'a chunk URL');
    for (const p of [chunk, '/robots.txt', '/mascot.png', '/auth/session', '/work/prompts', '/_next/image?url=%2Fhack%2Fhack-official.png&w=96&q=75']) { const r = await get(L, p, { headers: H }); ok(r.status !== 404 || p === '/mascot.png', `with the header ${p}: ${r.status}`); }
    ok((await get(L, '/work/prompts', { headers: H })).status === 401, 'private route answers for itself'); ok((await get(L, '/browse', { headers: H })).status === 404, 'a legacy path stays refused even with the header');
    for (const bad of [LOCK_SECRET.slice(0, -1), LOCK_SECRET + 'x', 'x' + LOCK_SECRET, '', LOCK_SECRET.toUpperCase(), 'wrong-' + LOCK_SECRET]) { const r = await get(L, '/lab', { headers: { 'x-hackass-edge': bad } }); ok(r.status === 404, `a wrong value "${bad.slice(0, 10)}…": ${r.status}`); }
    const h = await get(L, '/health'); const j = await h.json(); ok(h.status === 200 && j.ready === true && j.lock === 'on' && j.gate === 'preview', `/health without the header: ${h.status} ${JSON.stringify(j)}`);
    const root = await get(L, '/'); ok(root.status === 404 && (await root.text()) === 'Not found', `/ without the header is refused like every other path: ${root.status}`);
    const rootH = await get(L, '/', { headers: H, redirect: 'manual' }); ok(rootH.status === 307 && rootH.headers.get('location')?.endsWith('/spark'), `/ with the header redirects to /spark: ${rootH.status} ${rootH.headers.get('location')}`);
    const art = await get(L, '/hack/hack-official.png', { headers: H }); ok(art.status === 200 && art.headers.get('content-type') === 'image/png', `the artwork is served directly with the header (the pages load it unoptimized): ${art.status} ${art.headers.get('content-type')}`); await sleep(400); ok(!locked.log.text.includes(LOCK_SECRET), 'the lock secret appears in the application output');
    const g = await get(gate.base, '/health'); ok((await g.json()).lock === 'off', 'a build without the lock reports lock off');
    return 'no header → 404 on 10 paths × methods; header → works; 6 wrong values → 404; /health exempt; secret not logged';
  });
} finally { for (const r of procs) { try { process.kill(r.p.pid, 'SIGTERM'); } catch { /* gone */ } } }
console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : process.exitCode ?? 0);
