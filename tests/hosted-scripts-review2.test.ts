// Regression tests for the second correction of scripts/hosted (review of 27a39f0): redaction state is created only under the run lock, evidence keeps earlier failed or interrupted
// attempts, and the migration's DATABASE work is bounded (server-side limits, identified cancellation, verified end), not only the CLI process.
// Nothing here contacts a hosted system. The real CLI against a blocked migration is exercised by scripts/hosted/selftest.mjs on the disposable local stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const url = (f: string) => pathToFileURL(join(root, 'scripts/hosted', f)).href;
const load = (f: string) => import(url(f));
const optional = async (f: string) => { try { return await load(f); } catch { return null; } };
const cfg = await load('lib/config.mjs');
const guard = await load('lib/sqlguard.mjs');
const stagesMod = await load('lib/stages.mjs');
const gates = await load('lib/gates.mjs');
const cli = await load('lib/cli.mjs');
const ctxm = await load('lib/context.mjs');
const state = await load('lib/state.mjs');
const pg = await load('lib/pg.mjs');
const model = await load('lib/evidence-model.mjs');
const migrate = await optional('lib/migrate.mjs');

const SHA = 'a'.repeat(40);
const git = { head: SHA, clean: true };
const shaped = (kind: string) => `sb_${kind}_${'q'.repeat(20)}`;
const made: string[] = []; const runIds: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hs-rev2-')); chmodSync(d, 0o700); made.push(d); return d; };
const freshRunId = () => { const id = `r2-${Math.random().toString(36).slice(2, 10)}`; runIds.push(id); return id; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); for (const id of runIds) rmSync(join(state.runBase('selftest'), id), { recursive: true, force: true }); });
function selfEnv() {
  const pf = join(tmp(), 'pgpass');
  writeFileSync(pf, 'host.docker.internal:54322:postgres:postgres:p1\nhost.docker.internal:54322:postgres:hackass_worker:p2\n', { mode: 0o600 });
  return { HOSTED_SELFTEST: '1', STAGING_REF: 'selftest', STAGING_URL: 'http://127.0.0.1:54321', STAGING_MIGRATE_HOST: 'host.docker.internal', STAGING_MIGRATE_PORT: '54322', STAGING_MIGRATE_USER: 'postgres', STAGING_POOLER_USER: 'postgres',
    STAGING_POOLER_TXN_HOST: 'host.docker.internal', STAGING_POOLER_TXN_PORT: '54322', STAGING_POOLER_SESSION_HOST: 'host.docker.internal', STAGING_POOLER_SESSION_PORT: '54322',
    STAGING_WORKER_USER: 'hackass_worker', STAGING_PGPASSFILE: pf, STAGING_PUBLISHABLE_KEY: shaped('publishable'), STAGING_SECRET_KEY: shaped('secret') } as Record<string, string>;
}
const selfCtx = (env = selfEnv()) => ctxm.createContext(env, { profile: 'selftest' });
const REF = cfg.STAGING.ref as string; const HOST = 'aws-0-us-east-1.pooler.supabase.com';
function stagingCtx() {
  const pf = join(tmp(), 'pgpass');
  writeFileSync(pf, [`${HOST}:5432:postgres:postgres.${REF}:p1`, `${HOST}:6543:postgres:postgres.${REF}:p1`, `${HOST}:5432:postgres:hackass_worker.${REF}:p2`, `${HOST}:6543:postgres:hackass_worker.${REF}:p2`, `db.${REF}.supabase.co:5432:postgres:postgres:p0`].join('\n') + '\n', { mode: 0o600 });
  return ctxm.createContext({ STAGING_REF: REF, STAGING_URL: `https://${REF}.supabase.co`, STAGING_MIGRATE_HOST: `db.${REF}.supabase.co`, STAGING_MIGRATE_PORT: '5432', STAGING_MIGRATE_USER: 'postgres', STAGING_POOLER_USER: `postgres.${REF}`, STAGING_POOLER_TXN_HOST: HOST, STAGING_POOLER_TXN_PORT: '6543',
    STAGING_POOLER_SESSION_HOST: HOST, STAGING_POOLER_SESSION_PORT: '5432', STAGING_WORKER_USER: `hackass_worker.${REF}`, STAGING_PGPASSFILE: pf, STAGING_PUBLISHABLE_KEY: shaped('publishable'), STAGING_SECRET_KEY: shaped('secret'), FORBIDDEN_PROJECT_REFS: 'oldprojectref0123456' }, { profile: 'staging' });
}
function preparedRun(env: Record<string, string>, doneStages: string[]) {
  const id = freshRunId(); const run = state.openRun({ runId: id, profile: 'selftest' });
  const st = run.state(); st.binding = { commit: SHA, profile: 'selftest', targets: state.hashTargets(selfCtx(env).targets) };
  for (const s of doneStages) st.stages[s] = { status: 'done', commit: SHA };
  run.save(st); return { id, run };
}
const argvFor = (id: string, group: string, extra: string[] = []) => ['--profile=selftest', `--run-id=${id}`, `--authorized=${group}@${SHA}`, ...extra];
const quiet = async <T>(f: () => Promise<T>) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
const wait = (child: ReturnType<typeof spawn>, token: string, ms = 15_000) => new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new Error(`timed out waiting for ${token}`)), ms); child.stdout!.on('data', (d) => { if (String(d).includes(token)) { clearTimeout(t); resolve(); } }); });
const evidenceProcess = (id: string, extra: string[] = []) => spawnSync(process.execPath, [join(root, 'scripts/hosted/evidence.mjs'), '--profile=selftest', `--run-id=${id}`, ...extra], { env: { ...process.env, HOSTED_SELFTEST: '1' }, encoding: 'utf8', cwd: root });

// ---------- 1. redaction is created and changed only under the run lock ----------
const HOLDER_SECRET = `Pw-${'k4'.repeat(12)}`;
test('a refused contender cannot create or alter the redaction salt or hashes, and later redaction still works (two real processes, deterministic)', async () => {
  const id = freshRunId(); const env = selfEnv();
  const holder = join(tmp(), 'holder.mjs');
  writeFileSync(holder, `import { openRun } from ${JSON.stringify(url('lib/state.mjs'))};\nimport { registerSecret } from ${JSON.stringify(url('lib/redact.mjs'))};\nconst r = openRun({ runId: process.argv[2], profile: 'selftest' });\nr.acquireLock();\nconsole.log('LOCKED');\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (d) => { for (const l of d.split('\\n').filter(Boolean)) {\n  if (l === 'init') { r.initRedaction(); registerSecret(${JSON.stringify(HOLDER_SECRET)}); console.log('INIT'); }\n  if (l === 'release') { r.releaseLock(); console.log('RELEASED'); }\n} });\n`);
  const child = spawn(process.execPath, [holder, id], { stdio: ['pipe', 'pipe', 'inherit'] });
  await wait(child, 'LOCKED');
  const dir = join(state.runBase('selftest'), id); const saltFile = join(dir, 'redaction.salt'); const hashFile = join(dir, 'redaction.hashes');
  // 1. the holder has the lock but has not initialised redaction: a contender is refused and creates NOTHING
  assert.equal(await quiet(() => cli.runStage('preflight', argvFor(id, 'S6'), async () => ({ passed: 1, failed: 0 }), { env, git })), 2);
  assert.ok(!existsSync(saltFile), 'a refused contender must not create the salt');
  // 2. the holder initialises and registers a secret
  child.stdin!.write('init\n'); await wait(child, 'INIT');
  const salt1 = readFileSync(saltFile, 'utf8'); const hashes1 = readFileSync(hashFile, 'utf8');
  assert.match(salt1.trim(), /^[0-9a-f]{32}$/); assert.ok(hashes1.length > 0);
  // 3. a second contender is refused and the salt and hashes are byte-for-byte unchanged
  assert.equal(await quiet(() => cli.runStage('preflight', argvFor(id, 'S6'), async () => ({ passed: 1, failed: 0 }), { env, git })), 2);
  assert.equal(readFileSync(saltFile, 'utf8'), salt1, 'the salt was altered by a refused contender'); assert.equal(readFileSync(hashFile, 'utf8'), hashes1);
  child.stdin!.write('release\n'); await wait(child, 'RELEASED'); child.stdin!.end(); await new Promise((r) => child.on('close', r));
  // 4. later redaction still removes the holder's secret, in a separate process, from a result that leaked it
  const run = state.openRun({ runId: id, profile: 'selftest' });
  appendFileSync(join(run.dir, 'results.jsonl'), JSON.stringify({ id: 'H0', status: 'FAIL', error: `leaked ${HOLDER_SECRET} here`, ms: 1 }) + '\n');
  const ev = evidenceProcess(id); assert.equal(ev.status, 0, ev.stdout + ev.stderr);
  const text = readFileSync(join(run.dir, readdirSync(run.dir).find((f: string) => f.endsWith('.md'))!), 'utf8');
  assert.ok(!text.includes(HOLDER_SECRET), 'the holder\'s secret survived in the evidence'); assert.match(text, /\[REDACTED\]/);
  assert.equal(readFileSync(saltFile, 'utf8'), salt1);
});
test('the redaction salt is created exclusively and never replaced; redaction cannot be initialised without the lock', () => {
  const dir = tmp(); const file = join(dir, 'redaction.salt');
  const a = state.ensureSalt(file); const b = state.ensureSalt(file);
  assert.equal(a, b); assert.match(a, /^[0-9a-f]{32}$/);
  const other = join(dir, 'other.salt'); writeFileSync(other, 'c'.repeat(32), { mode: 0o600 });
  assert.equal(state.ensureSalt(other), 'c'.repeat(32), 'an existing salt is read back, not overwritten'); assert.equal(readFileSync(other, 'utf8'), 'c'.repeat(32));
  const bad = join(dir, 'bad.salt'); writeFileSync(bad, 'not a salt', { mode: 0o600 });
  assert.throws(() => state.ensureSalt(bad), /missing or damaged/); assert.equal(readFileSync(bad, 'utf8'), 'not a salt', 'a damaged salt is reported, never silently replaced');
  const run = state.openRun({ runId: freshRunId(), profile: 'selftest' });
  assert.throws(() => run.initRedaction(), /holding the run lock/);
  assert.ok(!existsSync(join(run.dir, 'redaction.salt')), 'opening a run creates no redaction state');
});

// ---------- 2. earlier failed or interrupted attempts stay in the evidence outcome ----------
const REQUIRED = ['H0', 'H1a', 'H1b', 'H2a', 'H2b', 'H2c', 'H3', 'H4', 'H5a', 'FX0', 'H5b', 'FX1', 'H6', 'H7', 'H8', 'H8-default', 'H9', 'H10', 'H11', 'H12a', 'H12b', 'H12c', 'H13a', 'H13b', 'H13c'];
const doneStages = () => Object.fromEntries(['preflight', 'identity', 'migrate', 'exposure', 'worker-marker', 'rerun', 'inventory', 'fixtures', 'session-checks', 'worker-checks', 'catalog-checks', 'isolation', 'cleanup'].map((s) => [s, { status: 'done', commit: SHA }]));
const passes = (ids: string[]) => ids.map((id) => ({ id, status: 'PASS', ms: 1, facts: 'ok' }));
test('an interrupted or failed earlier attempt is never forgotten: the outcome stays FAILED although every current state is done', () => {
  const base = { stages: doneStages(), facts: { owner_deletion_date: '2099-01-01' } };
  assert.equal(model.evaluateRun(base, passes(REQUIRED)).outcome, 'COMPLETE');
  const withHistory = { ...base, history: [{ stage: 'exposure', status: 'interrupted', at: 't', error: 'received SIGTERM' }] };
  const ev = model.evaluateRun(withHistory, passes(REQUIRED));
  assert.equal(ev.outcome, 'FAILED'); assert.match(ev.reasons.join(' '), /earlier attempts.*exposure \(interrupted\)/);
  assert.equal(model.evaluateRun({ ...base, history: [{ stage: 'inventory', status: 'failed' }] }, passes(REQUIRED)).outcome, 'FAILED');
  assert.equal(model.evaluateRun({ ...base, history: [{ stage: 'preflight', status: 'done' }, { stage: 'evidence', status: 'failed' }] }, passes(REQUIRED)).outcome, 'COMPLETE', 'a repeated done stage and the evidence stage itself are not failures');
});
test('SIGKILL, recovery and an approved retry: the retry may succeed but the interrupted attempt stays in the evidence, which is FAILED', async () => {
  const env = selfEnv(); const { id, run } = preparedRun(env, []);
  const hang = join(tmp(), 'hang.mjs');
  writeFileSync(hang, `import { runStage } from ${JSON.stringify(url('lib/cli.mjs'))};\nawait runStage('preflight', process.argv.slice(2), async () => { console.log('STARTED'); await new Promise(() => {}); }, { env: process.env, git: { head: ${JSON.stringify(SHA)}, clean: true } });\n`);
  const child = spawn(process.execPath, [hang, ...argvFor(id, 'S6')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  await wait(child, 'STARTED'); child.kill('SIGKILL'); await new Promise((r) => child.on('close', r));
  const ok = async () => ({ passed: 1, failed: 0 });
  assert.equal(await quiet(() => cli.runStage('preflight', argvFor(id, 'S6', ['--retry-after-review']), ok, { env, git })), 2, 'a stale lock is not taken over by a normal stage');
  assert.equal(await quiet(() => cli.runStage('evidence', ['--profile=selftest', `--run-id=${id}`], ok, { env, git })), 0, 'a recovery stage takes the stale lock and records the interruption');
  assert.equal(run.state().stages.preflight.status, 'interrupted');
  assert.equal(await quiet(() => cli.runStage('preflight', argvFor(id, 'S6'), ok, { env, git })), 2, 'without the explicit flag the interrupted stage does not restart');
  assert.equal(await quiet(() => cli.runStage('preflight', argvFor(id, 'S6', ['--retry-after-review']), ok, { env, git })), 0, 'the approved retry runs');
  const s = run.state(); assert.equal(s.stages.preflight.status, 'done');
  assert.ok((s.history ?? []).some((h: { stage: string; status: string }) => h.stage === 'preflight' && h.status === 'interrupted'), 'the interrupted attempt is retained');
  const ev = evidenceProcess(id); assert.equal(ev.status, 0, ev.stdout + ev.stderr);
  const files = readdirSync(run.dir).filter((f: string) => f.endsWith('.md')).sort();
  const text = readFileSync(join(run.dir, files[files.length - 1]), 'utf8');
  assert.match(text, /\*\*Outcome: FAILED\*\*/); assert.match(text, /earlier attempts/); assert.match(text, /Earlier attempts that failed or were interrupted[\s\S]*preflight: interrupted/);
  const again = evidenceProcess(id); assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(readdirSync(run.dir).filter((f: string) => f.endsWith('.md')).length, files.length + 1, 'a second evidence record is a new file, never an overwrite');
});

// ---------- 3. the migration's database work is bounded ----------
test('the CLI url carries the documented server-side limits as startup options, and a staging run cannot change them', () => {
  assert.ok(migrate, 'lib/migrate.mjs exists');
  const L = migrate.MIGRATION_LIMITS;
  const u = cfg.cliUrl({ host: `db.${REF}.supabase.co`, port: 5432, user: 'postgres', profile: 'staging', limits: L });
  assert.equal(decodeURIComponent(new URL(u).searchParams.get('options') ?? ''), '-c lock_timeout=30000 -c statement_timeout=300000 -c idle_in_transaction_session_timeout=60000 -c client_connection_check_interval=2000');
  assert.ok(!/password|:[^@/]*@/.test(u.replace(/^postgresql:\/\//, '').split('@')[0].includes(':') ? u : 'x'), 'no password in the url');
  assert.throws(() => cfg.cliUrl({ host: `db.${REF}.supabase.co`, port: 5432, user: 'postgres', profile: 'staging', limits: { ...L, lockTimeoutMs: -1 } }), /invalid server-side limit/);
  assert.throws(() => cfg.cliUrl({ host: `db.${REF}.supabase.co`, port: 5432, user: 'postgres', profile: 'staging', limits: { ...L, statementTimeoutMs: 1.5 } }), /invalid server-side limit/);
  assert.deepEqual(migrate.effectiveLimits(stagingCtx(), { lockTimeoutMs: 1, deadlineMs: 1 }), L, 'staging ignores overrides');
  assert.equal(migrate.effectiveLimits(selfCtx(), { lockTimeoutMs: 1 }).lockTimeoutMs, 1, 'the selftest may shorten them');
});
test('the migration-session statements are fixed: only the CLI\'s own session of the migration login, started after the server-clock mark, on the migration endpoint', async () => {
  const m = '1760567890.123456';
  for (const k of ['count', 'locks', 'cancel', 'terminate']) assert.equal(guard.checkSql(guard.MIGRATION_SQL[k](m), 'migration').length, 1);
  assert.equal(guard.checkSql(guard.MIGRATION_SQL.mark, 'migration').length, 1); assert.equal(guard.checkSql(guard.MIGRATION_SQL.stuck, 'migration').length, 1);
  for (const bad of [guard.MIGRATION_SQL.cancel('1; select 1'), guard.MIGRATION_SQL.cancel('12.5'), guard.MIGRATION_SQL.cancel(m).replace(guard.CLI_SESSION_NAME, 'postgres'), guard.MIGRATION_SQL.cancel(m).replace('usename = current_user and ', ''), 'select pg_terminate_backend(pid) from pg_stat_activity', `${guard.MIGRATION_SQL.count(m)}; select 1`]) assert.throws(() => guard.checkSql(bad, 'migration'), guard.SqlRefused, bad);
  const c = selfCtx();
  await assert.rejects(() => pg.runSql(c, 'worker-txn', guard.MIGRATION_SQL.mark, { kind: 'migration' }), /may not run on the worker-txn endpoint/);
  await assert.rejects(() => pg.runSql(c, 'txn', guard.MIGRATION_SQL.mark, { kind: 'migration' }), /may not run on the txn endpoint/);
  for (const k of ['cancel', 'terminate']) assert.throws(() => guard.checkSql(guard.MIGRATION_SQL[k](m), 'read'), guard.SqlRefused, `the read kind refuses session ${k}`);
});
/** A scripted server: one CLI session that ends according to the mechanism under test. */
function fakeServer(opts: { endsBy?: 'natural' | 'cancel' | 'terminate' | 'never'; locksAfter?: number; stuckAfter?: number; markFails?: boolean } = {}) {
  const log: string[] = []; let sessions = 1; let cancelled = false; let terminated = false;
  const sql = async (_c: unknown, _e: string, text: string) => {
    const kind = /extract\(epoch/.test(text) ? 'mark' : /pg_cancel_backend/.test(text) ? 'cancel' : /pg_terminate_backend/.test(text) ? 'terminate' : /pg_locks/.test(text) ? 'locks' : /wait_event_type/.test(text) ? 'stuck' : 'count';
    log.push(kind);
    if (kind === 'mark') return opts.markFails ? { ok: false, stdout: '', stderr: 'no' } : { ok: true, stdout: '1760567890.123456', stderr: '' };
    if (kind === 'cancel') { cancelled = true; if (opts.endsBy === 'cancel') sessions = 0; return { ok: true, stdout: String(sessions || 1), stderr: '' }; }
    if (kind === 'terminate') { terminated = true; if (opts.endsBy === 'terminate') sessions = 0; return { ok: true, stdout: '1', stderr: '' }; }
    if (kind === 'locks') return { ok: true, stdout: String(sessions === 0 ? (opts.locksAfter ?? 0) : 1), stderr: '' };
    if (kind === 'stuck') return { ok: true, stdout: String(opts.stuckAfter ?? 0), stderr: '' };
    if (opts.endsBy === 'natural' && !cancelled && log.filter((l) => l === 'count').length >= 2) sessions = 0;
    return { ok: true, stdout: String(sessions), stderr: '' };
  };
  return { sql, log, state: () => ({ sessions, cancelled, terminated }) };
}
const cliRun = (res: Record<string, unknown>, seen: { args?: string[]; opts?: Record<string, unknown>; started?: boolean } = {}) => async (_cmd: string, args: string[], opts: Record<string, unknown>) => { seen.started = true; seen.args = args; seen.opts = opts; return { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: false, truncated: false, ...res }; };
test('a deadline: the mark is read first, the CLI is started with the limits, then the session is cancelled and its end is PROVEN; the error says the run cannot be retried', async () => {
  assert.ok(migrate, 'lib/migrate.mjs exists');
  const srv = fakeServer({ endsBy: 'cancel' }); const seen: { args?: string[]; opts?: Record<string, unknown> } = {};
  const err = await migrate.pushMigrations(selfCtx(), { cli: '/bin/true', timeoutMs: 1234, deps: { sql: srv.sql, run: cliRun({ timedOut: true }, seen), sleep: async () => {} } }).then(() => null, (e: Error & { ended?: { proven: boolean; endedBy: string } }) => e);
  assert.ok(err, 'a deadline must throw'); assert.equal(err.ended?.proven, true); assert.equal(err.ended?.endedBy, 'cancel');
  assert.equal(srv.log[0], 'mark', 'the server clock is read before the CLI starts'); assert.ok(srv.log.includes('cancel'));
  assert.equal(seen.opts?.timeoutMs, 1234); assert.match(decodeURIComponent((seen.args ?? []).join(' ')), /lock_timeout=\d+ -c statement_timeout=\d+ -c idle_in_transaction_session_timeout=\d+ -c client_connection_check_interval=\d+/);
  assert.match(err.message, /cannot be retried/); assert.match(err.message, /transaction and its locks have ended/);
});
test('the server ending the session by itself is recognised; a session that survives cancel is terminated; one that survives everything is NOT PROVEN', async () => {
  const run = (srv: ReturnType<typeof fakeServer>) => migrate.pushMigrations(selfCtx(), { cli: '/bin/true', deps: { sql: srv.sql, run: cliRun({ timedOut: true }), sleep: async () => {} } }).then(() => null, (e: Error & { ended?: { proven: boolean; endedBy: string; terminated: number } }) => e);
  const nat = await run(fakeServer({ endsBy: 'natural' })); assert.equal(nat?.ended?.endedBy, 'the server (connection check)'); assert.equal(nat?.ended?.proven, true);
  const term = await run(fakeServer({ endsBy: 'terminate' })); assert.equal(term?.ended?.endedBy, 'terminate'); assert.equal(term?.ended?.proven, true);
  const never = await run(fakeServer({ endsBy: 'never' })); assert.equal(never?.ended?.proven, false); assert.match(never?.message ?? '', /NOT PROVEN/);
  const locks = await run(fakeServer({ endsBy: 'cancel', locksAfter: 2 })); assert.equal(locks?.ended?.proven, false);
  const stuck = await run(fakeServer({ endsBy: 'cancel', stuckAfter: 1 })); assert.equal(stuck?.ended?.proven, false); assert.match(stuck?.message ?? '', /NOT PROVEN/);
});
test('a CLI failure is verified too; a success needs no cancellation; no server clock means the CLI is never started; staging gets the documented deadline', async () => {
  const fail = fakeServer({ endsBy: 'natural' });
  const e1 = await migrate.pushMigrations(selfCtx(), { cli: '/bin/true', deps: { sql: fail.sql, run: cliRun({ code: 1, signal: null, stderr: '{"type":"error","error":{"message":"canceling statement due to lock timeout"}}' }), sleep: async () => {} } }).then(() => null, (e: Error) => e);
  assert.match(e1?.message ?? '', /lock timeout/); assert.match(e1?.message ?? '', /have ended|NOT PROVEN/);
  const ok = fakeServer();
  const r = await migrate.pushMigrations(selfCtx(), { cli: '/bin/true', deps: { sql: ok.sql, run: cliRun({ code: 0, signal: null, stdout: '{"type":"result","data":{"upToDate":true,"migrations":[]}}\n' }), sleep: async () => {} } });
  assert.deepEqual(r, { upToDate: true, migrations: [] }); assert.deepEqual(ok.log, ['mark'], 'a clean success cancels nothing');
  const none = fakeServer({ markFails: true }); const seen: { started?: boolean } = {};
  await assert.rejects(() => migrate.pushMigrations(selfCtx(), { cli: '/bin/true', deps: { sql: none.sql, run: cliRun({}, seen), sleep: async () => {} } }), /was not started/); assert.ok(!seen.started);
  const st = fakeServer({ endsBy: 'cancel' }); const seen2: { opts?: Record<string, unknown> } = {};
  await migrate.pushMigrations(stagingCtx(), { cli: '/bin/true', timeoutMs: 5, limits: { deadlineMs: 5 }, deps: { sql: st.sql, run: cliRun({ timedOut: true }, seen2), sleep: async () => {} } }).catch(() => {});
  assert.equal(seen2.opts?.timeoutMs, 600_000, 'a staging run ignores a shortened deadline');
});
test('after a migration timeout the stage is failed and not retryable; the stage runs the CLI only through the bounded function', async () => {
  assert.ok(!stagesMod.RETRYABLE_AFTER_REVIEW.has('migrate'));
  const env = selfEnv(); const { id, run } = preparedRun(env, ['preflight', 'identity']);
  const err = Object.assign(new Error('supabase db push exceeded its deadline'), { ended: { proven: true } });
  assert.equal(await quiet(() => cli.runStage('migrate', argvFor(id, 'S7', ['--confirm-mutating=migrate']), async ({ run: r, say }: { run: unknown; say: (s: string) => void }) => { const c = cli.checker(r, say); await c.check('H2a', 'x', async () => { throw err; }); return c.out; }, { env, git })), 1);
  assert.equal(run.state().stages.migrate.status, 'failed');
  for (const extra of [[], ['--retry-after-review']]) assert.equal(await quiet(() => cli.runStage('migrate', argvFor(id, 'S7', ['--confirm-mutating=migrate', ...extra]), async () => ({ passed: 1, failed: 0 }), { env, git })), 2);
  const apply = readFileSync(join(root, 'scripts/hosted/s7-apply.mjs'), 'utf8');
  assert.match(apply, /pushMigrations\(/); assert.ok(!/runBounded|parsePushResult/.test(apply), 'the stage no longer runs or parses the CLI itself');
  assert.throws(() => gates.checkGates('migrate', { authorized: `S7@${SHA}`, 'confirm-mutating': 'migrate', 'retry-after-review': true }, { binding: { commit: SHA, profile: 'selftest', targets: 'T' }, stages: { preflight: { status: 'done', commit: SHA }, identity: { status: 'done', commit: SHA }, migrate: { status: 'failed', commit: SHA } } }, git, { profile: 'selftest', targetsHash: 'T' }), /not healthy/);
});
