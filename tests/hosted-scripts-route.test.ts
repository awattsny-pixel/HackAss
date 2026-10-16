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
