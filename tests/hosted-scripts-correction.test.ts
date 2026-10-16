// Regression tests for the consolidated correction of scripts/hosted (review of 60d2814): fail-closed run state, SQL and stage classification, cleanup of interrupted creation,
// deadlines that stop the underlying operation, strict verification results, honest evidence, and credential-file checks at every entry point.
// Nothing here contacts a hosted system or the Supabase CLI. Database access is replaced by a stub container runtime (DOCKER_BIN) or by injected dependencies; the real-Docker
// timeout and crash paths are exercised by scripts/hosted/selftest.mjs against the disposable local stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const url = (f: string) => pathToFileURL(join(root, 'scripts/hosted', f)).href;
const load = (f: string) => import(url(f));
// modules that the correction introduces: a missing module is a test failure, not a load error of the whole file
const optional = async (f: string) => { try { return await load(f); } catch { return null; } };

const cfg = await load('lib/config.mjs');
const guard = await load('lib/sqlguard.mjs');
const gates = await load('lib/gates.mjs');
const stagesMod = await load('lib/stages.mjs');
const cli = await load('lib/cli.mjs');
const ctxm = await load('lib/context.mjs');
const state = await load('lib/state.mjs');
const redact = await load('lib/redact.mjs');
const execMod = await load('lib/exec.mjs');
const pg = await load('lib/pg.mjs');
const flows = await load('lib/flows.mjs');
const secretfile = await optional('lib/secretfile.mjs');
const dates = await optional('lib/dates.mjs');
const refusal = await optional('lib/refusal.mjs');
const push = await optional('lib/push.mjs');
const cleanupLib = await optional('lib/cleanup.mjs');
const model = await optional('lib/evidence-model.mjs');
const sqlLib = await load('lib/sql.mjs');

const SHA = 'a'.repeat(40); const OTHER_SHA = 'b'.repeat(40);
const git = { head: SHA, clean: true };
// secret-shaped values are assembled at run time so that no literal key or credential is committed
const shaped = (kind: string) => `sb_${kind}_${'q'.repeat(20)}`;
const made: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hs-corr-')); chmodSync(d, 0o700); made.push(d); return d; };
const runIds: string[] = [];
const freshRunId = () => { const id = `ut-${Math.random().toString(36).slice(2, 10)}`; runIds.push(id); return id; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); for (const id of runIds) rmSync(join(state.runBase('selftest'), id), { recursive: true, force: true }); });

function selfEnv(extra: Record<string, string> = {}) {
  const dir = tmp(); const pf = join(dir, 'pgpass');
  writeFileSync(pf, 'host.docker.internal:54322:postgres:postgres:p1\nhost.docker.internal:54322:postgres:hackass_worker:p2\n', { mode: 0o600 });
  return { HOSTED_SELFTEST: '1', STAGING_REF: 'selftest', STAGING_URL: 'http://127.0.0.1:54321', STAGING_MIGRATE_HOST: 'host.docker.internal', STAGING_MIGRATE_PORT: '54322', STAGING_MIGRATE_USER: 'postgres',
    STAGING_POOLER_TXN_HOST: 'host.docker.internal', STAGING_POOLER_TXN_PORT: '54322', STAGING_POOLER_SESSION_HOST: 'host.docker.internal', STAGING_POOLER_SESSION_PORT: '54322',
    STAGING_WORKER_USER: 'hackass_worker', STAGING_PGPASSFILE: pf, STAGING_PUBLISHABLE_KEY: shaped('publishable'), STAGING_SECRET_KEY: shaped('secret'), ...extra } as Record<string, string>;
}
const selfCtx = (env = selfEnv()) => ctxm.createContext(env, { profile: 'selftest' });
const REF = cfg.STAGING.ref as string; const HOST = 'aws-0-us-east-1.pooler.supabase.com';
function stagingCtx() {
  const pf = join(tmp(), 'pgpass');
  writeFileSync(pf, [`${HOST}:5432:postgres:postgres.${REF}:p1`, `${HOST}:6543:postgres:postgres.${REF}:p1`, `${HOST}:5432:postgres:hackass_worker.${REF}:p2`, `${HOST}:6543:postgres:hackass_worker.${REF}:p2`].join('\n') + '\n', { mode: 0o600 });
  return ctxm.createContext({ STAGING_REF: REF, STAGING_URL: `https://${REF}.supabase.co`, STAGING_MIGRATE_HOST: HOST, STAGING_MIGRATE_PORT: '5432', STAGING_MIGRATE_USER: `postgres.${REF}`, STAGING_POOLER_TXN_HOST: HOST, STAGING_POOLER_TXN_PORT: '6543',
    STAGING_POOLER_SESSION_HOST: HOST, STAGING_POOLER_SESSION_PORT: '5432', STAGING_WORKER_USER: `hackass_worker.${REF}`, STAGING_PGPASSFILE: pf, STAGING_PUBLISHABLE_KEY: shaped('publishable'), STAGING_SECRET_KEY: shaped('secret'), FORBIDDEN_PROJECT_REFS: 'oldprojectref0123456' }, { profile: 'staging' });
}
/** A run directory in the selftest base with the given stages done under SHA and a binding to the given environment. */
function preparedRun(env: Record<string, string>, doneStages: string[], extra: Record<string, unknown> = {}) {
  const id = freshRunId();
  const run = state.openRun({ runId: id, profile: 'selftest' });
  const c = selfCtx(env);
  const st = run.state();
  st.binding = { commit: SHA, profile: 'selftest', targets: state.hashTargets(c.targets) };
  for (const s of doneStages) st.stages[s] = { status: 'done', commit: SHA };
  Object.assign(st, extra); run.save(st);
  return { id, run };
}
const argvFor = (id: string, group: string, extra: string[] = []) => ['--profile=selftest', `--run-id=${id}`, `--authorized=${group}@${SHA}`, ...extra];
const quiet = async <T>(f: () => Promise<T>) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };

// ---------- 1. run-state gates fail closed ----------
const flagsFor = (stage: string, extra: Record<string, unknown> = {}) => {
  const g = stage === 'preflight' ? 'S6' : stage === 'cleanup' ? 'S9' : ['identity', 'migrate', 'exposure', 'worker-marker', 'rerun', 'inventory'].includes(stage) ? 'S7' : 'S8';
  return { authorized: `${g}@${SHA}`, ...(stagesMod.STAGES[stage]?.mutating ? { 'confirm-mutating': stage } : {}), ...extra };
};
const st = (map: Record<string, string>, extra: Record<string, unknown> = {}) => ({ binding: { commit: SHA, profile: 'staging', targets: 'T' }, stages: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { status: v, commit: SHA }])), ...extra });
const gate = (stage: string, s: unknown, flags: Record<string, unknown> = flagsFor(stage)) => gates.checkGates(stage, flags, s, git, { profile: 'staging', targetsHash: 'T' });

test('a stage left running (or interrupted) is never restarted automatically, by itself or by any other stage', () => {
  assert.throws(() => gate('identity', st({ preflight: 'done', identity: 'running' })), /not healthy/);
  assert.throws(() => gate('identity', st({ preflight: 'done', identity: 'interrupted' })), /not healthy/);
  assert.throws(() => gate('migrate', st({ preflight: 'done', identity: 'running' })), /not healthy|must be completed/);
});
test('a failed stage blocks later stages: worker checks after failed session checks are refused; only cleanup and evidence continue the run', () => {
  const s = st({ preflight: 'done', identity: 'done', migrate: 'done', exposure: 'done', 'worker-marker': 'done', rerun: 'done', inventory: 'done', fixtures: 'done', 'session-checks': 'failed' });
  assert.throws(() => gate('worker-checks', s), /not healthy/);
  assert.throws(() => gate('catalog-checks', s), /not healthy|must be completed/);
  assert.doesNotThrow(() => gate('cleanup', s));
  assert.doesNotThrow(() => gate('evidence', s, {}));
});
test('a read-only stage may be re-attempted after its own failure only with --retry-after-review; a mutating stage never', () => {
  const s = st({ preflight: 'done', identity: 'done', migrate: 'done', exposure: 'failed' });
  assert.throws(() => gate('exposure', s, flagsFor('exposure', { 'owner-confirmed': 'exposure' })), /not healthy/);
  assert.doesNotThrow(() => gate('exposure', s, flagsFor('exposure', { 'owner-confirmed': 'exposure', 'retry-after-review': true })));
  const m = st({ preflight: 'done', identity: 'failed' });
  assert.throws(() => gate('identity', m, flagsFor('identity', { 'retry-after-review': true })), /not healthy/);
  const two = st({ preflight: 'failed', identity: 'failed' });
  assert.throws(() => gate('preflight', two, flagsFor('preflight', { 'retry-after-review': true })), /not healthy/);
});
test('prerequisites recorded under another commit, and a run bound to another commit, profile or target configuration, are refused', () => {
  const other = { binding: { commit: SHA, profile: 'staging', targets: 'T' }, stages: { preflight: { status: 'done', commit: SHA }, identity: { status: 'done', commit: OTHER_SHA } } };
  assert.throws(() => gate('migrate', other), /recorded under commit/);
  assert.throws(() => gates.checkGates('preflight', flagsFor('preflight'), { binding: { commit: OTHER_SHA, profile: 'staging', targets: 'T' }, stages: {} }, git, { profile: 'staging', targetsHash: 'T' }), /bound to commit/);
  assert.throws(() => gates.checkGates('preflight', flagsFor('preflight'), { binding: { commit: SHA, profile: 'selftest', targets: 'T' }, stages: {} }, git, { profile: 'staging', targetsHash: 'T' }), /bound to the selftest profile/);
  assert.throws(() => gates.checkGates('preflight', flagsFor('preflight'), { binding: { commit: SHA, profile: 'staging', targets: 'T' }, stages: {} }, git, { profile: 'staging', targetsHash: 'DIFFERENT' }), /target configuration differs/);
  assert.throws(() => gates.checkGates('identity', flagsFor('identity'), { stages: { preflight: { status: 'done', commit: SHA } } }, git, { profile: 'staging', targetsHash: 'T' }), /has not been started/);
});
test('cleanup closes the run: no stage except cleanup and evidence may run afterwards', () => {
  const s = st({ preflight: 'done', identity: 'done', migrate: 'done', exposure: 'done', 'worker-marker': 'done', rerun: 'done', inventory: 'done' }, { closed: true });
  assert.throws(() => gate('fixtures', s), /closed/);
  assert.doesNotThrow(() => gate('cleanup', s));
  assert.doesNotThrow(() => gate('evidence', s, {}));
});
test('isolation is a mutating stage and needs its confirmation', () => {
  assert.equal(stagesMod.STAGES.isolation.mutating, true);
  const s = st({ preflight: 'done', identity: 'done', migrate: 'done', exposure: 'done', 'worker-marker': 'done', rerun: 'done', inventory: 'done', fixtures: 'done', 'worker-checks': 'done', 'catalog-checks': 'done' });
  assert.throws(() => gate('isolation', s, { authorized: `S8@${SHA}` }), /confirm-mutating=isolation/);
  assert.doesNotThrow(() => gate('isolation', s));
});
test('flags: unknown flags are refused', () => {
  assert.throws(() => cli.parseFlags(['--run-id=abc', '--password=x']), /unknown flag/);
  assert.deepEqual(cli.parseFlags(['--retry-after-review']), { 'retry-after-review': true });
});

test('a run is locked against concurrent stages; a lock left by a dead process is taken over only by the recovery stages', async () => {
  const id = freshRunId();
  const a = state.openRun({ runId: id, profile: 'selftest' }); const b = state.openRun({ runId: id, profile: 'selftest' });
  a.acquireLock();
  assert.throws(() => b.acquireLock(), /another process/);
  a.releaseLock();
  assert.doesNotThrow(() => b.acquireLock()); b.releaseLock();
  // a lock whose owner is gone
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  mkdirSync(join(a.dir, 'lock'), { mode: 0o700 }); writeFileSync(join(a.dir, 'lock', 'owner.json'), JSON.stringify({ pid: Number(dead), token: 'zz', at: 'x' }));
  assert.throws(() => b.acquireLock(), /died without finishing/);
  assert.doesNotThrow(() => b.acquireLock({ takeoverDead: true })); b.releaseLock();
});
test('two processes cannot execute stages against the same run at once', async () => {
  const id = freshRunId();
  const script = join(tmp(), 'holder.mjs');
  writeFileSync(script, `import { openRun } from ${JSON.stringify(url('lib/state.mjs'))};\nconst r = openRun({ runId: process.argv[2], profile: 'selftest' });\nr.acquireLock();\nconsole.log('LOCKED');\nprocess.stdin.on('end', () => { r.releaseLock(); });\nprocess.stdin.resume();\n`);
  const child = spawn(process.execPath, [script, id], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => { child.stdout.on('data', (d) => { if (String(d).includes('LOCKED')) resolve(); }); child.on('error', reject); setTimeout(() => reject(new Error('holder did not lock')), 10_000); });
  const mine = state.openRun({ runId: id, profile: 'selftest' });
  assert.throws(() => mine.acquireLock(), /another process/);
  assert.throws(() => mine.acquireLock({ takeoverDead: true }), /another process/, 'even recovery stages cannot take a live lock');
  child.stdin.end(); await new Promise((r) => child.on('close', r));
  assert.doesNotThrow(() => mine.acquireLock()); mine.releaseLock();
});

test('an unexpected exception inside a stage is persisted as a failure and blocks the run; cleanup then closes it', async () => {
  const env = selfEnv(); const { id, run } = preparedRun(env, ['preflight']);
  const code = await quiet(() => cli.runStage('identity', argvFor(id, 'S7', ['--confirm-mutating=identity']), async () => { throw new Error('boom: connection reset'); }, { env, git }));
  assert.equal(code, 3);
  const s = run.state();
  assert.equal(s.stages.identity.status, 'failed'); assert.match(s.stages.identity.error, /boom/);
  assert.ok(run.results().some((r: { id: string; status: string }) => r.id === 'STAGE-ERROR' && r.status === 'FAIL'));
  assert.equal(await quiet(() => cli.runStage('migrate', argvFor(id, 'S7', ['--confirm-mutating=migrate']), async () => ({ passed: 1, failed: 0 }), { env, git })), 2);
  assert.equal(await quiet(() => cli.runStage('cleanup', argvFor(id, 'S9', ['--confirm-mutating=cleanup']), async () => ({ passed: 1, failed: 0 }), { env, git })), 0);
  assert.equal(run.state().closed, true);
  assert.equal(await quiet(() => cli.runStage('fixtures', argvFor(id, 'S8', ['--confirm-mutating=fixtures']), async () => ({ passed: 1, failed: 0 }), { env, git })), 2);
});
test('a killed process leaves the stage interrupted: it is not restarted; only recovery stages continue, and they record it as interrupted', async () => {
  const env = selfEnv(); const { id, run } = preparedRun(env, ['preflight']);
  const script = join(tmp(), 'hang.mjs');
  writeFileSync(script, `import { runStage } from ${JSON.stringify(url('lib/cli.mjs'))};\nawait runStage('identity', process.argv.slice(2), async () => { console.log('STARTED'); await new Promise(() => {}); }, { env: process.env, git: { head: ${JSON.stringify(SHA)}, clean: true } });\n`);
  const child = spawn(process.execPath, [script, ...argvFor(id, 'S7', ['--confirm-mutating=identity'])], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => { child.stdout.on('data', (d) => { if (String(d).includes('STARTED')) resolve(); }); setTimeout(() => reject(new Error('stage did not start')), 15_000); });
  child.kill('SIGKILL'); await new Promise((r) => child.on('close', r));
  assert.equal(run.state().stages.identity.status, 'running', 'the killed process could not record anything');
  assert.equal(await quiet(() => cli.runStage('identity', argvFor(id, 'S7', ['--confirm-mutating=identity']), async () => ({ passed: 1, failed: 0 }), { env, git })), 2, 'the interrupted stage must not restart');
  let seen: string | undefined;
  assert.equal(await quiet(() => cli.runStage('evidence', ['--profile=selftest', `--run-id=${id}`], async ({ run: r }: { run: { state: () => { stages: Record<string, { status: string }> } } }) => { seen = r.state().stages.identity.status; return { passed: 1, failed: 0 }; }, { env, git })), 0);
  assert.equal(seen, 'interrupted');
  assert.equal(await quiet(() => cli.runStage('identity', argvFor(id, 'S7', ['--confirm-mutating=identity']), async () => ({ passed: 1, failed: 0 }), { env, git })), 2);
});

// ---------- 2. SQL and stage classification ----------
test('the fixture path has no unrestricted SELECT/WITH fallback: a data-changing CTE is refused', () => {
  const evil = 'WITH changed AS (DELETE FROM app.hacks RETURNING id) SELECT count(*) FROM changed';
  assert.throws(() => guard.checkSql(`set role hackass_owner;\n${evil}`, 'fixture', { fixtureIds: new Set() }), guard.SqlRefused);
  assert.throws(() => guard.checkSql(`set role hackass_owner;\nselect count(*) from app.hacks`, 'fixture'), guard.SqlRefused);
  assert.throws(() => guard.checkSql(evil, 'read'), guard.SqlRefused);
  assert.throws(() => guard.checkSql('select * into app.copy from app.hacks', 'read'), guard.SqlRefused);
});
test('reads cannot carry transaction control that would leave the read-only transaction', () => {
  for (const bad of ['commit', 'begin', 'rollback', 'savepoint a', 'set transaction read write', 'set session characteristics as transaction read write', 'set default_transaction_read_only = off']) assert.throws(() => guard.checkSql(`select 1;\n${bad}`, 'read'), guard.SqlRefused, bad);
});
test('the executor wraps each kind in the transaction its kind requires, so the DATABASE refuses writes in a read', () => {
  const read = pg.wrapScript('read', 'select 1', 10_000);
  assert.match(read, /^begin read only;/); assert.match(read, /rollback;\s*$/); assert.match(read, /statement_timeout/); assert.match(read, /client_connection_check_interval/);
  const show = pg.wrapScript('read', 'show statement_timeout', 10_000);
  assert.ok(!/set local/.test(show), 'role defaults must be read without an override');
  assert.match(pg.wrapScript('probe', 'create table public.x (i int)', 10_000), /^begin;[\s\S]*rollback;\s*$/);
  assert.match(pg.wrapScript('worker', "select worker.healthcheck()", 10_000), /^begin;\nselect worker\.healthcheck\(\);\ncommit;/);
  assert.match(pg.wrapScript('fixture', 'set role hackass_owner;\nselect 1', 10_000), /^begin;[\s\S]*commit;\s*$/);
});
test('worker mutations have their own reviewed path: fixed calls on worker endpoints only, naming only the registered job', async () => {
  const J = '33333333-3333-3333-3333-333333333333';
  const ok = new Set([J]);
  for (const sql of ["select worker.claim_job('publication_recheck')::text", 'select worker.healthcheck()', `select worker.get_job_subject('${J}', 3)::text`, `select worker.heartbeat_job('${J}', 3)`, `select worker.complete_job('${J}', 8)`]) assert.deepEqual(guard.checkSql(sql, 'worker', { allowedJobIds: ok }), [sql]);
  assert.throws(() => guard.checkSql(`select worker.complete_job('${J}', 3)`, 'worker', { allowedJobIds: new Set() }), /not registered/);
  for (const bad of ['select app.jobs', 'select worker.claim_job(\'publication_recheck\'); select 1', "select worker.claim_job('other')", "update app.jobs set status = 'x'"]) assert.throws(() => guard.checkSql(bad, 'worker', { allowedJobIds: ok }), guard.SqlRefused, bad);
  const c = selfCtx();
  await assert.rejects(() => pg.runSql(c, 'migrate', 'select worker.healthcheck()', { kind: 'worker' }), /may not run on the migrate endpoint/);
  await assert.rejects(() => pg.runSql(c, 'worker-txn', "comment on role hackass_worker is null", { kind: 'admin' }), /may not run on the worker-txn endpoint/);
  await assert.rejects(() => pg.runSql(c, 'worker-txn', 'select 1', { kind: 'fixture' }), /may not run/);
});
test('runSql has no password-file or login override', async () => {
  const c = selfCtx();
  await assert.rejects(() => pg.runSql(c, 'migrate', 'select 1', { passfile: '/etc/passwd' }), /unknown database option/);
  await assert.rejects(() => pg.runSql(c, 'migrate', 'select 1', { login: 'hackass_worker' }), /unknown database option/);
});

// ---------- 3. cleanup covers interrupted creation ----------
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
async function cleanupRun(users: Record<string, { id: string; email: string }>, intents: { email: string; id?: string }[]) {
  const { run } = preparedRun(selfEnv(), ['preflight'], { fixtures: { users }, intents });
  writeFileSync(join(run.dir, 'secrets.json'), '{"users":{}}', { mode: 0o600 });
  return run;
}
const fakeRequest = (log: string[], opts: { fail?: Set<string> } = {}) => async (_c: unknown, r: { method?: string; path: string }) => {
  if (r.method === 'DELETE') { const id = r.path.split('/').pop() as string; log.push(id); return { status: opts.fail?.has(id) ? 500 : 200, body: null, text: null }; }
  return { status: 200, body: { users: [] }, text: null };
};
test('cleanup attempts every independent step even when one fails, and still reports failure', async () => {
  assert.ok(cleanupLib, 'lib/cleanup.mjs exists');
  const run = await cleanupRun({ b1: { id: uuid(1), email: 'a@example.test' } }, []);
  const out = await quiet(() => cleanupLib.runCleanup({ ctx: selfCtx(), run, say: () => {}, deps: {
    findUsers: async () => { throw new Error('admin list unavailable'); }, request: fakeRequest([]),
    queryText: async (_c: unknown, _e: string, sql: string) => (/to_regclass/.test(sql) ? 'false' : /pg_roles/.test(sql) ? 'false' : ''), queryJson: async () => ({}), runSql: async () => ({ ok: true, stdout: '', stderr: '' }) } }));
  assert.equal(out.failed, 1, 'H13a failed');
  const ids = run.results().map((r: { id: string; status: string }) => `${r.id}:${r.status}`);
  assert.deepEqual(ids, ['H13a:FAIL', 'H13b:PASS', 'H13c:PASS'], 'the later steps were still attempted');
  assert.ok(!existsSync(join(run.dir, 'secrets.json')), 'the secrets file was deleted although H13a failed');
});
test('cleanup deletes every recorded user even when one deletion fails, and works before application tables or the worker role exist', async () => {
  const log: string[] = [];
  const run = await cleanupRun({ a: { id: uuid(1), email: 'a@example.test' }, b: { id: uuid(2), email: 'b@example.test' } }, []);
  const calls: string[] = [];
  const out = await quiet(() => cleanupLib.runCleanup({ ctx: selfCtx(), run, say: () => {}, deps: {
    findUsers: async () => new Map(), request: fakeRequest(log, { fail: new Set([uuid(1)]) }),
    queryText: async (_c: unknown, _e: string, sql: string) => { calls.push(sql); return 'false'; }, queryJson: async () => { throw new Error('no application tables: must not be queried'); }, runSql: async () => { throw new Error('no worker role: must not be commented'); } } }));
  assert.deepEqual(log.sort(), [uuid(1), uuid(2)], 'both users were attempted');
  assert.equal(out.failed, 1); assert.equal(out.passed, 2);
  assert.ok(calls.some((s) => /to_regclass\('app\.accounts'\)/.test(s)) && calls.some((s) => /pg_roles/.test(s)), 'existence of tables and role was checked first');
});
test('an interrupted creation is recovered by its exact recorded e-mail, page by page, and no unrelated user is ever touched', async () => {
  const pages = [{ users: [{ id: uuid(9), email: 'someone.else@example.test' }, { id: uuid(5), email: 'Target@Example.test' }] }, { users: [{ id: uuid(8), email: 'target2@example.test' }] }, { users: [] }];
  let seen = 0;
  const req = async (_c: unknown, r: { path: string }) => { const m = /page=(\d+)/.exec(r.path); seen = Math.max(seen, Number(m?.[1])); return { status: 200, body: pages[Number(m?.[1]) - 1] ?? { users: [] }, text: null }; };
  const found = await flows.adminFindUsersByEmails(selfCtx(), ['target@example.test'], { perPage: 2, req });
  assert.deepEqual([...found.keys()], ['target@example.test']); assert.equal(found.get('target@example.test').id, uuid(5));
  assert.equal(seen, 3, 'the walk continued to the empty page');
  const log: string[] = [];
  const run = await cleanupRun({}, [{ email: 'target@example.test' }]);
  const deleted = new Set<string>();
  const out = await quiet(() => cleanupLib.runCleanup({ ctx: selfCtx(), run, say: () => {}, deps: {
    findUsers: async (c: unknown, emails: string[], o: unknown) => (deleted.size ? new Map() : flows.adminFindUsersByEmails(c, emails, { ...(o as object), perPage: 2, req: async (cc: unknown, r: { path: string; method?: string }) => req(cc, r) })),
    request: async (_c: unknown, r: { method?: string; path: string }) => { if (r.method === 'DELETE') { const id = r.path.split('/').pop() as string; log.push(id); deleted.add(id); return { status: 200, body: null, text: null }; } return req(_c, r); },
    queryText: async () => 'false', queryJson: async () => ({}), runSql: async () => ({ ok: true, stdout: '', stderr: '' }) } }));
  assert.equal(out.failed, 0); assert.deepEqual(log, [uuid(5)], 'only the exact recorded identity was deleted');
});
test('creation intents are persisted before the Auth request (identity check and every fixture user)', () => {
  const id = freshRunId(); const run = state.openRun({ runId: id, profile: 'selftest' });
  run.addIntent({ kind: 'fixture', name: 'b1', email: 'x@example.test' }); run.addIntent({ kind: 'fixture', name: 'b1', email: 'x@example.test' });
  assert.equal(run.state().intents.length, 1); run.completeIntent('x@example.test', uuid(3)); assert.equal(run.state().intents[0].id, uuid(3));
  for (const f of ['fixtures.mjs', 's7-apply.mjs']) {
    const t = readFileSync(join(root, 'scripts/hosted', f), 'utf8');
    assert.ok(t.indexOf('addIntent') > 0 && t.indexOf('addIntent') < t.indexOf('adminCreateUser(ctx'), `${f} records the intent before the request`);
  }
});

// ---------- 4. deadlines stop the underlying operation ----------
test('a bounded child is killed with its whole process group at the deadline', async () => {
  const r = await execMod.runBounded('sh', ['-c', 'sleep 30 & echo $!; wait'], { timeoutMs: 600 });
  assert.equal(r.timedOut, true);
  const pid = Number(r.stdout.trim().split('\n')[0]);
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the grandchild must be gone');
});
test('git subprocesses are bounded and never prompt', () => {
  const bin = tmp(); writeFileSync(join(bin, 'git'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const saved = process.env.PATH; process.env.PATH = `${bin}:${saved}`;
  try { const t0 = Date.now(); const g = gates.gitState(root, { timeoutMs: 400 }); assert.equal(g.head, ''); assert.equal(g.clean, false); assert.ok(Date.now() - t0 < 5_000); } finally { process.env.PATH = saved; }
  assert.match(readFileSync(join(root, 'scripts/hosted/lib/gates.mjs'), 'utf8'), /GIT_TERMINAL_PROMPT/);
});
/** A stand-in container runtime: records every call, keeps a marker for a running container, and removes it on `rm -f` unless told not to. */
function stubDocker(opts: { rmWorks?: boolean; psHangs?: boolean } = {}) {
  const dir = tmp(); const log = join(dir, 'calls.log'); const marker = join(dir, 'running');
  const script = join(dir, 'docker');
  writeFileSync(script, `#!/bin/sh
echo "$@" >> ${JSON.stringify(log)}
case "$1" in
  run) for a in "$@"; do case "$prev" in --name) echo "$a" > ${JSON.stringify(marker)};; esac; prev="$a"; done; cat > /dev/null & sleep 30; ;;
  rm) ${opts.rmWorks === false ? ':' : `rm -f ${JSON.stringify(marker)}`} ;;
  ps) ${opts.psHangs ? 'exec sleep 30' : ':'}; [ -f ${JSON.stringify(marker)} ] && cat ${JSON.stringify(marker)}; true ;;
esac
`, { mode: 0o755 });
  return { bin: script, log, marker, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}
test('a database call past its deadline: the client is killed, the NAMED container is removed and its absence verified', async () => {
  const d = stubDocker(); process.env.DOCKER_BIN = d.bin;
  try {
    await assert.rejects(() => pg.runSql(selfCtx(), 'migrate', 'select pg_sleep(30)', { kind: 'read', timeoutMs: 2500 }), (e: { containerRemoved?: boolean; message: string }) => e.containerRemoved === true && /container was removed/.test(e.message));
    const calls = d.calls();
    assert.ok(calls.some((c) => /^rm -f hackass-psql-/.test(c)), 'docker rm -f <name> was run');
    assert.ok(calls.some((c) => /^ps -a -q --filter name=\^hackass-psql-/.test(c)), 'absence was verified with docker ps');
    assert.ok(!existsSync(d.marker), 'no container survives');
    const run = calls.find((c) => c.startsWith('run '))!;
    assert.match(run, /--name hackass-psql-/); assert.match(run, / -w /); assert.match(run, / -q /); assert.match(run, /:\/pgpass:ro/); assert.match(run, /-e PGPASSFILE=\/pgpass/); assert.match(run, /application_name=hackass-psql-/);
    assert.ok(!/PGPASSWORD|password=/i.test(run), 'no password in any argument');
  } finally { delete process.env.DOCKER_BIN; }
});
test('if the container cannot be proved gone the failure says so', async () => {
  const d = stubDocker({ rmWorks: false }); process.env.DOCKER_BIN = d.bin;
  try { await assert.rejects(() => pg.runSql(selfCtx(), 'migrate', 'select 1', { kind: 'read', timeoutMs: 2500 }), (e: { containerRemoved?: boolean; message: string }) => e.containerRemoved === false && /may survive/.test(e.message)); } finally { delete process.env.DOCKER_BIN; }
});
/** Plays the container daemon of the stub: once `trigger` ('run' or the first 'rm') has been logged it creates the container (the marker) `delayMs` later, whatever happened to the client in the meantime. */
function lateDaemon(d: { log: string; marker: string; calls: () => string[] }, delayMs: number, trigger: 'run' | 'rm' = 'run') {
  let created = false; const t = setInterval(() => { if (!created && d.calls().some((c) => c.startsWith(`${trigger} `))) { created = true; setTimeout(() => writeFileSync(d.marker, 'late\n'), delayMs); } }, 20);
  return () => clearInterval(t);
}
test('a container the daemon creates AFTER the first removal is still removed (deadline path)', async () => {
  const d = stubDocker(); process.env.DOCKER_BIN = d.bin; const stop = lateDaemon(d, 600);
  try {
    await assert.rejects(() => pg.runSql(selfCtx(), 'migrate', 'select pg_sleep(30)', { kind: 'read', timeoutMs: 300 }), (e: { containerRemoved?: boolean }) => e.containerRemoved === true);
    assert.ok(d.calls().filter((c) => c.startsWith('rm -f ')).length >= 2, 'removal was repeated');
    await new Promise((res) => setTimeout(res, 800));
    assert.ok(!existsSync(d.marker), 'no container survives, including one created after the first removal');
  } finally { stop(); delete process.env.DOCKER_BIN; }
});
test('a container the daemon creates AFTER the interrupt handler started is still removed (signal path)', async () => {
  const d = stubDocker(); const stop = lateDaemon(d, 600);
  const script = `import { pathToFileURL } from 'node:url'; import { existsSync } from 'node:fs';
const [pg, ctxm, ex] = await Promise.all(['lib/pg.mjs', 'lib/context.mjs', 'lib/exec.mjs'].map((f) => import(pathToFileURL(process.argv[1] + '/scripts/hosted/' + f).href)));
const ctx = ctxm.createContext(JSON.parse(process.env.CTX_ENV), { profile: 'selftest' });
pg.runSql(ctx, 'migrate', 'select pg_sleep(30)', { kind: 'read', timeoutMs: 60000 }).catch(() => {});
for (let i = 0; i < 400 && !existsSync(process.env.MARKER); i++) await new Promise((r) => setTimeout(r, 25)); // the stub client has really started
ex.killActiveChildren(); const survivors = pg.reapInflightContainers(); console.log(JSON.stringify(survivors));`;
  try {
    // asynchronous spawn: the daemon stand-in above must keep running in this process while the child is inside its synchronous reap
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { env: { ...process.env, DOCKER_BIN: d.bin, CTX_ENV: JSON.stringify(selfEnv()), MARKER: d.marker } });
    let out = ''; let err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    const code = await new Promise((res) => child.on('close', res));
    assert.equal(code, 0, err); assert.deepEqual(JSON.parse(out.trim()), [], 'nothing reported as surviving');
    await new Promise((res) => setTimeout(res, 800));
    assert.ok(!existsSync(d.marker), 'no container survives');
  } finally { stop(); }
});
type Verdict = { name: string; state: string; detail: string };
/** Runs a database call in a child process, then (after 300 ms, as the interrupt handler would) kills its children and reaps its containers with the given options; returns what the reap returned and how long it took. */
async function reapInChild(d: { bin: string; marker: string; calls: () => string[] }, reapOpts: { windowMs?: number; quietMs?: number }, lateMs: number | null) {
  const stop = lateMs === null ? () => {} : lateDaemon(d, lateMs, 'rm'); // measured from the first removal, so machine load moves both ends together
  const script = `import { pathToFileURL } from 'node:url'; import { existsSync } from 'node:fs';
const [pg, ctxm, ex] = await Promise.all(['lib/pg.mjs', 'lib/context.mjs', 'lib/exec.mjs'].map((f) => import(pathToFileURL(process.argv[1] + '/scripts/hosted/' + f).href)));
const ctx = ctxm.createContext(JSON.parse(process.env.CTX_ENV), { profile: 'selftest' });
pg.runSql(ctx, 'migrate', 'select pg_sleep(30)', { kind: 'read', timeoutMs: 60000 }).catch(() => {});
for (let i = 0; i < 400 && !existsSync(process.env.MARKER); i++) await new Promise((r) => setTimeout(r, 25)); // the stub client has really started
ex.killActiveChildren(); const t0 = Date.now(); const left = pg.reapInflightContainers(JSON.parse(process.env.REAP_OPTS)); console.log(JSON.stringify({ left, ms: Date.now() - t0 }));`;
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { env: { ...process.env, DOCKER_BIN: d.bin, CTX_ENV: JSON.stringify(selfEnv()), REAP_OPTS: JSON.stringify(reapOpts), MARKER: d.marker } });
    let out = ''; let err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    const code = await new Promise((res) => child.on('close', res)); assert.equal(code, 0, err);
    return JSON.parse(out.trim()) as { left: Verdict[]; ms: number };
  } finally { stop(); }
}
test('a creation delayed beyond the quiet period is a KNOWN LIMIT of the observation; a longer quiet period catches it', async () => {
  const d1 = stubDocker(); const r1 = await reapInChild(d1, {}, 2500); // defaults: 1 s quiet, 3 s window; the container appears 2.5 s after the first removal
  assert.deepEqual(r1.left, [], 'the default quiet period (1 s) has ended: the reap reports nothing unresolved');
  await new Promise((res) => setTimeout(res, 2500));
  assert.ok(existsSync(d1.marker), 'and the late container then exists: the quiet period is an observation, not a guarantee');
  const d2 = stubDocker(); const r2 = await reapInChild(d2, { windowMs: 8000, quietMs: 3000 }, 1500); // appears at 1.5 s, inside the 3 s quiet period
  assert.deepEqual(r2.left, []); await new Promise((res) => setTimeout(res, 800));
  assert.ok(!existsSync(d2.marker), 'a quiet period longer than the delay removes it');
});
test('deadline expiry distinguishes "absent, quiet period incomplete" from "absence not established" (signal path and deadline path)', async () => {
  const d = stubDocker();
  const incomplete = await reapInChild(d, { windowMs: 1500, quietMs: 3000 }, null);
  assert.equal(incomplete.left.length, 1); assert.equal(incomplete.left[0].state, 'quiet-incomplete'); assert.match(incomplete.left[0].detail, /absent at the last check, but not for the whole 3000 ms quiet period/); assert.match(incomplete.left[0].name, /^hackass-psql-/);
  assert.ok(incomplete.ms < 3000, `bounded by the window (${incomplete.ms} ms)`);
  const stuck = stubDocker({ rmWorks: false });
  const present = await reapInChild(stuck, { windowMs: 1200, quietMs: 500 }, null);
  assert.equal(present.left.length, 1); assert.equal(present.left[0].state, 'not-established'); assert.equal(present.left[0].detail, 'container still present');
  // the same two verdicts from the deadline path
  const e = stubDocker(); process.env.DOCKER_BIN = e.bin;
  try {
    const a = await pg.removeContainer('hackass-psql-x-0', { windowMs: 1200, quietMs: 3000 }); assert.deepEqual([a.removed, a.state], [false, 'quiet-incomplete']);
    const ok = await pg.removeContainer('hackass-psql-x-1', { windowMs: 3000, quietMs: 400 }); assert.deepEqual([ok.removed, ok.state], [true, 'removed']);
    writeFileSync(e.marker, 'x\n'); const e2 = stubDocker({ rmWorks: false }); process.env.DOCKER_BIN = e2.bin; writeFileSync(e2.marker, 'x\n');
    const b = await pg.removeContainer('hackass-psql-x-2', { windowMs: 1200, quietMs: 500 }); assert.deepEqual([b.removed, b.state, b.detail], [false, 'not-established', 'container still present']);
  } finally { delete process.env.DOCKER_BIN; }
});
test('slow docker calls cannot outlast the window: a hanging `docker ps` is "not established" and bounded', async () => {
  const d = stubDocker({ psHangs: true });
  const r = await reapInChild(d, { windowMs: 1500, quietMs: 500 }, null);
  assert.equal(r.left.length, 1); assert.equal(r.left[0].state, 'not-established'); assert.match(r.left[0].detail, /docker ps timed out/);
  assert.ok(r.ms < 5000, `the sync reap returned in ${r.ms} ms despite a ps that never answers`);
  process.env.DOCKER_BIN = d.bin;
  try {
    const t0 = Date.now(); const a = await pg.removeContainer('hackass-psql-y-0', { windowMs: 1500, quietMs: 500 });
    assert.deepEqual([a.removed, a.state, a.detail], [false, 'not-established', 'docker ps timed out']); assert.ok(Date.now() - t0 < 5000, 'bounded');
  } finally { delete process.env.DOCKER_BIN; }
});
test('an interrupted stage whose container cleanup is NOT PROVEN stays interrupted, records and prints the names, and exits 130', async () => {
  for (const rmWorks of [false, true]) {
    const d = stubDocker({ rmWorks }); const id = freshRunId();
    const script = `import { pathToFileURL } from 'node:url'; import { existsSync } from 'node:fs';
const [cli, pg, ctxm] = await Promise.all(['lib/cli.mjs', 'lib/pg.mjs', 'lib/context.mjs'].map((f) => import(pathToFileURL(process.argv[1] + '/scripts/hosted/' + f).href)));
const env = JSON.parse(process.env.CTX_ENV);
await cli.runStage('preflight', ['--profile=selftest', '--run-id=' + process.env.RUN_ID, '--authorized=S6@' + 'a'.repeat(40)], async ({ ctx }) => {
  pg.runSql(ctx, 'migrate', 'select pg_sleep(30)', { kind: 'read', timeoutMs: 60000 }).catch((e) => console.log('RUNSQL-ERR ' + e.message));
  for (let i = 0; i < 400 && !existsSync(process.env.MARKER); i++) await new Promise((r) => setTimeout(r, 25)); // the stub client has really started
  process.kill(process.pid, 'SIGTERM'); await new Promise((r) => setTimeout(r, 30000));
}, { env, git: { head: 'a'.repeat(40), clean: true }, repoRoot: process.argv[1] });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, root], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, DOCKER_BIN: d.bin, CTX_ENV: JSON.stringify(selfEnv()), RUN_ID: id, MARKER: d.marker } });
    assert.equal(r.status, 130, r.stdout + r.stderr);
    const st = JSON.parse(readFileSync(join(state.runBase('selftest'), id, 'state.json'), 'utf8')).stages.preflight;
    assert.equal(st.status, 'interrupted', 'never done, never failed-open');
    if (rmWorks) { assert.ok(!/NOT PROVEN/.test(r.stdout + r.stderr) && st.cleanup === undefined && st.error === 'received SIGTERM', 'a proven cleanup records nothing extra'); continue; }
    assert.match(r.stderr, /cleanup NOT PROVEN: hackass-psql-\d+-[a-z0-9]+-0 \(not-established: container still present\)/);
    assert.equal(st.cleanup.status, 'NOT PROVEN'); assert.match(st.cleanup.containers[0].name, /^hackass-psql-/); assert.equal(st.cleanup.containers[0].state, 'not-established');
    assert.match(st.error, /received SIGTERM; cleanup NOT PROVEN: hackass-psql-/);
    const results = readFileSync(join(state.runBase('selftest'), id, 'results.jsonl'), 'utf8');
    assert.match(results, /"id":"CLEANUP-NOT-PROVEN"/);
  }
});
test('truncated or timed-out migration output is rejected, never trusted', () => {
  assert.ok(push, 'lib/push.mjs exists');
  const good = { code: 0, stdout: '{"type":"result","data":{"upToDate":true,"migrations":[]}}\n', stderr: '', timedOut: false, truncated: false };
  assert.deepEqual(push.parsePushResult(good), { upToDate: true, migrations: [] });
  assert.throws(() => push.parsePushResult({ ...good, truncated: true }), /truncated/);
  assert.throws(() => push.parsePushResult({ ...good, timedOut: true }), /deadline/);
  assert.throws(() => push.parsePushResult({ ...good, code: 1 }), /failed/);
  assert.throws(() => push.parsePushResult({ ...good, stdout: '' }), /no result document/);
});

// ---------- 5. verification results ----------
test('a generic 4xx is not isolation evidence: only the expected schema-exclusion refusal is accepted', () => {
  assert.ok(refusal, 'lib/refusal.mjs exists');
  const excluded = { status: 406, body: { code: 'PGRST106', hint: 'Only the following schemas are exposed: api', message: 'Invalid schema: app' } };
  assert.equal(refusal.classifyRefusal(excluded).kind, 'schema-excluded');
  assert.deepEqual(refusal.exposedSchemas(excluded), ['api']);
  assert.doesNotThrow(() => refusal.requireSchemaExcluded(excluded, 'x', { expectExact: ['api'] }));
  for (const [r, kind] of [[{ status: 429, body: { message: 'rate limited' } }, 'rate-limited'], [{ status: 404, body: { code: 'PGRST202' } }, 'not-found'], [{ status: 404, body: { code: 'PGRST205' } }, 'not-found'], [{ status: 400, body: { code: 'PGRST102' } }, 'malformed'], [{ status: 401, body: { code: '42501' } }, 'authorization-denied'], [{ status: 200, body: [] }, 'success'], [{ status: 503, body: null }, 'server-error']] as const) {
    assert.equal(refusal.classifyRefusal(r).kind, kind);
    assert.throws(() => refusal.requireSchemaExcluded(r, 'probe'), /expected a schema-exclusion refusal|rate limited/);
  }
  assert.throws(() => refusal.requireSchemaExcluded({ status: 406, body: { code: 'PGRST106', hint: 'Only the following schemas are exposed: api, app', message: 'x' } }, 'p'), /private schema is exposed/);
  assert.throws(() => refusal.requireSchemaExcluded({ status: 406, body: { code: 'PGRST106', hint: 'Only the following schemas are exposed: public, graphql_public, api', message: 'x' } }, 'p', { expectExact: ['api'] }), /expected exactly api/);
});
test('the isolation and exposure stages use the strict checks, including public and graphql_public', () => {
  const iso = readFileSync(join(root, 'scripts/hosted/isolation.mjs'), 'utf8'); const exp = readFileSync(join(root, 'scripts/hosted/s7-verify.mjs'), 'utf8');
  assert.match(iso, /requireSchemaExcluded/); assert.match(iso, /graphql_public/); assert.ok(!/r\.status >= 400 && r\.status < 500/.test(iso.split("H12b")[1].split("H12c")[0]), 'phase 2 no longer accepts any 4xx');
  assert.match(exp, /graphql_public/); assert.match(exp, /requireSchemaExcluded/);
});
test('the inventory covers row-level security and effective column and sequence privileges', () => {
  for (const needle of [/column_privileges/, /has_column_privilege/, /sequence_privileges/, /has_sequence_privilege/, /tables_without_rls/, /relrowsecurity/]) assert.match(sqlLib.PRIVS_SQL, needle);
  const v = readFileSync(join(root, 'scripts/hosted/s7-verify.mjs'), 'utf8');
  for (const needle of [/p\.column_privileges === 0/, /p\.sequence_privileges === 0/, /tables_without_rls/]) assert.match(v, needle);
});

// ---------- 6. evidence ----------
const REQUIRED = ['H0', 'H1a', 'H1b', 'H2a', 'H2b', 'H2c', 'H3', 'H4', 'H5a', 'FX0', 'H5b', 'FX1', 'H6', 'H7', 'H8', 'H8-default', 'H9', 'H10', 'H11', 'H12a', 'H12b', 'H12c', 'H13a', 'H13b', 'H13c'];
const allStagesDone = () => Object.fromEntries(['preflight', 'identity', 'migrate', 'exposure', 'worker-marker', 'rerun', 'inventory', 'fixtures', 'session-checks', 'worker-checks', 'catalog-checks', 'isolation', 'cleanup'].map((s) => [s, { status: 'done', commit: SHA }]));
const pass = (ids: string[]) => ids.map((id) => ({ id, status: 'PASS', ms: 1, facts: 'ok' }));
test('evidence distinguishes COMPLETE, INCOMPLETE and FAILED; "no check failed" never means complete', () => {
  assert.ok(model, 'lib/evidence-model.mjs exists');
  const full = { stages: allStagesDone(), facts: { owner_deletion_date: '2099-01-01' } };
  assert.equal(model.evaluateRun(full, pass(REQUIRED)).outcome, 'COMPLETE');
  const noMfa = model.evaluateRun(full, pass(REQUIRED.filter((i) => i !== 'H8-default')));
  assert.equal(noMfa.outcome, 'INCOMPLETE'); assert.deepEqual(noMfa.notRun, ['H8-default']);
  assert.equal(model.evaluateRun({ ...full, facts: {} }, pass(REQUIRED)).outcome, 'INCOMPLETE');
  assert.equal(model.evaluateRun({ ...full, facts: { owner_deletion_date: '2026-02-30' } }, pass(REQUIRED)).outcome, 'INCOMPLETE');
  assert.equal(model.evaluateRun({ stages: { preflight: { status: 'done' } }, facts: {} }, pass(['H0', 'H1a'])).outcome, 'INCOMPLETE');
  assert.equal(model.evaluateRun(full, [...pass(REQUIRED.filter((i) => i !== 'H9')), { id: 'H9', status: 'FAIL', error: 'x' }]).outcome, 'FAILED');
  assert.equal(model.evaluateRun(full, [...pass(REQUIRED), { id: 'STAGE-ERROR', stage: 'identity', status: 'FAIL', error: 'boom' }]).outcome, 'FAILED');
  assert.equal(model.evaluateRun({ ...full, stages: { ...full.stages, rerun: { status: 'interrupted' } } }, pass(REQUIRED)).outcome, 'FAILED');
  assert.equal(model.evaluateRun({ ...full, stages: { ...full.stages, cleanup: { status: 'failed' } } }, pass(REQUIRED)).outcome, 'FAILED');
  assert.ok(model.OWNER_ACTIONS.length >= 3, 'owner cleanup is listed as outstanding');
});
test('the owner deletion date must be a real, current calendar date', () => {
  assert.ok(dates, 'lib/dates.mjs exists');
  const now = Date.UTC(2026, 9, 15);
  assert.equal(dates.validateOwnerDate('2026-10-15', now), '2026-10-15'); assert.equal(dates.validateOwnerDate('2027-01-01', now), '2027-01-01');
  for (const bad of ['2026-02-30', '2026-13-01', '15-10-2026', '2026-10-14', '2028-01-01', '', 'tomorrow']) assert.throws(() => dates.validateOwnerDate(bad, now), /deletion date/, bad);
});
/** Run the evidence stage in a SEPARATE process, as the real flow does after cleanup has deleted the secrets file. */
function evidenceProcess(id: string, extra: string[] = []) {
  return spawnSync(process.execPath, [join(root, 'scripts/hosted/evidence.mjs'), '--profile=selftest', `--run-id=${id}`, ...extra], { env: { ...process.env, HOSTED_SELFTEST: '1' }, encoding: 'utf8', cwd: root });
}
test('evidence is produced for a failed run, in a separate process, and still removes secrets after the secrets file is deleted', () => {
  const id = freshRunId(); const run = state.openRun({ runId: id, profile: 'selftest' });
  run.acquireLock(); run.initRedaction(); // redaction state exists only under the run lock
  const secret = `Pw-${'z9'.repeat(12)}`; redact.registerSecret(secret); // this process registers it; only its salted hash is stored
  run.releaseLock();
  const st2 = run.state(); st2.stages = { preflight: { status: 'done', commit: SHA }, identity: { status: 'failed', commit: SHA, error: 'boom' } }; st2.closed = true; run.save(st2);
  appendFileSync(join(run.dir, 'results.jsonl'), JSON.stringify({ id: 'H1b', status: 'FAIL', error: `leaked ${secret} in a message`, ms: 3 }) + '\n'); // a leak that slipped past write-time redaction
  assert.ok(!existsSync(join(run.dir, 'secrets.json')), 'no secrets file exists');
  const rawHashes = readFileSync(join(run.dir, 'redaction.hashes'), 'utf8'); assert.ok(!rawHashes.includes(secret), 'the secret itself is not retained');
  const r = evidenceProcess(id);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const file = readdirSync(run.dir).find((f: string) => f.endsWith('.md'))!;
  const text = readFileSync(join(run.dir, file), 'utf8');
  assert.match(text, /\*\*Outcome: FAILED\*\*/); assert.ok(!text.includes(secret), 'the secret was removed in the separate process'); assert.match(text, /\[REDACTED\]/);
  assert.match(text, /H8-default \| NOT RUN \|/); assert.match(text, /Owner cleanup outstanding/); assert.match(text, /NOT RECORDED/);
});
test('evidence refuses to delete the raw run before script cleanup is done', () => {
  const id = freshRunId(); const run = state.openRun({ runId: id, profile: 'selftest' });
  const r = evidenceProcess(id, ['--delete-raw']);
  assert.notEqual(r.status, 0); assert.ok(existsSync(run.dir), 'the run directory is still there');
});

// ---------- 7. credential files at every entry point ----------
test('credential files must be private regular files outside the checkout, wherever they are read or mounted', () => {
  assert.ok(secretfile, 'lib/secretfile.mjs exists');
  const dir = tmp(); const good = join(dir, 'k'); writeFileSync(good, 'x', { mode: 0o600 });
  assert.deepEqual(secretfile.privateFileProblems(good, { label: 'f' }), []);
  const open = join(dir, 'open'); writeFileSync(open, 'x', { mode: 0o640 }); chmodSync(open, 0o640);
  assert.match(secretfile.privateFileProblems(open, { label: 'f' }).join(), /mode must be 0600/);
  const link = join(dir, 'link'); symlinkSync(good, link);
  assert.match(secretfile.privateFileProblems(link, { label: 'f' }).join(), /symbolic link/);
  assert.match(secretfile.privateFileProblems(dir, { label: 'f' }).join(), /not a regular file/);
  assert.match(secretfile.privateFileProblems(join(root, 'package.json'), { label: 'f' }).join(), /inside the repository/);
  assert.match(secretfile.privateFileProblems('relative', { label: 'f' }).join(), /absolute/);
  assert.match(secretfile.privateFileProblems(good, { label: 'f', uid: (process.getuid?.() ?? 0) + 1 }).join(), /not owned/);
  assert.throws(() => secretfile.assertPrivateFile(open), /mode must be 0600/);
});
test('API-key files are validated before they are read', () => {
  const dir = tmp(); const key = join(dir, 'key'); writeFileSync(key, `${shaped('secret')}\n`, { mode: 0o600 });
  assert.equal(cli.readEnv({ STAGING_SECRET_KEY_FILE: key }, { repoRoot: root }).STAGING_SECRET_KEY, shaped('secret'));
  const loose = join(dir, 'loose'); writeFileSync(loose, 'x', { mode: 0o644 }); chmodSync(loose, 0o644);
  assert.throws(() => cli.readEnv({ STAGING_SECRET_KEY_FILE: loose }, { repoRoot: root }), /STAGING_SECRET_KEY_FILE mode must be 0600/);
  const link = join(dir, 'l'); symlinkSync(key, link);
  assert.throws(() => cli.readEnv({ STAGING_PUBLISHABLE_KEY_FILE: link }, { repoRoot: root }), /symbolic link/);
  assert.throws(() => cli.readEnv({ STAGING_SECRET_KEY_FILE: join(root, 'package.json') }, { repoRoot: root }), /inside the repository/);
});
test('the wrong-password probe can name only the exact worker login and the exact nonexistent login, with its own password file', async () => {
  const c = stagingCtx();
  assert.deepEqual(pg.probeLogins(c), { real: `hackass_worker.${REF}`, fake: `hackass_nonexistent.${REF}` });
  assert.throws(() => pg.probeLogins({ profile: 'staging', targets: { ref: REF, workerUser: 'postgres' } }), /exact form/);
  assert.throws(() => pg.probeLogins({ profile: 'staging', targets: { ref: REF, workerUser: `hackass_worker.${REF}x` } }), /exact form/);
  const d = stubDocker(); process.env.DOCKER_BIN = d.bin; const runDir = tmp();
  const seen: string[] = [];
  const origRun = d.bin;
  try {
    // the stub returns immediately for the probe: replace its `run` branch with an instant failure that records the arguments
    writeFileSync(origRun, `#!/bin/sh\necho "$@" >> ${JSON.stringify(d.log)}\nexit 2\n`, { mode: 0o755 });
    const r = await pg.wrongPasswordProbe(c, runDir);
    assert.equal(r.real.ok, false); assert.equal(r.fake.ok, false);
    for (const line of d.calls()) { seen.push(line); assert.match(line, / -w /); assert.match(line, new RegExp(`user=hackass_(worker|nonexistent)\\.${REF}`)); assert.match(line, /:\/pgpass:ro/); }
    assert.equal(seen.length, 2);
    assert.ok(!existsSync(join(runDir, 'wrong-pgpass')), 'the probe password file is removed');
    assert.ok(!seen.join('\n').includes('deliberately-wrong'), 'the placeholder password is not in any argument');
  } finally { delete process.env.DOCKER_BIN; }
});
test('the common entry validates the deletion date before touching the run', async () => {
  const env = selfEnv(); const { id, run } = preparedRun(env, ['preflight']);
  const before = JSON.stringify(run.state());
  assert.equal(await quiet(() => cli.runStage('cleanup', argvFor(id, 'S9', ['--confirm-mutating=cleanup', '--owner-deletion-date=2026-02-30']), async () => ({ passed: 1, failed: 0 }), { env, git })), 2);
  assert.equal(JSON.stringify(run.state()), before, 'the run was left untouched');
});
test('hash-based redaction survives the secrets file', () => {
  const id = freshRunId(); const run = state.openRun({ runId: id, profile: 'selftest' });
  run.acquireLock(); run.initRedaction();
  const s = `Tk-${'q7'.repeat(10)}`; redact.registerSecret(s);
  run.releaseLock();
  redact.clearRegisteredSecrets();
  const again = state.openRun({ runId: id, profile: 'selftest' }); // a new process would do exactly this: take the lock, then reload the stored salt and hashes
  again.acquireLock(); again.initRedaction(); again.releaseLock();
  assert.ok(!redact.redact(`value ${s} end`).includes(s)); assert.equal(redact.looksSecret(`value ${s}`), true);
  assert.ok(readFileSync(join(run.dir, 'redaction.hashes'), 'utf8').length > 0);
});
