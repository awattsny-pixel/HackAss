#!/usr/bin/env node
// PX-3b local integration checks: the real saved-work handlers (/work/**) of this app against the REAL local pilot stack (Auth, PostgREST, the PX-3a database
// functions) with TWO members. Local only; nothing hosted is contacted.
//   1. node scripts/px2b-pilot.mjs up        (the separate local pilot stack, with the PX-3a migrations applied)
//   2. npx next build                         (once, after any change)
//   3. node --conditions=react-server scripts/px3b-local-checks.mjs
// The script starts the app itself (port 3102, throwaway secrets generated in memory), puts a small fault-injecting proxy between the app and Auth, signs two
// test members in through the app's own /auth/sign-in, and prints facts and PASS/FAIL only. The service key (read from the local stack) is used ONLY by this
// test to create and delete the two members; the application never receives it. Direct SQL (docker exec psql) is used only to COUNT rows and to flip an
// account status for the guard check. Exit 0 all passed, 1 a check failed, 2 stack or app unreachable.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const SUPABASE = process.env.SUPABASE_BIN || 'supabase';
const DOCKER = process.env.DOCKER_BIN || '/Applications/Docker.app/Contents/Resources/bin/docker';
const DB = process.env.PX_DB_CONTAINER || 'supabase_db_hackass-px2';
const APP_PORT = 3102, PROXY_PORT = 55498;
const APP = `http://localhost:${APP_PORT}`;

const st = spawnSync(SUPABASE, ['status', '--workdir', 'supabase-pilot', '-o', 'json'], { encoding: 'utf8', timeout: 60_000 });
let cfg; try { cfg = JSON.parse(st.stdout.slice(st.stdout.indexOf('{'))); } catch { console.error('BLOCKED  the pilot stack is not running (supabase status failed)'); process.exit(2); }
const API = cfg.API_URL, PUB = cfg.PUBLISHABLE_KEY, SECRET = cfg.SECRET_KEY;
if (!API || !PUB || !SECRET) { console.error('BLOCKED  the stack did not report its URLs and keys'); process.exit(2); }
const admin = createClient(API, SECRET, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }); // TEST ONLY; never given to the app
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sql(text) { // direct SQL as postgres, test-side only
  const r = spawnSync(DOCKER, ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], { input: text, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sql failed: ${r.stderr.slice(0, 200)}`);
  return r.stdout.trim();
}
const count = (table, user) => Number(sql(`select count(*) from app.${table} where owner_id = '${user}'`));

// ---- fault-injecting proxy in front of Auth ------------------------------------------------------------------------------------------------------------
const proxyState = { mode: 'pass' };
const proxy = http.createServer((req, res) => {
  if (proxyState.mode === 'down') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"message":"simulated outage"}'); return; }
  const up = http.request({ host: '127.0.0.1', port: Number(new URL(API).port), path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
}).listen(PROXY_PORT);

// ---- results -------------------------------------------------------------------------------------------------------------------------------------------
let failed = 0; const results = [];
async function check(id, title, fn) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(id)) return;
  let guard; try { const facts = await Promise.race([fn(), new Promise((_r, rej) => { guard = setTimeout(() => rej(new Error('check exceeded 120 s (hung)')), 120_000); })]); clearTimeout(guard); results.push({ id, ok: true }); console.log(`PASS  ${id}  ${title}${facts ? `  [${facts}]` : ''}`); }
  catch (e) { clearTimeout(guard); failed++; results.push({ id, ok: false }); console.log(`FAIL  ${id}  ${title}  -> ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m); };

// ---- app process ---------------------------------------------------------------------------------------------------------------------------------------
const SECRETS = { CURSOR_SIGNING_SECRET: randomBytes(32).toString('base64url'), AUTH_THROTTLE_SECRET: randomBytes(32).toString('base64url'), AUTH_SETUP_MARKER_SECRET: randomBytes(32).toString('base64url') };
function startApp() {
  const env = { ...process.env, ...SECRETS, APP_ENV: 'local', APP_ORIGIN: APP, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${PROXY_PORT}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUB, TRUSTED_CLIENT_IP_HEADER: 'x-test-client-ip', NODE_ENV: 'production' };
  const p = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(APP_PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = { text: '' }; p.stdout.on('data', (d) => { log.text += d; }); p.stderr.on('data', (d) => { log.text += d; });
  return { p, log };
}
async function waitUp() { for (let i = 0; i < 60; i++) { try { const r = await fetch(`${APP}/auth/session`); if (r.status) return true; } catch { /* not yet */ } await sleep(500); } return false; }

// ---- HTTP helpers --------------------------------------------------------------------------------------------------------------------------------------
class Jar {
  constructor() { this.c = new Map(); }
  absorb(res) { for (const raw of res.headers.getSetCookie()) { const [pair, ...attrs] = raw.split(';').map((s) => s.trim()); const i = pair.indexOf('='); const name = pair.slice(0, i), value = pair.slice(i + 1); const a = attrs.join(';').toLowerCase(); if (/max-age=0/.test(a) || value === '') this.c.delete(name); else this.c.set(name, value); } }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
  clone() { const j = new Jar(); j.c = new Map(this.c); return j; }
}
async function call(path, { method = 'GET', jar, ip = '198.51.100.1', origin = APP, json, raw, headers = {}, noOrigin = false } = {}) {
  const h = { 'x-test-client-ip': ip, ...headers }; if (jar && jar.c.size) h.cookie = jar.header();
  if (method !== 'GET' && !noOrigin) h.origin = origin;
  let body; if (json !== undefined) { h['content-type'] = h['content-type'] ?? 'application/json'; body = JSON.stringify(json); } else if (raw !== undefined) { body = raw; }
  const res = await fetch(APP + path, { method, headers: h, body, redirect: 'manual' });
  if (jar) jar.absorb(res);
  const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  return { res, status: res.status, text, json: j, setCookies: res.headers.getSetCookie().length };
}
const PW = 'correct horse battery staple';
const uniq = () => randomBytes(4).toString('hex');
let ipN = 20; const nextIp = () => `203.0.113.${(ipN++ % 250) + 1}`;
const members = [];
async function newMember(tag) {
  const email = `px3b-${tag}-${uniq()}@example.test`;
  const c = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true }); ok(!c.error, `createUser: ${c.error?.message}`);
  const m = { tag, email, id: c.data.user.id, jar: new Jar(), ip: nextIp() }; members.push(m);
  const si = await call('/auth/sign-in', { method: 'POST', jar: m.jar, ip: m.ip, json: { email, password: PW } }); ok(si.status === 200, `sign-in ${si.status}`);
  return m;
}
// shorthand: the member's request
const as = (m) => ({ jar: m.jar, ip: m.ip });
const req = () => randomUUID();
const prompt = (title, extra = {}) => ({ title, goal: 'a goal', context: 'some context', output_format: 'Concise summary', full_prompt: `prompt text for ${title}`, starting_prompt: 'starter', origin_kind: 'scratch', ...extra });
const result = (outcome = 'partial', reflection = 'half worked') => ({ outcome, reflection, next_change: 'add a budget' });
const mark = `PX3B-${uniq()}`;                      // appears in every title/body we send; must never appear in the app's log
const ALL_ROUTES = [
  ['GET', '/work/prompts'], ['POST', '/work/prompts'], ['GET', `/work/prompts/${randomUUID()}`], ['PUT', `/work/prompts/${randomUUID()}`], ['DELETE', `/work/prompts/${randomUUID()}?expected_version=1`],
  ['POST', `/work/prompts/${randomUUID()}/results`], ['POST', '/work/saves'], ['GET', '/work/results'], ['GET', `/work/results/${randomUUID()}`], ['PUT', `/work/results/${randomUUID()}`],
  ['DELETE', `/work/results/${randomUUID()}?expected_version=1`], ['GET', '/work/export?kind=summary'],
];
const validBody = (method, path) => (method === 'GET' || method === 'DELETE' ? undefined : path === '/work/saves' ? { request_id: req(), prompt: prompt(`${mark} x`), result: result() }
  : /\/results$/.test(path) ? { request_id: req(), expected_prompt_version: 1, result: result() } : /^\/work\/results\//.test(path) ? { expected_version: 1, result: result() }
  : method === 'PUT' ? { request_id: req(), expected_version: 1, prompt: prompt(`${mark} x`) } : { request_id: req(), prompt: prompt(`${mark} x`) });

// ---- go ------------------------------------------------------------------------------------------------------------------------------------------------
const app = startApp();
if (!(await waitUp())) { console.error('BLOCKED  the app did not start (run `npx next build` first)'); app.p.kill(); proxy.close(); process.exit(2); }
try {
  const A = await newMember('a'), B = await newMember('b');
  let a1; // A first prompt, used across checks

  // ======== the gate: T2 on every route ========
  await check('G1', 'every route and method refuses a request with no session (401) and does not touch the database', async () => {
    const before = Number(sql('select (select count(*) from app.saved_prompts) + (select count(*) from app.saved_reflections)'));
    for (const [m, p] of ALL_ROUTES) { const r = await call(p, { method: m, json: validBody(m, p), ip: nextIp() }); ok(r.status === 401 && r.json?.error?.code === 'unauthenticated', `${m} ${p.replace(/[0-9a-f-]{36}/, ':id')}: ${r.status}`); ok(r.setCookies === 0, 'set a cookie'); }
    ok(Number(sql('select (select count(*) from app.saved_prompts) + (select count(*) from app.saved_reflections)')) === before, 'rows changed');
    return `${ALL_ROUTES.length} route/method combinations`;
  });
  await check('G2', 'a garbage session cookie is never served on any route (401, or the PX-2b retryable 503 for a credential that cannot be interpreted)', async () => {
    const bad = new Jar(); bad.c.set('sb-127-auth-token', 'base64-' + Buffer.from('{"access_token":"x.y.z","refresh_token":"r","expires_at":1000}').toString('base64url'));
    for (const [m, p] of ALL_ROUTES) { const r = await call(p, { method: m, json: validBody(m, p), jar: bad.clone(), ip: nextIp() }); ok([401, 503].includes(r.status) && r.json?.error && r.setCookies === 0, `${m} ${p.slice(0, 14)}: ${r.status}`); }
    return 'never served: 401, or a retryable 503 when the credential cannot be interpreted (the PX-2b rule); no cookie touched';
  });
  await check('G3', 'revoked session: after sign-out the OLD cookies are refused on reads and writes (the Auth server confirms every time)', async () => {
    const j = new Jar(); await call('/auth/sign-in', { method: 'POST', jar: j, ip: nextIp(), json: { email: A.email, password: PW } });
    const old = j.clone(); ok((await call('/work/prompts', { jar: old.clone(), ip: nextIp() })).status === 200, 'works before sign-out');
    ok((await call('/auth/sign-out', { method: 'POST', jar: j, ip: nextIp() })).status === 200, 'sign-out');
    const rd = await call('/work/prompts', { jar: old.clone(), ip: nextIp() }); const wr = await call('/work/prompts', { method: 'POST', jar: old.clone(), ip: nextIp(), json: { request_id: req(), prompt: prompt(`${mark} revoked`) } });
    ok(rd.status === 401 && wr.status === 401, `read ${rd.status}, write ${wr.status}`); ok(count('saved_prompts', A.id) === 0, 'a refused write stored something');
    return 'read 401, write 401, nothing stored';
  });
  await check('G4', 'Auth outage: every route is a retryable 503 (never served at the provisional level), no cookie is touched, nothing is written; recovery afterwards', async () => {
    proxyState.mode = 'down';
    try { for (const [m, p] of ALL_ROUTES) { const r = await call(p, { method: m, json: validBody(m, p), ...as(A) }); ok(r.status === 503 && r.json?.error?.code === 'unavailable' && r.setCookies === 0 && r.res.headers.get('retry-after'), `${m} ${p.slice(0, 14)}: ${r.status} cookies=${r.setCookies}`); } }
    finally { proxyState.mode = 'pass'; }
    ok(count('saved_prompts', A.id) === 0, 'a write happened during the outage');
    ok((await call('/work/prompts', as(A))).status === 200, 'recovered'); return `${ALL_ROUTES.length} routes 503 with Retry-After; recovered`;
  });
  await check('G5', 'the DATABASE guard follows T2: a disabled account passes T2 but is refused by the database on reads and writes (403), and works again when re-enabled', async () => {
    const C = await newMember('guard');
    ok((await call('/work/prompts', as(C))).status === 200, 'active account works');
    sql(`begin; set local role hackass_owner; update app.accounts set status = 'disabled' where user_id = '${C.id}'; commit;`);
    let rd, wr;
    try { rd = await call('/work/prompts', as(C)); wr = await call('/work/prompts', { method: 'POST', ...as(C), json: { request_id: req(), prompt: prompt(`${mark} disabled`) } }); }
    finally { sql(`begin; set local role hackass_owner; update app.accounts set status = 'active' where user_id = '${C.id}'; commit;`); }
    ok(rd.status === 403 && wr.status === 403 && rd.json.error.code === 'forbidden', `read ${rd.status}, write ${wr.status}`); ok(count('saved_prompts', C.id) === 0, 'a disabled account stored something');
    ok((await call('/work/prompts', as(C))).status === 200, 'works again'); return 'read 403, write 403, re-enabled 200';
  });
  await check('G6', 'CSRF: every mutating route refuses a foreign Origin and a missing Origin (403) and writes nothing', async () => {
    for (const [m, p] of ALL_ROUTES.filter(([m]) => m !== 'GET')) for (const o of [{ origin: 'https://evil.example' }, { noOrigin: true }]) { const r = await call(p, { method: m, json: validBody(m, p), ...as(A), ...o }); ok(r.status === 403, `${m} ${p.slice(0, 14)} ${JSON.stringify(o)}: ${r.status}`); }
    ok(count('saved_prompts', A.id) === 0, 'rows written'); return 'foreign and missing Origin refused everywhere';
  });

  // ======== writes and the receipt contract ========
  await check('W1', 'create: 201 with a version-1 receipt; the identical retry is 200 replay (not superseded); same request id with different content is 409 request_reuse; one row', async () => {
    const rid = req(), doc = prompt(`${mark} first`);
    const c = await call('/work/prompts', { method: 'POST', ...as(A), json: { request_id: rid, prompt: doc } }); ok(c.status === 201 && c.json.version === 1 && c.json.replay === undefined && /^[0-9a-f-]{36}$/.test(c.json.id), `${c.status} ${c.text.slice(0, 120)}`);
    const r = await call('/work/prompts', { method: 'POST', ...as(A), json: { request_id: rid, prompt: doc } }); ok(r.status === 200 && r.json.id === c.json.id && r.json.version === 1 && r.json.replay === true && r.json.superseded === false, `retry ${r.status} ${r.text.slice(0, 160)}`);
    const reuse = await call('/work/prompts', { method: 'POST', ...as(A), json: { request_id: rid, prompt: { ...doc, title: `${mark} other` } } }); ok(reuse.status === 409 && reuse.json.error.code === 'request_reuse', `${reuse.status} ${reuse.text.slice(0, 120)}`);
    ok(count('saved_prompts', A.id) === 1, 'not exactly one row'); a1 = { id: c.json.id, rid, doc }; return '201 → 200 replay → 409 request_reuse';
  });
  await check('W2', 'REGRESSION over HTTP: create A (v1, response "lost") → another tab saves B (v2) → retrying the create returns the ORIGINAL v1 receipt flagged superseded; updating with that version is 409', async () => {
    const b = await call(`/work/prompts/${a1.id}`, { method: 'PUT', ...as(A), json: { request_id: req(), expected_version: 1, prompt: prompt(`${mark} second`) } }); ok(b.status === 200 && b.json.version === 2, `${b.status} ${b.text.slice(0, 100)}`);
    const r = await call('/work/prompts', { method: 'POST', ...as(A), json: { request_id: a1.rid, prompt: a1.doc } });
    ok(r.status === 200 && r.json.version === 1 && r.json.replay === true && r.json.superseded === true, `retry ${r.status} ${r.text.slice(0, 160)}`);
    const stale = await call(`/work/prompts/${a1.id}`, { method: 'PUT', ...as(A), json: { request_id: req(), expected_version: r.json.version, prompt: a1.doc } }); ok(stale.status === 409 && stale.json.error.code === 'version_conflict', `${stale.status}`);
    const cur = await call(`/work/prompts/${a1.id}`, as(A)); ok(cur.json.title === `${mark} second` && cur.json.version === 2, 'text B was overwritten');
    return 'v1 receipt, replay+superseded; stale update 409; text B intact';
  });
  await check('W3', 'competing updates over two parallel HTTP requests: exactly one 200 and one 409', async () => {
    const [x, y] = await Promise.all([1, 2].map((i) => call(`/work/prompts/${a1.id}`, { method: 'PUT', ...as(A), json: { request_id: req(), expected_version: 2, prompt: prompt(`${mark} race ${i}`) } })));
    const s = [x.status, y.status].sort(); ok(s[0] === 200 && s[1] === 409, `statuses ${s}`); const cur = await call(`/work/prompts/${a1.id}`, as(A)); ok(cur.json.version === 3, `version ${cur.json.version}`);
    return '200 + 409, version 3';
  });
  await check('W4', 'results: a result is bound to the prompt version tried (stale → 409); it snapshots what was tried; retries answer with the original receipt even after an edit', async () => {
    const stale = await call(`/work/prompts/${a1.id}/results`, { method: 'POST', ...as(A), json: { request_id: req(), expected_prompt_version: 2, result: result() } }); ok(stale.status === 409 && stale.json.error.code === 'version_conflict', `stale prompt version ${stale.status}`);
    const rid = req(), body = { request_id: rid, expected_prompt_version: 3, result: result('yes', `${mark} first words`) };
    const c = await call(`/work/prompts/${a1.id}/results`, { method: 'POST', ...as(A), json: body }); ok(c.status === 201 && c.json.version === 1 && c.json.prompt_version === 3, `${c.status} ${c.text.slice(0, 120)}`);
    await call(`/work/prompts/${a1.id}`, { method: 'PUT', ...as(A), json: { request_id: req(), expected_version: 3, prompt: prompt(`${mark} renamed later`, { full_prompt: 'changed later' }) } });
    const g = await call(`/work/results/${c.json.id}`, as(A)); ok(g.status === 200 && g.json.title.includes('race') && g.json.attempted_prompt.startsWith('prompt text for') && g.json.prompt_version === 3, `snapshot ${g.text.slice(0, 200)}`);
    const e = await call(`/work/results/${c.json.id}`, { method: 'PUT', ...as(A), json: { expected_version: 1, result: result('no', `${mark} edited words`) } }); ok(e.status === 200 && e.json.version === 2, `edit ${e.status}`);
    const r = await call(`/work/prompts/${a1.id}/results`, { method: 'POST', ...as(A), json: body }); ok(r.status === 200 && r.json.version === 1 && r.json.replay === true && r.json.superseded === true, `retry ${r.status} ${r.text.slice(0, 160)}`);
    const upd = await call(`/work/results/${c.json.id}`, { method: 'PUT', ...as(A), json: { expected_version: r.json.version, result: result('yes', 'stale overwrite') } }); ok(upd.status === 409, `stale result update ${upd.status}`);
    const lst = await call('/work/results', as(A)); ok(lst.json.items.length === 1 && lst.json.items[0].title.includes('race'), 'the list shows the snapshot title'); a1.result = c.json.id;
    return 'stale 409; snapshot kept; edit v2; retry → v1 replay superseded; stale update 409';
  });
  await check('W5', 'combined save is atomic: valid → both stored (201); an invalid result stores neither (422/400); an exact retry after the prompt moved on → the original receipt, superseded', async () => {
    const rid = req(), pdoc = prompt(`${mark} both`), rdoc = result('partial', `${mark} both words`);
    const c = await call('/work/saves', { method: 'POST', ...as(A), json: { request_id: rid, prompt: pdoc, result: rdoc } }); ok(c.status === 201 && c.json.prompt.version === 1 && c.json.result.version === 1, `${c.status} ${c.text.slice(0, 160)}`);
    const before = [count('saved_prompts', A.id), count('saved_reflections', A.id)];
    const bad = await call('/work/saves', { method: 'POST', ...as(A), json: { request_id: req(), prompt: prompt(`${mark} never`), result: { ...rdoc, outcome: 'bogus' } } }); ok(bad.status === 400, `invalid result ${bad.status}`);
    ok(before[0] === count('saved_prompts', A.id) && before[1] === count('saved_reflections', A.id), 'something was stored');
    await call(`/work/prompts/${c.json.prompt.id}`, { method: 'PUT', ...as(A), json: { request_id: req(), expected_version: 1, prompt: prompt(`${mark} both v2`) } });
    const r = await call('/work/saves', { method: 'POST', ...as(A), json: { request_id: rid, prompt: pdoc, result: rdoc } }); ok(r.status === 200 && r.json.prompt.version === 1 && r.json.replay === true && r.json.superseded === true && r.json.result.id === c.json.result.id, `retry ${r.status} ${r.text.slice(0, 200)}`);
    const upd = await call('/work/saves', { method: 'POST', ...as(A), json: { request_id: req(), prompt: prompt(`${mark} both v3`), result: result('yes', 'again'), prompt_id: c.json.prompt.id, expected_prompt_version: 2 } }); ok(upd.status === 201 && upd.json.prompt.version === 3, `update-and-save ${upd.status} ${upd.text.slice(0, 120)}`);
    const stale = await call('/work/saves', { method: 'POST', ...as(A), json: { request_id: req(), prompt: prompt(`${mark} x`), result: result(), prompt_id: c.json.prompt.id, expected_prompt_version: 2 } }); ok(stale.status === 409, `stale ${stale.status}`);
    a1.both = c.json.prompt.id; return '201; invalid stores nothing; retry → v1 superseded; update-and-save v3; stale 409';
  });

  // ======== two members ========
  await check('X1', 'B cannot read, edit, delete or attach to A\'s items: every attempt is the IDENTICAL 404 as a missing or malformed id; A\'s data is unchanged', async () => {
    const snapA = await call(`/work/prompts/${a1.id}`, as(A)); const missing = randomUUID();
    const attempts = (id, rid) => [
      call(`/work/prompts/${id}`, as(B)), call(`/work/prompts/${id}`, { method: 'PUT', ...as(B), json: { request_id: req(), expected_version: 1, prompt: prompt(`${mark} hijack`) } }),
      call(`/work/prompts/${id}?expected_version=${snapA.json.version}`, { method: 'DELETE', ...as(B) }), call(`/work/prompts/${id}/results`, { method: 'POST', ...as(B), json: { request_id: req(), expected_prompt_version: snapA.json.version, result: result() } }),
      call(`/work/saves`, { method: 'POST', ...as(B), json: { request_id: req(), prompt: prompt(`${mark} hijack`), result: result(), prompt_id: id, expected_prompt_version: snapA.json.version } }),
      call(`/work/results/${rid}`, as(B)), call(`/work/results/${rid}`, { method: 'PUT', ...as(B), json: { expected_version: 2, result: result() } }), call(`/work/results/${rid}?expected_version=2`, { method: 'DELETE', ...as(B) }),
    ];
    const real = await Promise.all(attempts(a1.id, a1.result)), none = await Promise.all(attempts(missing, randomUUID())), bad = await Promise.all(attempts('not-an-id', 'also-not-an-id'));
    for (let i = 0; i < real.length; i++) { ok(real[i].status === 404, `attempt ${i}: ${real[i].status} ${real[i].text.slice(0, 80)}`); const bodyId = i === 4; ok(real[i].text === none[i].text && (bodyId ? bad[i].status === 400 : real[i].text === bad[i].text), `attempt ${i}: the answer differs between another member's, a missing and a malformed id`); }
    const after = await call(`/work/prompts/${a1.id}`, as(A)); ok(JSON.stringify(after.json) === JSON.stringify(snapA.json), 'A\'s prompt changed'); ok(count('saved_prompts', B.id) === 0 && count('saved_reflections', B.id) === 0, 'rows were written for B');
    return `${real.length} operations: another member's id and a missing id give the same 404; a malformed id in a path too (a malformed id inside a request body is a 400 shape error)`;
  });
  await check('X2', 'B\'s lists and export contain none of A\'s work, with or without crafted cursors; A\'s lists show only A\'s', async () => {
    const lp = await call('/work/prompts', as(B)), lr = await call('/work/results', as(B)), es = await call('/work/export?kind=summary', as(B)), ep = await call('/work/export?kind=prompts', as(B)), er = await call('/work/export?kind=results', as(B));
    ok(lp.json.items.length === 0 && lr.json.items.length === 0 && es.json.prompts === 0 && es.json.results === 0 && ep.json.items.length === 0 && er.json.items.length === 0, 'B sees something');
    const crafted = await call(`/work/prompts?after_id=${a1.id}&after_updated_at=${encodeURIComponent('2100-01-01T00:00:00+00:00')}`, as(B)); ok(crafted.status === 200 && crafted.json.items.length === 0, 'a crafted cursor exposed rows');
    const ea = await call('/work/export?kind=summary', as(A)); ok(ea.json.prompts === count('saved_prompts', A.id) && ea.json.results === count('saved_reflections', A.id), 'A\'s summary does not match A\'s rows');
    return `A has ${ea.json.prompts} prompts, ${ea.json.results} results; B sees none`;
  });
  await check('X3', 'B has its own independent space: same-looking content is separate, and B\'s quota and versions are its own', async () => {
    const c = await call('/work/prompts', { method: 'POST', ...as(B), json: { request_id: a1.rid, prompt: a1.doc } }); ok(c.status === 201 && c.json.version === 1 && c.json.id !== a1.id, `B reused A's request id: ${c.status} ${c.text.slice(0, 100)}`);
    const l = await call('/work/prompts', as(B)); ok(l.json.items.length === 1, 'B list'); const la = await call('/work/prompts', as(A)); ok(!la.json.items.some((i) => i.id === c.json.id), 'B\'s item in A\'s list'); return 'request ids are per member';
  });

  // ======== listing, deletion, export ========
  await check('L1', 'lists are bounded and paged (limit 1 gives a cursor; the next page continues without overlap); bad limits and cursors are 400', async () => {
    const p1 = await call('/work/prompts?limit=1', as(A)); ok(p1.json.items.length === 1 && p1.json.next_cursor, 'first page');
    const p2 = await call(`/work/prompts?limit=1&after_id=${p1.json.next_cursor.id}&after_updated_at=${encodeURIComponent(p1.json.next_cursor.updated_at)}`, as(A)); ok(p2.status === 200 && p2.json.items.length === 1 && p2.json.items[0].id !== p1.json.items[0].id, 'second page');
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'after_id=x', `after_id=${randomUUID()}`]) ok((await call(`/work/prompts?${q}`, as(A))).status === 400, q);
    for (const q of ['outcome=maybe', 'limit=-1']) ok((await call(`/work/results?${q}`, as(A))).status === 400, q);
    const o = await call('/work/results?outcome=no', as(A)); ok(o.status === 200 && o.json.items.every((i) => i.outcome === 'no'), 'outcome filter');
    return 'paging and bounds';
  });
  await check('E1', 'export pages are bounded (≤50), carry no owner id or request internals, and a bad kind or limit is 400', async () => {
    for (let i = 0; i < 2; i++) ok((await call('/work/prompts', { method: 'POST', ...as(A), json: { request_id: req(), prompt: prompt(`${mark} export ${i}`) } })).status === 201, 'seed');
    const e1 = await call('/work/export?kind=prompts&limit=2', as(A)); ok(e1.status === 200 && e1.json.items.length === 2 && e1.json.next_after_id, 'first export page');
    const e2 = await call(`/work/export?kind=prompts&limit=2&after_id=${e1.json.next_after_id}`, as(A)); ok(e2.status === 200 && !e2.json.items.some((i) => e1.json.items.some((j) => j.id === i.id)), 'second page overlaps');
    const er = await call('/work/export?kind=results&limit=5', as(A)); ok(er.json.items.length >= 1 && er.json.items[0].attempted_prompt !== undefined, 'results export');
    for (const t of [e1.text, er.text]) ok(!/owner|request_hash|request_receipt|request_id/.test(t), 'internals in the export');
    for (const q of ['kind=prompts&limit=51', 'kind=everything', '', 'kind=results&after_id=bad']) ok((await call(`/work/export?${q}`, as(A))).status === 400, q || '(none)');
    return 'bounded, allowlisted';
  });
  await check('D1', 'delete: needs the version (400 without, 409 stale); the detail shows the result count; a delete cascades and reports it; the item is then 404', async () => {
    const d = await call(`/work/prompts/${a1.both}`, as(A)); ok(d.status === 200 && d.json.result_count >= 2, `count ${d.json.result_count}`);
    ok((await call(`/work/prompts/${a1.both}`, { method: 'DELETE', ...as(A) })).status === 400, 'no expected_version'); ok((await call(`/work/prompts/${a1.both}?expected_version=1`, { method: 'DELETE', ...as(A) })).status === 409, 'stale version');
    const x = await call(`/work/prompts/${a1.both}?expected_version=${d.json.version}`, { method: 'DELETE', ...as(A) }); ok(x.status === 200 && x.json.deleted === true && x.json.results_deleted === d.json.result_count, `${x.status} ${x.text}`);
    ok((await call(`/work/prompts/${a1.both}`, as(A))).status === 404, 'still there');
    const res = await call(`/work/results/${a1.result}`, as(A)); const dr = await call(`/work/results/${a1.result}?expected_version=${res.json.version}`, { method: 'DELETE', ...as(A) }); ok(dr.status === 200 && dr.json.deleted === true, `result delete ${dr.status}`);
    ok((await call(`/work/results/${a1.result}`, as(A))).status === 404, 'result still there'); return `cascade removed ${x.json.results_deleted} results`;
  });

  // ======== bounds and uniform errors ========
  await check('V1', 'strict bodies: unknown keys (including owner fields), bad formats, over-limit fields, wrong types are 400 naming fields only (never values); a body with a forged owner stores nothing', async () => {
    const before = count('saved_prompts', A.id);
    const cases = [
      ['owner key at root', { request_id: req(), prompt: prompt(`${mark} v`), owner_id: B.id }], ['owner key in prompt', { request_id: req(), prompt: { ...prompt(`${mark} v`), owner_id: B.id } }], ['user key', { request_id: req(), prompt: prompt(`${mark} v`), user_id: B.id }],
      ['format outside allowlist', { request_id: req(), prompt: prompt(`${mark} v`, { output_format: 'Free text' }) }], ['title too long', { request_id: req(), prompt: prompt('t'.repeat(121)) }], ['prompt too long', { request_id: req(), prompt: prompt(`${mark} v`, { full_prompt: 'p'.repeat(20001) }) }],
      ['bad request id', { request_id: 'nope', prompt: prompt(`${mark} v`) }], ['no prompt', { request_id: req() }], ['not an object', [1, 2]], ['catalog without slug', { request_id: req(), prompt: prompt(`${mark} v`, { origin_kind: 'catalog' }) }],
    ];
    for (const [name, body] of cases) { const r = await call('/work/prompts', { method: 'POST', ...as(A), json: body }); ok(r.status === 400 && r.json.error.code === 'validation_failed', `${name}: ${r.status} ${r.text.slice(0, 100)}`); ok(!r.text.includes(B.id) && !r.text.includes(mark) && !r.text.includes('Free text'), `${name}: the response echoes a submitted value`); }
    ok(count('saved_prompts', A.id) === before && count('saved_prompts', B.id) === 1, 'something was stored'); return `${cases.length} refused, nothing stored`;
  });
  await check('V2', 'transport bounds: non-JSON content type 415; malformed JSON 400; oversize 413 (declared and streamed) without reaching the database; the body deadline gives 408', async () => {
    const t = await call('/work/prompts', { method: 'POST', ...as(A), headers: { 'content-type': 'text/plain' }, raw: 'x' }); ok(t.status === 415, `content type ${t.status}`);
    const f = await call('/work/prompts', { method: 'POST', ...as(A), headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: 'a=b' }); ok(f.status === 415, `form ${f.status}`);
    const J = { 'content-type': 'application/json' }; const m = await call('/work/prompts', { method: 'POST', ...as(A), headers: J, raw: '{not json' }); ok(m.status === 400, `malformed ${m.status}`);
    const big = await call('/work/prompts', { method: 'POST', ...as(A), headers: J, raw: JSON.stringify({ request_id: req(), prompt: prompt('big', { full_prompt: 'x'.repeat(200 * 1024) }) }) }); ok(big.status === 413 && big.json.error.code === 'payload_too_large', `declared ${big.status}`);
    const rr = await call(`/work/prompts/${randomUUID()}/results`, { method: 'POST', ...as(A), headers: J, raw: JSON.stringify({ request_id: req(), expected_prompt_version: 1, result: { outcome: 'yes', reflection: 'r'.repeat(30 * 1024) } }) }); ok(rr.status === 413, `result body over its own (smaller) limit ${rr.status}`);
    // streamed (chunked) body past the limit: counted as it arrives
    const streamed = await new Promise((resolve) => {
      const q = http.request({ host: 'localhost', port: APP_PORT, path: '/work/prompts', method: 'POST', headers: { 'content-type': 'application/json', origin: APP, 'transfer-encoding': 'chunked', 'x-test-client-ip': A.ip, cookie: A.jar.header() } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      q.on('error', () => resolve('closed')); let sent = 0; const iv = setInterval(() => { if (q.destroyed || sent > 60) { clearInterval(iv); return; } sent++; q.write(Buffer.alloc(16 * 1024, 0x61)); }, 5); setTimeout(() => { clearInterval(iv); q.end(); }, 600);
    });
    ok(streamed === 413 || streamed === 'closed', `streamed oversize ${streamed}`);
    const slow = await new Promise((resolve) => { const q = http.request({ host: 'localhost', port: APP_PORT, path: '/work/prompts', method: 'POST', headers: { 'content-type': 'application/json', origin: APP, 'transfer-encoding': 'chunked', 'x-test-client-ip': A.ip, cookie: A.jar.header() } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); }); q.on('error', () => resolve('closed')); q.write('{"request_id":'); setTimeout(() => { try { q.destroy(); } catch { /* gone */ } resolve('client-gave-up'); }, 6000); });
    ok(slow === 408 || slow === 'closed', `slow body ${slow}`);
    return `415, 415, 400, 413, 413, streamed ${streamed}, slow ${slow}`;
  });
  await check('V3', 'a document that passes the application limits but exceeds the database cap is a clean 422 naming the field; the database errors never leak', async () => {
    const e = '😀'; const r = await call('/work/prompts', { method: 'POST', ...as(A), json: { request_id: req(), prompt: prompt(`${mark} huge`, { full_prompt: e.repeat(17000), starting_prompt: e.repeat(17000) }) } });
    ok(r.status === 422 && r.json.error.code === 'invalid_content' && r.json.error.field === 'prompt', `${r.status} ${r.text.slice(0, 200)}`); ok(!/PT4|saved_|app\.|postgres|sql/i.test(r.text), 'database text in the answer'); return '422 invalid_content field=prompt';
  });
  await check('V4', 'quotas are reported as 429 quota_exceeded (distinct from rate limiting); text/format: HTML-looking text is stored as text, returned as JSON with no-store', async () => {
    const C = await newMember('quota');
    const html = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const c = await call('/work/prompts', { method: 'POST', ...as(C), json: { request_id: req(), prompt: prompt(`${mark} ${html}`, { full_prompt: html }) } }); ok(c.status === 201, `${c.status}`);
    const g = await call(`/work/prompts/${c.json.id}`, as(C)); ok(g.json.full_prompt === html, 'stored as typed'); ok(/application\/json/.test(g.res.headers.get('content-type')) && g.res.headers.get('cache-control') === 'no-store', 'headers');
    sql(`begin; set local role hackass_owner; insert into app.saved_prompts (owner_id, request_id, request_hash, request_receipt, title, goal, context, output_format, full_prompt, starting_prompt, origin_kind) select '${C.id}', gen_random_uuid(), repeat('a', 64), '{}', 'seed ' || i, '', '', 'Concise summary', 'x', '', 'scratch' from generate_series(1, 99) i; commit;`);
    const over = await call('/work/prompts', { method: 'POST', ...as(C), json: { request_id: req(), prompt: prompt(`${mark} one too many`) } }); ok(over.status === 429 && over.json.error.code === 'quota_exceeded' && !over.res.headers.get('retry-after'), `${over.status} ${over.text.slice(0, 120)}`);
    return '101st prompt: 429 quota_exceeded; HTML stays text';
  });

  // ======== throttle ========
  await check('T1', 'write throttle: after the member\'s allowance the next write is 429 rate_limited with Retry-After BEFORE the body is read or the database is called; reads and other members are unaffected', async () => {
    const T = await newMember('throttle'); let first429 = null, n = 0;
    for (; n < 80; n++) { const r = await call('/work/saves', { method: 'POST', ...as(T), json: {} }); if (r.status === 429) { first429 = r; break; } ok(r.status === 400, `request ${n + 1}: ${r.status}`); }
    ok(first429 && n === 60, `first 429 at request ${n + 1}`); ok(first429.json.error.code === 'rate_limited' && Number(first429.res.headers.get('retry-after')) >= 1 && first429.json.retryAfterSec >= 1, first429.text.slice(0, 120));
    const big = await call('/work/saves', { method: 'POST', ...as(T), headers: { 'content-type': 'application/json' }, raw: 'x'.repeat(300 * 1024) }); ok(big.status === 429, `an oversize body from a throttled member is refused as 429 before it is read: ${big.status}`);
    ok((await call('/work/prompts', as(T))).status === 200, 'reads are not write-throttled'); ok((await call('/work/prompts', { method: 'POST', ...as(B), json: { request_id: req(), prompt: prompt(`${mark} unaffected`) } })).status === 201, 'another member is unaffected');
    return `61st write → 429, Retry-After ${first429.res.headers.get('retry-after')}s`;
  });

  // ======== headers and logs ========
  await check('H1', 'every response (success and failure) is JSON and no-store, carries a request id, and sets no wildcard CORS', async () => {
    const rs = [await call('/work/prompts', as(A)), await call(`/work/prompts/${randomUUID()}`, as(A)), await call('/work/prompts', { method: 'POST', ...as(A), json: {} }), await call('/work/prompts', { ip: nextIp() }), await call('/work/export?kind=summary', as(A))];
    for (const r of rs) { ok(/application\/json/.test(r.res.headers.get('content-type')), 'content type'); ok(r.res.headers.get('cache-control') === 'no-store', `cache-control ${r.res.headers.get('cache-control')}`); ok(r.res.headers.get('x-request-id'), 'request id'); ok(!r.res.headers.get('access-control-allow-origin'), 'CORS header'); }
    return `${rs.length} responses`;
  });
  await check('P1', 'privacy in logs: none of the titles, prompt text, reflections, email addresses, cookies, tokens or item ids appear in the app\'s output; only operation names and outcome kinds were logged', async () => {
    const out = app.log.text; ok(out.length > 0, 'the app produced no log output');
    const tok = (j) => { try { const raw = [...j.c].filter(([k]) => /^sb-.+-auth-token/.test(k)).sort(([x], [y]) => x.localeCompare(y)).map(([, v]) => v).join(''); const c = JSON.parse(Buffer.from(raw.replace(/^base64-/, ''), 'base64url').toString('utf8')); return [c.access_token, c.refresh_token]; } catch { return []; } };
    const needles = [mark, 'prompt text for', 'half worked', 'first words', 'edited words', 'hijack', '<script>', PW, A.email, B.email, a1.id, a1.result, a1.both, ...tok(A.jar), ...tok(B.jar), 'sb-127-auth-token=', 'Set-Cookie', A.id, B.id].filter((x) => x && x.length > 3);
    for (const n of needles) if (out.includes(n)) throw new Error(`the log contains ${JSON.stringify(n.slice(0, 24))} in: ${(out.split('\n').find((l) => l.includes(n)) || '').replace(/eyJ[A-Za-z0-9_.-]+/g, '[jwt]').slice(0, 220)}`);
    const events = [...new Set([...out.matchAll(/"event":"([a-z_]+)"/g)].map((m) => m[1]))]; ok(events.some((e) => e.startsWith('work_')), `no work events (${events.join(',')})`);
    const odd = events.filter((e) => !/^(work_|auth_|request_)/.test(e)); ok(odd.length === 0, `unexpected events ${odd.join(',')}`);
    return `${out.split('\n').filter(Boolean).length} lines; events: ${events.filter((e) => e.startsWith('work_')).join(', ')}`;
  });
} finally {
  if (process.env.LOGDUMP) console.log('---- app log (scrubbed) ----\n' + app.log.text.replace(/eyJ[A-Za-z0-9_.-]+/g, '[jwt]').replace(/[A-Za-z0-9_-]{40,}/g, '[long]'));
  app.p.kill(); proxy.close();
  for (const m of members) { try { await admin.auth.admin.deleteUser(m.id); } catch { /* best effort; disposable stack */ } }
}
console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
