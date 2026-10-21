#!/usr/bin/env node
// Pilot RPC checks: member access and anonymous / service-role denial through ACTUAL RPC calls on the `api` schema (the 11 saved-work member functions), plus an explicit
// SESSION-REVOCATION check. This complements the exact SQL inventory (scripts/pilot-inventory.mjs); it does not rely on the API's OpenAPI description listing the functions.
//   node scripts/pilot-rpc-checks.mjs --local         the local pilot stack (keys read from `supabase status`)
//   node scripts/pilot-rpc-checks.mjs --hosted --confirm-pilot <ref>   the hosted pilot: PILOT_API_URL (exactly https://<ref>.supabase.co), PILOT_PUBLISHABLE_KEY_FILE, PILOT_SECRET_KEY_FILE (0600 files; values are never printed).
//                                                       The project binding is checked BEFORE any key file is read or any request is sent; the staging project is refused.
// MUTATING (class M): it creates two throwaway members with the secret key (the OPERATOR's key; the application never holds it), creates and deletes labelled content, and deletes both
// members at the end (the erasure trigger removes their content). Every call prints a status and a kind, never a body, a token or a key.
// A FAILED check stops the run: later checks (they mutate) are reported SKIPPED, never run. Cleanup always runs, its outcome is VERIFIED (each fixture user must be gone), and an incomplete cleanup fails the run.
// DEADLINES: every request is bounded to min(15 s, the time left in the 5-minute RUN budget) and is NOT SENT once that budget is spent, so a call inside a running check cannot outlive the run.
// CLEANUP has its own separate allowance (60 s in total, each call still at most 15 s), used only after the run phase ends; the env names PILOT_RPC_CALL_MS / _RUN_MS / _CLEANUP_MS can only SHORTEN these.
// FIXTURES are recorded BEFORE the request that might create them, in a private 0600 file (never the repository): a creation whose outcome is unknown (timeout, transport error, 5xx) is looked up by the
// intended address and removed if found; if its creation OR removal cannot be established the cleanup is INCOMPLETE (exit 3), never "verified clean". The identifying details (addresses, ids) are written only
// to that file; the public log carries counts, a fixture number and the file's path, never an address, id, token or key. The file is removed only when every fixture is established gone.
// Exit 0 all passed and cleanup verified, 1 a check failed, 2 blocked/unreachable/refused, 3 cleanup incomplete (takes precedence).
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { checkHostedApiTarget } from './lib/pilot-plan.mjs';

const argv = process.argv.slice(2);
const mode = argv[0];
if (!['--local', '--hosted'].includes(mode)) { console.error('usage: node scripts/pilot-rpc-checks.mjs --local | --hosted --confirm-pilot <ref>'); process.exit(2); }
let API, PUB, SECRET;
if (mode === '--local') {
  const st = spawnSync(process.env.SUPABASE_BIN || 'supabase', ['status', '--workdir', 'supabase-pilot', '-o', 'json'], { encoding: 'utf8', timeout: 60_000 });
  try { const c = JSON.parse(st.stdout.slice(st.stdout.indexOf('{'))); API = c.API_URL; PUB = c.PUBLISHABLE_KEY; SECRET = c.SECRET_KEY; } catch { console.error('BLOCKED  the pilot stack is not running'); process.exit(2); }
} else {
  // the explicit project binding comes FIRST: no key file is read and nothing is sent unless the API URL is exactly https://<ref>.supabase.co, is not the staging project and matches --confirm-pilot
  const ci = argv.indexOf('--confirm-pilot');
  const refusals = checkHostedApiTarget({ apiUrl: process.env.PILOT_API_URL, confirmRef: ci >= 0 ? argv[ci + 1] : undefined });
  if (refusals.length) { console.error('REFUSED:\n' + refusals.map((r) => `  - ${r}`).join('\n')); process.exit(2); }
  const f = (n) => { try { return readFileSync(process.env[n], 'utf8').trim(); } catch { return ''; } };
  API = new URL(process.env.PILOT_API_URL).origin; PUB = f('PILOT_PUBLISHABLE_KEY_FILE'); SECRET = f('PILOT_SECRET_KEY_FILE');
  if (!PUB || !SECRET) { console.error('BLOCKED  set PILOT_PUBLISHABLE_KEY_FILE and PILOT_SECRET_KEY_FILE'); process.exit(2); }
}
// every request is bounded by the time left in the current phase; nothing is sent once a phase's budget is spent
const lim = (name, d) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? Math.min(v, d) : d; };   // can only shorten
const CALL_MS = lim('PILOT_RPC_CALL_MS', 15_000), RUN_MS = lim('PILOT_RPC_RUN_MS', 300_000), CLEANUP_MS = lim('PILOT_RPC_CLEANUP_MS', 60_000);
const deadline = Date.now() + RUN_MS; let phase = 'run', cleanupEnd = 0;
const bounded = (url, init) => {
  const left = (phase === 'run' ? deadline : cleanupEnd) - Date.now();
  if (left <= 0) return Promise.reject(Object.assign(new Error(`the ${phase} deadline has passed; the request was not sent`), { name: 'DeadlineError' }));
  const signal = AbortSignal.timeout(Math.min(CALL_MS, left));
  return fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
};
const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: bounded } };
const admin = createClient(API, SECRET, noPersist);
// a PURE anonymous client is created per use: a client that has signed a member in keeps that session in memory and would stop being anonymous
const pureAnon = () => createClient(API, PUB, noPersist);
const signer = () => createClient(API, PUB, noPersist);
const as = (jwt) => createClient(API, PUB, { ...noPersist, global: { fetch: bounded, headers: { Authorization: `Bearer ${jwt}` } } });
const positive = new Set();   // functions that returned success for a MEMBER (recorded by the wrapper below)
const memberClients = new Set();
const rpc = async (client, fn, args) => { const r = await client.schema('api').rpc(fn, args); if (!r.error && memberClients.has(client)) positive.add(fn); return r; };

let failed = 0, stopped = false; const results = [];
async function check(id, title, fn) {
  if (stopped || Date.now() > deadline) { results.push({ id, ok: false, skipped: true }); console.log(`SKIP  ${id}  ${title}  -> not run: ${stopped ? 'an earlier check failed' : 'the run deadline passed'}`); return; }
  try { const facts = await fn(); results.push({ id, ok: true }); console.log(`PASS  ${id}  ${title}${facts ? `  [${facts}]` : ''}`); }
  catch (e) { failed++; stopped = true; results.push({ id, ok: false }); console.log(`FAIL  ${id}  ${title}  -> ${e.message}  (the run stops here; later checks are skipped, cleanup still runs)`); }
}
const ok = (c, m) => { if (!c) throw new Error(m); };
const refused = (r) => r.error && !r.data && (r.status === 401 || r.status === 403 || ['42501', 'PGRST301', 'PGRST302', '28000'].includes(r.error.code));
const PW = `Pw-${randomBytes(9).toString('base64url')}-x1`;
const members = [];
// the private record of intended fixtures (written BEFORE the creating request; 0600 in a 0700 directory this process creates; the only place an address or id is ever written)
let recDir = null, recFile = null;
const record = (obj) => {
  if (!recFile) { recDir = mkdtempSync(join(process.env.PILOT_RPC_RECORD_DIR || tmpdir(), 'pilot-rpc-')); recFile = join(recDir, 'fixtures.jsonl'); closeSync(openSync(recFile, 'wx', 0o600)); }
  appendFileSync(recFile, JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n');
};
// definitive refusal = the API answered with a 4xx (other than 408): the user was not created. Anything else (timeout, transport error, 5xx, 408) is UNCERTAIN.
const definitiveRefusal = (e) => typeof e?.status === 'number' && e.status >= 400 && e.status < 500 && e.status !== 408;
async function member(tag) {
  const email = `pilot-rpc-${tag}-${randomBytes(4).toString('hex')}@example.test`;
  const m = { n: members.length + 1, email, id: null, creation: 'intended' }; members.push(m);
  record({ fixture: m.n, email, state: 'intended' });   // tracked BEFORE the request that might create it
  let c; try { c = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true }); } catch { c = { error: { status: 0 } }; }
  if (c.error) { m.creation = definitiveRefusal(c.error) ? 'refused' : 'uncertain'; record({ fixture: m.n, state: m.creation }); throw new Error(`createUser: ${c.error.status || 'no definitive answer'}`); }
  m.id = c.data.user.id; m.creation = 'created'; record({ fixture: m.n, email, id: m.id, state: 'created' });
  const si = await signer().auth.signInWithPassword({ email, password: PW }); if (si.error) throw new Error(`sign-in: ${si.error.status}`);
  m.jwt = si.data.session.access_token; m.db = as(m.jwt); memberClients.add(m.db); return m;
}
const pdoc = (t, extra = {}) => ({ title: t, output_format: 'Concise summary', full_prompt: `text ${t}`, starting_prompt: 'starter', origin_kind: 'scratch', ...extra });
const rdoc = (o = 'partial', t = 'words') => ({ outcome: o, reflection: t, next_change: 'next' });
const FIXTURE = (id, ver = 1) => ({
  save_prompt: { p_request_id: randomUUID(), p_doc: pdoc('x') }, get_my_prompt: { p_id: id }, list_my_prompts: {}, delete_my_prompt: { p_id: id, p_expected_version: ver },
  save_reflection: { p_request_id: randomUUID(), p_prompt_id: id, p_expected_prompt_version: ver, p_doc: rdoc() }, save_prompt_and_result: { p_request_id: randomUUID(), p_prompt_doc: pdoc('y'), p_result_doc: rdoc() },
  update_my_reflection: { p_id: id, p_expected_version: ver, p_doc: rdoc() }, delete_my_reflection: { p_id: id, p_expected_version: ver }, list_my_results: {}, get_my_result: { p_id: id }, export_my_data: { p_kind: 'summary' },
});
const FUNCTIONS = Object.keys(FIXTURE(randomUUID()));

try {
  const ping = await pureAnon().schema('api').rpc('list_public_hacks', { p_limit: 1 }); if (ping.error && ping.status === 0) { console.error('BLOCKED  the API is unreachable'); process.exit(2); }
  let A, B;
  await check('R0', 'two throwaway members are created and signed in (fixtures; removed and verified at the end)', async () => { A = await member('a'); B = await member('b'); return 'created'; });

  await check('R1', 'ANONYMOUS (publishable key, no session): all 11 member functions are refused by the API/database; the two public catalogue reads still answer', async () => {
    for (const fn of FUNCTIONS) { const r = await rpc(pureAnon(), fn, FIXTURE(randomUUID())[fn]); ok(refused(r), `${fn}: ${r.status} ${r.error?.code ?? 'no error'} data=${r.data ? 'yes' : 'no'}`); }
    const pub = await rpc(pureAnon(), 'list_public_hacks', { p_limit: 1 }); ok(!pub.error, `list_public_hacks: ${pub.status}`); return '11 refused; public read OK';
  });
  await check('R2', 'SERVICE ROLE (secret key, the operator\'s): all 11 member functions are refused: the saved-work functions have no EXECUTE for service_role', async () => {
    for (const fn of FUNCTIONS) { const r = await rpc(admin, fn, FIXTURE(randomUUID())[fn]); ok(refused(r), `${fn}: ${r.status} ${r.error?.code ?? 'no error'} data=${r.data ? 'yes' : 'no'}`); }
    return '11 refused';
  });
  let a1, resultId, bothIds;
  await check('R3', 'MEMBER A: every one of the 11 functions works for the member\'s own data (create, read, list, update, replay, results, combined save, export, delete)', async () => {
    const req = randomUUID(); const c = await rpc(A.db, 'save_prompt', { p_request_id: req, p_doc: pdoc('A prompt') }); ok(!c.error && c.data.version === 1, `save_prompt ${c.status} ${c.error?.code}`); a1 = c.data.id;
    const u = await rpc(A.db, 'save_prompt', { p_request_id: randomUUID(), p_doc: pdoc('A prompt v2'), p_id: a1, p_expected_version: 1 }); ok(!u.error && u.data.version === 2, `update ${u.status} ${u.error?.code}`);
    const rp = await rpc(A.db, 'save_prompt', { p_request_id: req, p_doc: pdoc('A prompt') }); ok(!rp.error && rp.data.version === 1 && rp.data.replay === true && rp.data.superseded === true, `replay ${JSON.stringify(rp.data)}`);
    const g = await rpc(A.db, 'get_my_prompt', { p_id: a1 }); ok(!g.error && g.data.title === 'A prompt v2' && g.data.result_count === 0, 'get_my_prompt');
    const l = await rpc(A.db, 'list_my_prompts', {}); ok(!l.error && l.data.items.some((i) => i.id === a1), 'list_my_prompts');
    const r = await rpc(A.db, 'save_reflection', { p_request_id: randomUUID(), p_prompt_id: a1, p_expected_prompt_version: 2, p_doc: rdoc('yes', 'first') }); ok(!r.error && r.data.version === 1 && r.data.prompt_version === 2, `save_reflection ${r.status} ${r.error?.code}`); resultId = r.data.id;
    const ur = await rpc(A.db, 'update_my_reflection', { p_id: resultId, p_expected_version: 1, p_doc: rdoc('no', 'edited') }); ok(!ur.error && ur.data.version === 2, 'update_my_reflection');
    const gr = await rpc(A.db, 'get_my_result', { p_id: resultId }); ok(!gr.error && gr.data.attempted_prompt === 'text A prompt v2' && gr.data.title === 'A prompt v2', 'get_my_result: the snapshot of what was tried');
    const lr = await rpc(A.db, 'list_my_results', {}); ok(!lr.error && lr.data.items.length === 1, 'list_my_results');
    const both = await rpc(A.db, 'save_prompt_and_result', { p_request_id: randomUUID(), p_prompt_doc: pdoc('A combined'), p_result_doc: rdoc() }); ok(!both.error && both.data.prompt.version === 1 && both.data.result.version === 1, 'save_prompt_and_result'); bothIds = both.data;
    const es = await rpc(A.db, 'export_my_data', { p_kind: 'summary' }); ok(!es.error && es.data.prompts === 2 && es.data.results === 2, `export summary ${JSON.stringify(es.data)}`);
    for (const k of ['prompts', 'results']) { const e = await rpc(A.db, 'export_my_data', { p_kind: k, p_limit: 50 }); ok(!e.error && e.data.kind === k && e.data.items.length === 2, `export ${k}`); }
    const dr = await rpc(A.db, 'delete_my_reflection', { p_id: bothIds.result.id, p_expected_version: 1 }); ok(!dr.error && dr.data.deleted === true, 'delete_my_reflection');
    const dp = await rpc(A.db, 'delete_my_prompt', { p_id: bothIds.prompt.id, p_expected_version: 1 }); ok(!dp.error && dp.data.deleted === true && dp.data.results_deleted === 0, `delete_my_prompt ${dp.status} ${dp.error?.code}`);
    const gone = await rpc(A.db, 'get_my_prompt', { p_id: bothIds.prompt.id }); ok(gone.error?.code === 'PT404', 'the deleted prompt is gone');
    const missing = FUNCTIONS.filter((f) => !positive.has(f)); ok(!missing.length, `no successful owner call for: ${missing.join(', ')}`);
    return `all ${FUNCTIONS.length} functions answered successfully for the owner (including delete_my_prompt)`;
  });
  await check('R4', 'MEMBER B against A\'s ids: every attempt is the IDENTICAL not-found as a missing id, and A\'s data is unchanged', async () => {
    const attempts = (id, rid) => [['get_my_prompt', { p_id: id }], ['save_prompt', { p_request_id: randomUUID(), p_doc: pdoc('hijack'), p_id: id, p_expected_version: 2 }], ['delete_my_prompt', { p_id: id, p_expected_version: 2 }],
      ['save_reflection', { p_request_id: randomUUID(), p_prompt_id: id, p_expected_prompt_version: 2, p_doc: rdoc() }], ['save_prompt_and_result', { p_request_id: randomUUID(), p_prompt_doc: pdoc('hijack'), p_result_doc: rdoc(), p_id: id, p_expected_version: 2 }],
      ['get_my_result', { p_id: rid }], ['update_my_reflection', { p_id: rid, p_expected_version: 2, p_doc: rdoc() }], ['delete_my_reflection', { p_id: rid, p_expected_version: 2 }]];
    const real = attempts(a1, resultId), none = attempts(randomUUID(), randomUUID());
    for (let i = 0; i < real.length; i++) { const x = await rpc(B.db, real[i][0], real[i][1]), y = await rpc(B.db, none[i][0], none[i][1]); ok(x.error?.code === 'PT404' && x.status === 404, `${real[i][0]}: ${x.status} ${x.error?.code}`); ok(JSON.stringify([x.error.code, x.error.message, x.error.details]) === JSON.stringify([y.error.code, y.error.message, y.error.details]), `${real[i][0]}: differs from a missing id`); }
    const g = await rpc(A.db, 'get_my_prompt', { p_id: a1 }); ok(!g.error && g.data.version === 2 && g.data.title === 'A prompt v2' && g.data.result_count === 1, 'A\'s prompt changed'); return `${real.length} operations: identical not_found; A unchanged`;
  });
  await check('R5', 'MEMBER B sees nothing of A: empty lists and a zero export, also with a crafted cursor', async () => {
    const lp = await rpc(B.db, 'list_my_prompts', {}), lr = await rpc(B.db, 'list_my_results', {}), es = await rpc(B.db, 'export_my_data', { p_kind: 'summary' });
    ok(lp.data.items.length === 0 && lr.data.items.length === 0 && es.data.prompts === 0 && es.data.results === 0, 'B sees rows'); const cr = await rpc(B.db, 'list_my_prompts', { p_after_updated_at: '2100-01-01T00:00:00+00:00', p_after_id: a1 }); ok(!cr.error && cr.data.items.length === 0, 'crafted cursor'); return 'empty';
  });
  await check('R6', 'SESSION REVOCATION (separate from key rotation): after the session is revoked at the provider, the SAME unexpired access token is refused by the database guard on a read and a write', async () => {
    const s = await signer().auth.signInWithPassword({ email: A.email, password: PW }); ok(!s.error, 'second sign-in'); const jwt = s.data.session.access_token, db = as(jwt);
    ok(!(await rpc(db, 'list_my_prompts', {})).error, 'works before revocation');
    const out = await admin.auth.admin.signOut(jwt, 'global'); ok(!out.error, `revocation ${out.error?.status}`);
    const rd = await rpc(db, 'list_my_prompts', {}), wr = await rpc(db, 'save_prompt', { p_request_id: randomUUID(), p_doc: pdoc('after revocation') });
    ok(refused(rd) && refused(wr), `read ${rd.status}/${rd.error?.code}, write ${wr.status}/${wr.error?.code}`); const other = await rpc(A.db, 'list_my_prompts', {}); ok(refused(other), `A's FIRST token was also revoked (global): ${other.status}`);
    return 'revoked token: read and write refused (database guard); a key rotation would not do this';
  });
  if (mode === '--local') await check('R7', 'OPERATOR MASS REVOCATION by SQL (local rehearsal of the procedure in docs/px3d/05): deleting a member\'s rows in auth.sessions ends the access token\'s usefulness AND the refresh token at once', async () => {
    const C = await member('c'); const si = await signer().auth.signInWithPassword({ email: C.email, password: PW }); ok(!si.error, 'sign-in'); const { access_token: jwt, refresh_token: refresh } = si.data.session; const db = as(jwt);
    ok(!(await rpc(db, 'list_my_prompts', {})).error, 'works before');
    const del = spawnSync(process.env.DOCKER_BIN || '/Applications/Docker.app/Contents/Resources/bin/docker', ['exec', '-i', process.env.PX_DB_CONTAINER || 'supabase_db_hackass-px2', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], { input: `delete from auth.sessions where user_id = '${C.id}' returning 1;`, encoding: 'utf8' });
    ok(del.status === 0 && del.stdout.trim().split('\n').filter(Boolean).length >= 1, `sessions deleted: ${del.stderr.slice(0, 80)}`);
    const rd = await rpc(db, 'list_my_prompts', {}); ok(refused(rd), `old access token, read: ${rd.status}/${rd.error?.code}`);
    const wr = await rpc(db, 'save_prompt', { p_request_id: randomUUID(), p_doc: pdoc('after mass revocation') }); ok(refused(wr), `old access token, write: ${wr.status}/${wr.error?.code}`);
    const rf = await signer().auth.refreshSession({ refresh_token: refresh }); ok(rf.error && !rf.data.session, 'the refresh token cannot mint a new session');
    return 'access token refused (read and write); refresh refused';
  });
} catch (e) {
  failed++; stopped = true; console.log(`FAIL  run  unexpected error -> ${String(e?.message ?? e).slice(0, 160)}`);
} finally {
  // CLEANUP: its own bounded allowance. For every fixture it must be ESTABLISHED gone: deleted and then confirmed absent, or proven never created (a definitive refusal). Anything else is incomplete.
  phase = 'cleanup'; cleanupEnd = Date.now() + CLEANUP_MS;
  const knownById = async (m) => {
    try { const d = await admin.auth.admin.deleteUser(m.id); if (d.error && d.error.status !== 404) m.note = `deletion error (${d.error.status ?? 'error'})`; } catch (e) { m.note = `deletion error (${String(e?.name ?? 'error')})`; }
    try { const g = await admin.auth.admin.getUserById(m.id); m.state = g.error ? (g.error.status === 404 ? 'gone' : 'unverified') : 'remains'; } catch { m.state = 'unverified'; }
  };
  // an uncertain creation is looked up by the intended address (a bounded, paged scan); a user found is removed and confirmed, one not found is NOT proof (a late request may still land)
  const scan = async (email) => {
    try { for (let page = 1; page <= 10; page++) { const l = await admin.auth.admin.listUsers({ page, perPage: 200 }); if (l.error) return { ok: false }; const hit = l.data.users.find((u) => u.email === email); if (hit) return { ok: true, id: hit.id }; if (l.data.users.length < 200) return { ok: true, id: null }; } return { ok: false }; } catch { return { ok: false }; }
  };
  for (const m of members) {
    m.state = 'unestablished';
    if (m.creation === 'refused') { m.state = 'gone'; m.note = 'creation was refused by the API; nothing was created'; continue; }
    if (m.id) { await knownById(m); continue; }
    const f = await scan(m.email);
    if (f.ok && f.id) { m.id = f.id; record({ fixture: m.n, id: f.id, state: 'found by address after an uncertain creation' }); await knownById(m); }
    else m.note = f.ok ? 'creation outcome could not be established (no user found now, but the request may still have landed)' : 'the lookup could not be completed';
  }
  for (const m of members) record({ fixture: m.n, cleanup: m.state, note: m.note });
  const withIds = members.filter((m) => m.id);
  if (mode === '--local' && withIds.length) {   // local only: also confirm the erasure trigger left no saved content behind
    const ids = withIds.map((m) => `'${m.id}'`).join(',');
    const q = spawnSync(process.env.DOCKER_BIN || '/Applications/Docker.app/Contents/Resources/bin/docker', ['exec', '-i', process.env.PX_DB_CONTAINER || 'supabase_db_hackass-px2', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], { input: `select (select count(*) from app.saved_prompts where owner_id in (${ids})) + (select count(*) from app.saved_reflections where owner_id in (${ids}));`, encoding: 'utf8', timeout: 30_000 });
    // three outcomes, never conflated: a number (the count, 0 = none), or null = the check itself could not be run or read (UNAVAILABLE, which is not evidence either way)
    const n = q.status === 0 && /^\d+$/.test(q.stdout.trim()) ? Number(q.stdout.trim()) : null;
    members.content = n;
  }
}
const bad = members.filter((m) => m.state !== 'gone');
// local-mode content check: undefined = not applicable (hosted mode, or no fixture with a known id); 0 = confirmed none; > 0 = CONFIRMED remaining; null = verification UNAVAILABLE. Both of the last two fail the run (exit 3).
const contentLeft = typeof members.content === 'number' && members.content > 0, contentUnverified = members.content === null;
for (const m of members) console.log(`cleanup  fixture ${m.n}: ${m.state === 'gone' ? (m.creation === 'refused' ? 'never created (refused)' : 'deleted and confirmed gone') : `NOT ESTABLISHED CLEAN (${m.state})`}`);
const passed = results.filter((r) => r.ok).length, skipped = results.filter((r) => r.skipped).length;
console.log(`\n${passed}/${results.length} passed, ${failed} failed, ${skipped} skipped`);
if (bad.length || contentLeft || contentUnverified) {
  console.log(`CLEANUP INCOMPLETE: ${bad.length} fixture(s) not established clean${contentLeft ? `; saved content CONFIRMED remaining (${members.content} row(s))` : ''}${contentUnverified ? '; the saved-content verification was UNAVAILABLE (the check could not be run; this is not evidence that content remains, but cleanup is not verified)' : ''}. The operator must look them up and remove them before any further run.`);
  console.log(`  Identifying details are in a PRIVATE file (0600), not in this log: ${recFile}\n  Do not paste, upload or commit that file; delete it once the fixtures are confirmed gone.`);
  process.exit(3);
}
if (recFile) { try { rmSync(recDir, { recursive: true, force: false }); } catch { /* the directory was created by this process; a failure to remove it is harmless */ } }
console.log(`cleanup verified: ${members.length} fixture(s) established gone`);
process.exit(failed || skipped ? 1 : 0);
