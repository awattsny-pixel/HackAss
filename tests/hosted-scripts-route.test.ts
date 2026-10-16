// Regression tests for the migration ROUTE: migrations run only over the staging DIRECT host as `postgres`; the pooler checks keep using `postgres.<ref>`; and a migration through a
// pooler is refused by target validation AND by the actual migration invocation, before anything is contacted.
// Nothing here contacts a hosted system or a database. The split with a real pooler is shown by the local lab run recorded in docs/hosted/migration-route.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const load = (f: string) => import(pathToFileURL(join(root, 'scripts/hosted', f)).href);
const cfg = await load('lib/config.mjs');
const ctxm = await load('lib/context.mjs');
const pg = await load('lib/pg.mjs');
const migrate = await load('lib/migrate.mjs');

const REF = cfg.STAGING.ref as string;
const OLD = 'oldprojectref0123456';
const POOLER = 'aws-0-us-east-1.pooler.supabase.com';
const DIRECT = `db.${REF}.supabase.co`;
const shaped = (kind: string) => `sb_${kind}_${'q'.repeat(20)}`;
const made: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hs-route-')); chmodSync(d, 0o700); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const GOOD = [`${POOLER}:5432:postgres:postgres.${REF}:p1`, `${POOLER}:6543:postgres:postgres.${REF}:p1`, `${POOLER}:5432:postgres:hackass_worker.${REF}:p2`, `${POOLER}:6543:postgres:hackass_worker.${REF}:p2`, `${DIRECT}:5432:postgres:postgres:p0`];
const passfile = (lines: string[]) => { const f = join(tmp(), 'pgpass'); writeFileSync(f, lines.join('\n') + '\n', { mode: 0o600 }); return f; };
function env(over: Record<string, string> = {}, lines = GOOD): Record<string, string> {
  return { STAGING_REF: REF, STAGING_URL: `https://${REF}.supabase.co`, STAGING_MIGRATE_HOST: DIRECT, STAGING_MIGRATE_PORT: '5432', STAGING_MIGRATE_USER: 'postgres', STAGING_POOLER_USER: `postgres.${REF}`,
    STAGING_POOLER_TXN_HOST: POOLER, STAGING_POOLER_TXN_PORT: '6543', STAGING_POOLER_SESSION_HOST: POOLER, STAGING_POOLER_SESSION_PORT: '5432', STAGING_WORKER_USER: `hackass_worker.${REF}`,
    STAGING_PGPASSFILE: passfile(lines), STAGING_PUBLISHABLE_KEY: shaped('publishable'), STAGING_SECRET_KEY: shaped('secret'), FORBIDDEN_PROJECT_REFS: OLD, ...over };
}
const errorsOf = (e: Record<string, string>) => cfg.validateTargets(e, { profile: 'staging', repoRoot: root }).errors as string[];
const refused = (e: Record<string, string>, re: RegExp) => { const errs = errorsOf(e); assert.ok(errs.some((x) => re.test(x)), `expected an error matching ${re}; got ${JSON.stringify(errs)}`); };

test('1. the split: the migration target is the direct host as postgres, the pooler checks keep postgres.<ref>, the worker keeps its own login', () => {
  assert.deepEqual(errorsOf(env()), []);
  const ctx = ctxm.createContext(env(), { profile: 'staging', repoRoot: root });
  assert.deepEqual(pg.endpointInfo(ctx, 'migrate'), { host: DIRECT, port: 5432, user: 'postgres' });
  assert.deepEqual(pg.endpointInfo(ctx, 'session'), { host: POOLER, port: 5432, user: `postgres.${REF}` });
  assert.deepEqual(pg.endpointInfo(ctx, 'txn'), { host: POOLER, port: 6543, user: `postgres.${REF}` });
  assert.deepEqual(pg.endpointInfo(ctx, 'worker-session'), { host: POOLER, port: 5432, user: `hackass_worker.${REF}` });
  assert.deepEqual(pg.endpointInfo(ctx, 'worker-txn'), { host: POOLER, port: 6543, user: `hackass_worker.${REF}` });
});

test('1b. the psql client for each endpoint is built with that endpoint\'s own host, port and login, always with TLS required and never a password', () => {
  const ctx = ctxm.createContext(env(), { profile: 'staging', repoRoot: root });
  const conn = (ep: string) => pg.dockerArgs(ctx, ep, { name: 'hackass-psql-x' }).find((a: string) => a.startsWith('host=')) as string;
  assert.match(conn('migrate'), new RegExp(`host=${DIRECT.replace(/\./g, '\\.')} port=5432 .*user=postgres sslmode=require`));
  assert.match(conn('session'), new RegExp(`host=${POOLER.replace(/\./g, '\\.')} port=5432 .*user=postgres\\.${REF} sslmode=require`));
  assert.match(conn('txn'), new RegExp(`port=6543 .*user=postgres\\.${REF} sslmode=require`));
  for (const ep of ['migrate', 'session', 'txn']) assert.ok(!/password/i.test(conn(ep)));
});

test('2. a pooler migration target is refused by target validation (H0), whichever pooler host, port or login is given', () => {
  refused(env({ STAGING_MIGRATE_HOST: POOLER }), /through a pooler is refused/);
  refused(env({ STAGING_MIGRATE_HOST: POOLER, STAGING_MIGRATE_USER: `postgres.${REF}` }), /through a pooler is refused/);
  refused(env({ STAGING_MIGRATE_HOST: 'aws-0-eu-west-1.pooler.supabase.com' }), /through a pooler is refused/);
  refused(env({ STAGING_MIGRATE_PORT: '6543' }), /migration port must be 5432/);              // 6543 on the direct host is a pooler too
  refused(env({ STAGING_MIGRATE_USER: `postgres.${REF}` }), /migration login on the direct host must be postgres/);
  refused(env({ STAGING_MIGRATE_HOST: `db.${OLD}.supabase.co` }), /migration host must be exactly|forbidden/);
  refused(env({ STAGING_MIGRATE_HOST: 'db.abcdefghijklmnopqrst.supabase.co' }), /migration host must be exactly/);
  refused(env({ STAGING_MIGRATE_HOST: POOLER, STAGING_POOLER_TXN_HOST: POOLER }), /through a pooler is refused/);
});

test('2b. the previous environment shape (migration on the pooler as postgres.<ref>) is refused with the reason', () => {
  const old = env({ STAGING_MIGRATE_HOST: POOLER, STAGING_MIGRATE_USER: `postgres.${REF}` }, GOOD.slice(0, 4));
  assert.throws(() => ctxm.createContext(old, { profile: 'staging', repoRoot: root }), /through a pooler is refused/);
});

test('3. the pooler login is required and exact; the logins cannot be swapped', () => {
  refused(env({ STAGING_POOLER_USER: '' }), /pooler login must be postgres\./);
  refused(env({ STAGING_POOLER_USER: 'postgres' }), /pooler login must be postgres\./);
  refused(env({ STAGING_POOLER_USER: `postgres.${OLD}` }), /pooler login must be postgres\./);
  refused(env({ STAGING_MIGRATE_USER: `postgres.${REF}`, STAGING_POOLER_USER: 'postgres' }), /migration login on the direct host must be postgres/);
});

test('4. the password file must now hold an entry for the direct host AND for the pooler logins', () => {
  refused(env({}, GOOD.slice(0, 4)), new RegExp(`no entry for postgres@${DIRECT.replace(/\./g, '\\.')}:5432`));
  refused(env({}, [GOOD[2], GOOD[3], GOOD[4]]), new RegExp(`no entry for postgres\\.${REF}@${POOLER.replace(/\./g, '\\.')}:5432`));
  refused(env({}, [GOOD[0], GOOD[2], GOOD[3], GOOD[4]]), new RegExp(`no entry for postgres\\.${REF}@${POOLER.replace(/\./g, '\\.')}:6543`));
  refused(env({}, [...GOOD, `${DIRECT}:5432:postgres:postgres.${OLD}:p3`]), /forbidden project reference|suffix/);
  assert.deepEqual(errorsOf(env({}, GOOD)), []);
  // the direct entry alone does not stand in for the pooler logins, nor the other way round
  refused(env({}, [GOOD[2], GOOD[3], GOOD[4], `${POOLER}:5432:postgres:postgres:pp`]), /no entry for postgres\./);
});

// ---------- the actual invocation ----------
const ctxFor = (migrateTarget: { host: string; port: number; user: string }, profile = 'staging') => ({ profile, targets: { migrate: migrateTarget, passfile: '/nonexistent', ref: REF } });
function stubs() {
  const calls: string[] = [];
  return { calls, deps: { sql: async () => { calls.push('sql'); return { ok: false, stdout: '', stderr: 'stub: not connected' }; }, run: async () => { calls.push('run'); return { code: 0, stdout: '', stderr: '' }; }, sleep: async () => {} } };
}

test('5. the migration invocation itself refuses a pooler (or any non-direct) target BEFORE reading the server clock, connecting or starting the CLI', async () => {
  for (const target of [{ host: POOLER, port: 5432, user: `postgres.${REF}` }, { host: POOLER, port: 5432, user: 'postgres' }, { host: POOLER, port: 6543, user: 'postgres' }, { host: DIRECT, port: 6543, user: 'postgres' }, { host: DIRECT, port: 5432, user: `postgres.${REF}` },
    { host: `db.${OLD}.supabase.co`, port: 5432, user: 'postgres' }, { host: '', port: NaN, user: '' }]) {
    for (const dryRun of [true, false]) {
      const s = stubs();
      await assert.rejects(() => migrate.pushMigrations(ctxFor(target), { dryRun, cli: '/bin/true', deps: s.deps }), (e: Error) => e instanceof cfg.MigrationRouteRefused, JSON.stringify(target));
      assert.deepEqual(s.calls, [], `nothing was contacted or started for ${JSON.stringify(target)}`);
    }
  }
});

test('5b. control: the direct target passes the guard and then proceeds to its first database step', async () => {
  const s = stubs();
  await assert.rejects(() => migrate.pushMigrations(ctxFor({ host: DIRECT, port: 5432, user: 'postgres' }), { cli: '/bin/true', deps: s.deps }), /was not started/);
  assert.deepEqual(s.calls, ['sql'], 'the server clock was read (the stub then declines), the CLI was not started');
});

test('5c. the CLI url builder refuses a pooler too, and the selftest profile accepts only the local container host', () => {
  assert.throws(() => cfg.cliUrl({ host: POOLER, port: 5432, user: `postgres.${REF}`, profile: 'staging' }), cfg.MigrationRouteRefused);
  assert.throws(() => cfg.cliUrl({ host: DIRECT, port: 5432, user: `postgres.${REF}`, profile: 'staging' }), cfg.MigrationRouteRefused);
  assert.match(cfg.cliUrl({ host: DIRECT, port: 5432, user: 'postgres', profile: 'staging' }), /^postgresql:\/\/postgres@db\.[a-z]+\.supabase\.co:5432\/postgres\?sslmode=require/);
  assert.match(cfg.cliUrl({ host: 'host.docker.internal', port: 54322, user: 'postgres', profile: 'selftest' }), /@127\.0\.0\.1:54322\/postgres\?sslmode=disable/);
  assert.throws(() => cfg.cliUrl({ host: POOLER, port: 54322, user: 'postgres', profile: 'selftest' }), cfg.MigrationRouteRefused);
});

test('6. the only code that builds a `db push` command line is lib/migrate.mjs, behind the guard', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.mjs')) files.push(p); } };
  walk(join(root, 'scripts/hosted'));
  const builders = files.filter((f) => /'db',\s*'push'/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));
  assert.deepEqual(builders, ['scripts/hosted/lib/migrate.mjs']);
  const src = readFileSync(join(root, 'scripts/hosted/lib/migrate.mjs'), 'utf8');
  assert.ok(src.indexOf('assertDirectMigrationTarget(ctx.targets.migrate') < src.indexOf('MIGRATION_SQL.mark'), 'the guard comes before the first database step');
  assert.ok(src.indexOf('assertDirectMigrationTarget(ctx.targets.migrate') < src.indexOf('await run(cli'), 'the guard comes before the CLI is started');
  assert.match(readFileSync(join(root, 'scripts/hosted/s7-apply.mjs'), 'utf8'), /pushMigrations\(/);
});

test('7. a real stage process with the previous environment shape is refused at H0: no docker, no Supabase CLI, no network was touched', () => {
  const home = tmp(); const bin = join(home, 'bin'); mkdirSync(bin); const log = join(home, 'calls.log'); writeFileSync(log, '');
  for (const n of ['docker', 'supabase']) writeFileSync(join(bin, n), `#!/bin/sh\necho "${n} $@" >> "${log}"\nexit 9\n`, { mode: 0o755 });
  const keys = join(home, 'keys'); mkdirSync(keys, { mode: 0o700 }); writeFileSync(join(keys, 'pub'), shaped('publishable') + '\n', { mode: 0o600 }); writeFileSync(join(keys, 'sec'), shaped('secret') + '\n', { mode: 0o600 });
  const e = env({ STAGING_MIGRATE_HOST: POOLER, STAGING_MIGRATE_USER: `postgres.${REF}` }, GOOD.slice(0, 4));
  delete (e as Record<string, string | undefined>).STAGING_PUBLISHABLE_KEY; delete (e as Record<string, string | undefined>).STAGING_SECRET_KEY;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const r = spawnSync(process.execPath, [join(root, 'scripts/hosted/s7-apply.mjs'), 'migrate', '--run-id=route-test-1', `--authorized=S7@${head}`, '--confirm-mutating=migrate'], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, SUPABASE_BIN: join(bin, 'supabase'), DOCKER_BIN: join(bin, 'docker'), ...e, STAGING_PUBLISHABLE_KEY_FILE: join(keys, 'pub'), STAGING_SECRET_KEY_FILE: join(keys, 'sec') } });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 2, out); assert.match(out, /through a pooler is refused/);
  assert.equal(readFileSync(log, 'utf8'), '', 'neither docker nor the Supabase CLI was started');
});

test('8. the migration SQL is unchanged from the accepted commit', () => {
  const base = '0e1e2a139393f3017963e096fbbe438694e6446a';
  if (spawnSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: root }).status !== 0) return; // a checkout without that commit cannot compare
  const r = spawnSync('git', ['diff', '--stat', base, '--', 'supabase/migrations'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '', `supabase/migrations differs from ${base}`);
  assert.ok(existsSync(join(root, 'supabase/migrations')));
});

// ---------- the proposed S7 command block stops mechanically ----------
function s7Block() {
  const doc = readFileSync(join(root, 'docs/hosted/migration-route.md'), 'utf8');
  const m = /```bash\n(#!\/bin\/bash\n[\s\S]*?)```\n/.exec(doc); assert.ok(m, 'the command block is in the document');
  return m![1];
}
function runS7(part: string | null, failOn: string | null) {
  const dir = tmp(); const bin = join(dir, 'bin'); mkdirSync(bin); const log = join(dir, 'calls.log'); writeFileSync(log, '');
  writeFileSync(join(bin, 'node'), `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in *"${failOn ?? 'NO-SUCH-STAGE'}"*) exit 7;; esac\nexit 0\n`, { mode: 0o755 });
  const script = s7Block().replace('<repository>', dir).replace('<private directory>', join(dir, 'secrets')).replace(/<ref>/g, 'abcdefghijklmnopqrst').replace('<pooler host>', 'aws-0-us-east-1.pooler.supabase.com')
    .replace('<the reviewed commit>', 'a'.repeat(40)).replace('<fresh run id>', 'route-run-1').replace('<legacy ref>', 'oldprojectref0123456');
  assert.ok(!/<[a-z ]+>/.test(script), 'every placeholder was substituted');
  const f = join(dir, 's7.sh'); writeFileSync(f, script);
  const r = spawnSync('bash', part ? [f, part] : [f], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir } });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(0, 2).join(' '));
  return { status: r.status, err: r.stderr, out: r.stdout, calls };
}
test('9. the S7 command block runs every stage in order when all succeed, and stops at the first failing one', () => {
  assert.deepEqual(runS7('A', null).calls.map((c) => c.split(' ').slice(0, 2).join(' ')), ['scripts/hosted/preflight.mjs --run-id=route-run-1', 'scripts/hosted/s7-apply.mjs identity', 'scripts/hosted/s7-apply.mjs migrate']);
  assert.equal(runS7('A', null).status, 0);
  assert.equal(runS7('B', null).calls.length, 4);
  const failId = runS7('A', 'identity'); assert.equal(failId.status, 1); assert.equal(failId.calls.length, 2, 'migrate did not run after a failed identity'); assert.match(failId.err, /STOP: .*identity.*failed \(exit 7\)\. Nothing further was run/);
  const failPre = runS7('A', 'preflight.mjs'); assert.equal(failPre.status, 1); assert.equal(failPre.calls.length, 1, 'identity did not run after a failed preflight');
  const failMig = runS7('A', 'migrate'); assert.equal(failMig.status, 1); assert.equal(failMig.calls.length, 3);
  const failB = runS7('B', 'worker-marker'); assert.equal(failB.status, 1); assert.equal(failB.calls.length, 2, 'rerun and inventory did not run after a failed worker-marker');
});
test('9b. the block refuses an unknown or missing part, runs nothing then, and every node call goes through the stopping function', () => {
  for (const part of [null, 'C', 'AB']) { const r = runS7(part, null); assert.equal(r.status, 2); assert.equal(r.calls.length, 0); }
  const block = s7Block(); assert.match(block, /^set -euo pipefail$/m);
  assert.deepEqual(block.split('\n').filter((l) => /\bnode\b/.test(l) && !l.trim().startsWith('#')), ['step() { echo "== $*"; "${S7ENV[@]}" node "$@" || { echo "STOP: \'$*\' failed (exit $?). Nothing further was run." >&2; exit 1; }; }']);
});

test('10. the documentation makes no stale or overstated safety claim: pooled execution is not "safe", and fingerprint equality is not proof', () => {
  const mig = readFileSync(join(root, 'scripts/hosted/lib/migrate.mjs'), 'utf8');
  assert.ok(!/which is the safe direction/.test(mig)); assert.match(mig, /DIRECT CONNECTION ONLY/); assert.match(mig, /FALSE CLEAN result/); assert.match(mig, /assertDirectMigrationTarget/);
  const doc = readFileSync(join(root, 'docs/hosted/migration-route.md'), 'utf8');
  assert.match(doc, /equal fingerprints do not show that the interrupted file left nothing, and equality alone never clears recovery/);
  assert.match(doc, /does \*\*not\*\* cover table columns, constraints, indexes, triggers, policies, role attributes or data/);
  assert.ok(!/the failed file left nothing\)/.test(doc.replace(/consistent with, but not proof of, the failed file leaving nothing\)/g, '')), 'no unqualified "left nothing" claim remains');
  assert.match(doc, /One green run does not resolve the causes of the failed ones/); assert.match(doc, /interference/i);
  for (const f of ['docs/hosted/verification-procedure.md', 'scripts/hosted/README.md']) assert.match(readFileSync(join(root, f), 'utf8'), /direct\*{0,2} connection only|direct connection only/i, f);
});
