#!/usr/bin/env node
// PX-3a local checks that pgTAP cannot do: REAL concurrent database connections (separate psql processes, committed data, genuine advisory-lock contention)
// and the migration / rollback rehearsal. Needs the disposable LOCAL pilot stack (node scripts/px2b-pilot.mjs up); it never touches anything hosted.
//   node scripts/local-px3a-checks.mjs
// Each session is one `docker exec psql` running a DO block that sets the member's claims, calls the api function as the `authenticated` role, reports the
// outcome, and then HOLDS its transaction open (pg_sleep) so a second connection genuinely contends for the same per-member lock.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCKER = process.env.DOCKER_BIN || '/Applications/Docker.app/Contents/Resources/bin/docker';
const DB = process.env.PX_DB_CONTAINER || 'supabase_db_hackass-px2';
const HOLD = 2; // seconds the first session keeps its transaction (and lock) open
const MIGRATIONS = ['20261020090000_px3a_work_tables', '20261020090100_px3a_work_helpers', '20261020090200_px3a_work_api', '20261020090300_px3a_work_erasure'];

let pass = 0, fail = 0;
const check = (ok, name, extra = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : extra ? `  [${extra}]` : ''}`); };

// ---- psql plumbing -------------------------------------------------------------------------------------------------------------------------------
function psql(sql, extra = []) { // synchronous, as postgres; returns {out, err, status}
  const r = spawnSync(DOCKER, ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', ...extra], { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}
const scalar = (sql) => { const r = psql(sql); if (r.status !== 0) throw new Error(`sql failed: ${r.err}\n${sql}`); return r.out; };

// one member call: returns a promise of {ok, value|sqlstate/message, started, elapsed}
function memberCall(m, call, hold = 0, delayMs = 0) {
  const claims = JSON.stringify({ role: 'authenticated', sub: m.user, session_id: m.session, aal: 'aal1' });
  const sql = `do $do$
declare r text; t0 timestamptz := clock_timestamp(); s text; msg text; det text;
begin
  perform set_config('request.jwt.claims', $c$${claims}$c$, true);
  perform set_config('role', 'authenticated', true);
  begin
    execute $q$select (${call})::text$q$ into r;
    raise notice 'R|ok|%|%', extract(epoch from clock_timestamp() - t0), r;
  exception when others then
    get stacked diagnostics s = returned_sqlstate, msg = message_text, det = pg_exception_detail;
    raise notice 'R|err|%|%|%|%', extract(epoch from clock_timestamp() - t0), s, msg, coalesce(det, '');
  end;
  perform set_config('role', 'none', true);
  ${hold ? `perform pg_sleep(${hold});` : ''}
end $do$;`;
  return new Promise((resolve) => setTimeout(() => {
    const p = spawn(DOCKER, ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1']);
    let buf = '';
    p.stdout.on('data', (d) => (buf += d)); p.stderr.on('data', (d) => (buf += d));
    p.on('close', () => {
      const line = buf.split('\n').find((l) => /R\|(ok|err)\|/.test(l));
      if (!line) return resolve({ ok: false, sqlstate: 'NONE', message: buf.slice(0, 300), elapsed: 0 });
      const f = line.slice(line.indexOf('R|')).split('|');
      if (f[1] === 'ok') resolve({ ok: true, elapsed: +f[2], value: JSON.parse(f.slice(3).join('|')) });
      else resolve({ ok: false, elapsed: +f[2], sqlstate: f[3], message: f[4], detail: f[5] });
    });
    p.stdin.end(sql);
  }, delayMs));
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const pdoc = (title, extra = {}) => ({ title, output_format: 'Concise summary', full_prompt: 'do the thing', starting_prompt: 'starter text', origin_kind: 'scratch', ...extra });
const rdoc = (outcome = 'partial', reflection = 'half worked') => ({ outcome, reflection, next_change: 'add budget' });
const J = (o) => `${q(JSON.stringify(o))}::jsonb`;
const savePrompt = (reqId, doc, id = null, ver = null) => `api.save_prompt(${q(reqId)}, ${J(doc)}${id ? `, ${q(id)}, ${ver}` : ''})`;
const saveRefl = (reqId, pid, pver, doc) => `api.save_reflection(${q(reqId)}, ${q(pid)}, ${pver}, ${J(doc)})`;
const saveBoth = (reqId, pdocv, rdocv, pid, ver) => `api.save_prompt_and_result(${q(reqId)}, ${J(pdocv)}, ${J(rdocv)}${pid ? `, ${q(pid)}, ${ver}` : ''})`;

function newMember() {
  const m = { user: randomUUID(), session: randomUUID() };
  scalar(`insert into auth.users (id, aud, role, email) values ('${m.user}', 'authenticated', 'authenticated', 'px3a-${m.user.slice(0, 8)}@example.test');
          insert into auth.sessions (id, user_id) values ('${m.session}', '${m.user}');`);
  return m;
}
const members = [];
const member = () => { const m = newMember(); members.push(m); return m; };
const rows = (table, m, where = 'true') => +scalar(`select count(*) from app.${table} where owner_id = '${m.user}' and ${where}`);
// a loop of api calls inside ONE transaction as the member (seeding)
function seed(m, body) {
  const claims = JSON.stringify({ role: 'authenticated', sub: m.user, session_id: m.session, aal: 'aal1' });
  const r = psql(`do $do$ declare i int; j int; begin
    perform set_config('request.jwt.claims', $c$${claims}$c$, true); perform set_config('role', 'authenticated', true);
    ${body}
    perform set_config('role', 'none', true); end $do$;`);
  if (r.status !== 0) throw new Error(`seed failed: ${r.err}`);
}
const call1 = async (m, call) => memberCall(m, call);

// ---- 1. a lost response, another tab, then a retry — over real separate connections --------------------------------------------------------------
async function lostResponse() {
  console.log('\n== retry after a lost response (three separate connections, committed) ==');
  const m = member(), req = randomUUID();
  const a = await call1(m, savePrompt(req, pdoc('Text A')));
  check(a.ok && a.value.version === 1, 'tab 1 creates text A at version 1 (its response is then "lost")', JSON.stringify(a));
  const b = await call1(m, savePrompt(randomUUID(), pdoc('Text B'), a.value.id, 1));
  check(b.ok && b.value.version === 2, 'tab 2 saves text B at version 2', JSON.stringify(b));
  const r = await call1(m, savePrompt(req, pdoc('Text A')));
  check(r.ok && r.value.version === 1 && r.value.replay === true && r.value.superseded === true, 'the retry of the original create returns the ORIGINAL receipt (version 1, replay, superseded) — never version 2', JSON.stringify(r));
  const u = await call1(m, savePrompt(randomUUID(), pdoc('Text A'), a.value.id, r.value.version));
  check(!u.ok && u.sqlstate === 'PT409', 'an update using the receipt\'s version is a conflict, so text B cannot be overwritten by mistake', JSON.stringify(u));
  check(scalar(`select title || '|' || version from app.saved_prompts where id = '${a.value.id}'`) === 'Text B|2', 'the stored prompt is still text B at version 2');
  // results: the same sequence after the reflection is edited
  const rq = randomUUID();
  const r1 = await call1(m, saveRefl(rq, a.value.id, 2, rdoc('yes', 'first')));
  const r1e = await call1(m, `api.update_my_reflection(${q(r1.value.id)}, 1, ${J(rdoc('no', 'edited words'))})`);
  const r1r = await call1(m, saveRefl(rq, a.value.id, 2, rdoc('yes', 'first')));
  check(r1e.ok && r1e.value.version === 2 && r1r.ok && r1r.value.version === 1 && r1r.value.superseded === true, 'result retry after an edit returns the original receipt (version 1, superseded), not the edited version', JSON.stringify(r1r));
}

// ---- 2. competing updates -------------------------------------------------------------------------------------------------------------------------
async function competingUpdates() {
  console.log('\n== competing updates (two connections, same expected version) ==');
  const m = member();
  const p = (await call1(m, savePrompt(randomUUID(), pdoc('Start')))).value;
  const [a, b] = await Promise.all([
    memberCall(m, savePrompt(randomUUID(), pdoc('Tab A wins'), p.id, 1), HOLD),
    memberCall(m, savePrompt(randomUUID(), pdoc('Tab B loses'), p.id, 1), 0, 500),
  ]);
  check(a.ok && a.value.version === 2, 'the first connection saves version 2', JSON.stringify(a));
  check(!b.ok && b.sqlstate === 'PT409', 'the second connection, started while the first held the lock, gets a version conflict (PT409)', JSON.stringify(b));
  check(b.elapsed > HOLD * 0.5, `and it genuinely waited for the lock (${b.elapsed.toFixed(2)}s)`);
  check(scalar(`select title || '|' || version from app.saved_prompts where id = '${p.id}'`) === 'Tab A wins|2', 'exactly one write landed: "Tab A wins" at version 2');

  const [c, d] = await Promise.all([
    memberCall(m, saveBoth(randomUUID(), pdoc('Combined A'), rdoc('yes', 'one'), p.id, 2), HOLD),
    memberCall(m, saveBoth(randomUUID(), pdoc('Combined B'), rdoc('no', 'two'), p.id, 2), 0, 500),
  ]);
  check(c.ok && !d.ok && d.sqlstate === 'PT409', 'two competing COMBINED saves: one wins, the other gets PT409', JSON.stringify([c, d]));
  check(rows('saved_reflections', m, `prompt_id = '${p.id}'`) === 1 && scalar(`select title from app.saved_prompts where id = '${p.id}'`) === 'Combined A', 'and the loser left nothing behind (one result, the winner\'s title)');
}

// ---- 3. identical creates ---------------------------------------------------------------------------------------------------------------------------
async function identicalCreates() {
  console.log('\n== identical creates (same request id and payload, two connections) ==');
  const m = member(), req = randomUUID();
  const [a, b] = await Promise.all([memberCall(m, savePrompt(req, pdoc('Same')), HOLD), memberCall(m, savePrompt(req, pdoc('Same')), 0, 500)]);
  check(a.ok && b.ok && a.value.id === b.value.id, 'both succeed and name the same prompt', JSON.stringify([a, b]));
  check(rows('saved_prompts', m) === 1, 'exactly one row exists');
  check(a.value.replay === undefined && b.value.replay === true && b.value.superseded === false, 'the second is marked a replay (not superseded); the first is a first-time answer', JSON.stringify([a.value, b.value]));
  const req2 = randomUUID();
  const [c, d] = await Promise.all([memberCall(m, savePrompt(req2, pdoc('First content')), HOLD), memberCall(m, savePrompt(req2, pdoc('Different content')), 0, 500)]);
  check(c.ok && !d.ok && d.sqlstate === 'PT409' && d.message === 'request_reuse', 'the same request id with DIFFERENT content, concurrently: one is created, the other is refused (request_reuse)', JSON.stringify([c, d]));
  check(rows('saved_prompts', m, `request_id = '${req2}'`) === 1, 'and only one row carries that request id');
  const reqR = randomUUID(), pr = (await call1(m, savePrompt(randomUUID(), pdoc('Parent')))).value;
  const [e, f] = await Promise.all([memberCall(m, saveRefl(reqR, pr.id, 1, rdoc()), HOLD), memberCall(m, saveRefl(reqR, pr.id, 1, rdoc()), 0, 500)]);
  check(e.ok && f.ok && e.value.id === f.value.id && rows('saved_reflections', m, `request_id = '${reqR}'`) === 1, 'identical concurrent RESULT creates: one row, same id for both', JSON.stringify([e, f]));
}

// ---- 4. quota enforcement ---------------------------------------------------------------------------------------------------------------------------
async function quotas() {
  console.log('\n== quota enforcement under concurrency ==');
  let m = member();
  seed(m, `for i in 1..99 loop perform api.save_prompt(gen_random_uuid(), ${J(pdoc('seed'))}); end loop;`);
  check(rows('saved_prompts', m) === 99, 'member seeded with 99 prompts (limit 100)');
  const [a, b] = await Promise.all([memberCall(m, savePrompt(randomUUID(), pdoc('100th A')), HOLD), memberCall(m, savePrompt(randomUUID(), pdoc('100th B')), 0, 500)]);
  check(a.ok !== b.ok && [a, b].find((x) => !x.ok).sqlstate === 'PT429', 'two distinct creates at 99: exactly one succeeds, the other gets PT429', JSON.stringify([a, b]));
  check(rows('saved_prompts', m) === 100, 'and the member ends at exactly 100 prompts');

  m = member();
  const p = (await call1(m, savePrompt(randomUUID(), pdoc('Per-prompt quota')))).value;
  seed(m, `for i in 1..49 loop perform api.save_reflection(gen_random_uuid(), '${p.id}', 1, ${J(rdoc())}); end loop;`);
  const [c, d] = await Promise.all([memberCall(m, saveRefl(randomUUID(), p.id, 1, rdoc()), HOLD), memberCall(m, saveRefl(randomUUID(), p.id, 1, rdoc()), 0, 500)]);
  check(c.ok !== d.ok && [c, d].find((x) => !x.ok).sqlstate === 'PT429', 'two results at 49 on one prompt (limit 50): exactly one succeeds, the other PT429', JSON.stringify([c, d]));
  check(rows('saved_reflections', m, `prompt_id = '${p.id}'`) === 50, 'and the prompt ends at exactly 50 results');

  m = member();
  const ids = [];
  for (let i = 0; i < 11; i++) ids.push((await call1(m, savePrompt(randomUUID(), pdoc('Member quota ' + i)))).value.id);
  for (let i = 0; i < 9; i++) seed(m, `for j in 1..50 loop perform api.save_reflection(gen_random_uuid(), '${ids[i]}', 1, ${J(rdoc())}); end loop;`);
  seed(m, `for j in 1..49 loop perform api.save_reflection(gen_random_uuid(), '${ids[9]}', 1, ${J(rdoc())}); end loop;`);
  check(rows('saved_reflections', m) === 499, 'member seeded with 499 results across 10 prompts (member limit 500)');
  const [e, f] = await Promise.all([memberCall(m, saveRefl(randomUUID(), ids[10], 1, rdoc()), HOLD), memberCall(m, saveRefl(randomUUID(), ids[10], 1, rdoc()), 0, 500)]);
  check(e.ok !== f.ok && [e, f].find((x) => !x.ok).sqlstate === 'PT429', 'two results at 499: exactly one succeeds, the other PT429', JSON.stringify([e, f]));
  check(rows('saved_reflections', m) === 500, 'and the member ends at exactly 500 results');
  // a different member is unaffected by the first member's lock
  const other = member();
  const [g, h] = await Promise.all([memberCall(m, savePrompt(randomUUID(), pdoc('holder')), HOLD), memberCall(other, savePrompt(randomUUID(), pdoc('independent')), 0, 500)]);
  check(h.ok && h.elapsed < HOLD * 0.5, `the lock is per member: another member is not blocked (${h.elapsed.toFixed(2)}s)`, JSON.stringify([g, h]));
}

// ---- 5. migration and rollback rehearsal ------------------------------------------------------------------------------------------------------------
function rollbackRehearsal() {
  console.log('\n== migration and rollback rehearsal ==');
  const down = readFileSync(path.join(root, 'supabase/rollbacks/20261020090000_px3a_down.sql'), 'utf8');
  const present = () => scalar(`select (to_regclass('app.saved_prompts') is not null)::int + (to_regclass('app.saved_reflections') is not null)::int
      + (select count(*) from pg_namespace where nspname = 'app_work')::int
      + (select count(*) from pg_trigger where tgname = 'hackass_work_content_deleted' and not tgisinternal)::int
      + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname in ('save_prompt','get_my_prompt','list_my_prompts','delete_my_prompt','save_reflection','save_prompt_and_result','update_my_reflection','delete_my_reflection','list_my_results','get_my_result','export_my_data'))::int
      + (select count(*) from pg_proc where proname = 'on_auth_user_deleted_content')::int`);
  const versions = () => +scalar(`select count(*) from supabase_migrations.schema_migrations where version in ('20261020090000','20261020090100','20261020090200','20261020090300')`);
  const apiCount = () => +scalar(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('api','app_guard','app_bridge','app_content','app_review','app_budget','app_work')`);
  const before = present(), baseline = apiCount(), seededRows = +scalar('select (select count(*) from app.saved_prompts) + (select count(*) from app.saved_reflections)');
  check(+before > 0 && versions() === 4, `starting state: objects present (${before}) and four migration versions recorded`);

  // (a) the whole rollback file inside a transaction that is rolled back: proves it executes, and what it leaves behind
  const inTx = down.replace(/commit;\s*$/i, '');
  const r = psql(`${inTx}
select 'INTX|' || (to_regclass('app.saved_prompts') is null)::text || '|' || (to_regclass('app.saved_reflections') is null)::text || '|' || (select count(*) = 0 from pg_namespace where nspname = 'app_work')::text || '|' || (select count(*) = 0 from pg_trigger where tgname = 'hackass_work_content_deleted')::text || '|' || (select count(*) = 0 from supabase_migrations.schema_migrations where version like '2026102009%')::text;
rollback;`);
  check(r.status === 0 && /INTX\|true\|true\|true\|true\|true/.test(r.out), 'rollback script runs cleanly inside a transaction and removes tables, helpers, trigger and version rows', r.err || r.out);
  check(present() === before && versions() === 4 && +scalar('select (select count(*) from app.saved_prompts) + (select count(*) from app.saved_reflections)') === seededRows, 'after that rolled-back rehearsal everything (and every row) is exactly as before');

  // (b) the committed rollback
  const rc = psql(down);
  check(rc.status === 0, 'committed rollback applies cleanly', rc.err);
  check(+present() === 0 && versions() === 0, 'afterwards none of the PX-3a objects remain and the version rows are gone');
  check(apiCount() === baseline - 19, `and exactly the 19 PX-3a functions (11 api, 1 trigger function, 7 helpers) are gone (${baseline} -> ${apiCount()})`);
  check(scalar(`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r'`) === '26', 'the F2 table set is intact (26 tables)');
  // (c) re-apply, as the CLI would
  let ok = true, err = '';
  for (const name of MIGRATIONS) {
    const file = readFileSync(path.join(root, 'supabase/migrations', `${name}.sql`), 'utf8');
    const a = psql(file, ['-1']);
    if (a.status !== 0) { ok = false; err = `${name}: ${a.err}`; break; }
    const [version, ...rest] = name.split('_');
    scalar(`insert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${rest.join('_')}') on conflict do nothing`);
  }
  check(ok, 're-applying the four migrations in order succeeds', err);
  check(present() === before && versions() === 4, 'and the database is back to the starting object set');
  check(apiCount() === baseline, `function count restored (${apiCount()})`);
}

// ---- run ----------------------------------------------------------------------------------------------------------------------------------------------
try {
  const ping = psql('select 1');
  if (ping.status !== 0) { console.error(`cannot reach ${DB}: ${ping.err}\nstart the pilot stack first: node scripts/px2b-pilot.mjs up`); process.exit(2); }
  await lostResponse();
  await competingUpdates();
  await identicalCreates();
  await quotas();
} finally {
  // remove the test members (the erasure trigger deletes their work); account rows stay, marked deleted, on this disposable stack
  if (members.length) psql(`delete from auth.users where id in (${members.map((m) => `'${m.user}'`).join(',')})`);
}
const left = +scalar(`select count(*) from app.saved_prompts`);
check(left === 0, `test members removed and their work erased by the trigger (saved prompts remaining: ${left})`);
rollbackRehearsal();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
