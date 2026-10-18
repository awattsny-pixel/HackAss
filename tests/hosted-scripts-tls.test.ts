// Certificate verification on the migration route: the owner-supplied root certificate file is validated (path, ownership, content, parse, validity; CA status is recorded but not required), the staging profile requires it, and the migration endpoint and the
// CLI connect with sslmode=verify-full against it. Nothing here contacts a hosted system; the behavior of psql and the pinned CLI against a real TLS server (wrong CA and wrong host
// refused) was measured on a throwaway local server and is recorded in docs/hosted/migration-route.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const load = (f: string) => import(pathToFileURL(join(root, 'scripts/hosted', f)).href);
const cfg = await load('lib/config.mjs');
const rc = await load('lib/rootcert.mjs');
const migrate = await load('lib/migrate.mjs');

const REF = cfg.STAGING.ref as string; const POOLER = 'aws-0-us-east-1.pooler.supabase.com'; const DIRECT = `db.${REF}.supabase.co`;
const made: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hs-tls-')); chmodSync(d, 0o700); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const FIXTURE = join(root, 'tests/fixtures/hosted-test-root-ca.pem');
const pem = () => readFileSync(FIXTURE, 'utf8');
const KEYBLOCK = ['-----BEGIN', 'PRIVATE KEY-----\nAAAA\n-----END', 'PRIVATE KEY-----'].join(' '); // assembled at run time so that no key-block literal is committed
/** A copy of the public test root certificate under a directory whose name contains spaces (the real paths do). */
function caCopy(mode = 0o644, text = pem()) { const d = join(tmp(), 'dir with spaces'); mkdirSync(d); const f = join(d, 'root ca.pem'); writeFileSync(f, text); chmodSync(f, mode); return f; }
const problems = (f: string, extra: Record<string, unknown> = {}) => rc.rootCertProblems(f, { repoRoot: root, ...extra }).problems as string[];
const has = (p: string[], re: RegExp) => assert.ok(p.some((x) => re.test(x)), `expected ${re}; got ${JSON.stringify(p)}`);

test('1. a public root certificate file is accepted: spaces in the path, mode 0644, parseable, currently valid', () => {
  const r = rc.rootCertProblems(caCopy(), { repoRoot: root }); assert.deepEqual(r.problems, []); assert.equal(r.certs.length, 1); assert.equal(r.certs[0].ca, true);
  assert.deepEqual(problems(caCopy(0o600)), []); assert.deepEqual(problems(caCopy(0o444)), []);
  assert.deepEqual(problems(caCopy(0o644, `${pem()}\n${pem()}`)), [], 'a bundle of certificates');
});

test('2. a root certificate file that is not exactly valid, current, unshared PEM certificates is refused', () => {
  has(problems(''), /not set/); has(problems('relative/ca.pem'), /absolute/); has(problems(join(tmp(), 'missing.pem')), /does not exist/);
  has(problems(tmp()), /not a regular file/);
  const link = join(tmp(), 'link.pem'); symlinkSync(caCopy(), link); has(problems(link), /symbolic link/);
  has(problems(caCopy(0o644, '')), /empty/); has(problems(caCopy(0o644, 'not a certificate\n')), /no PEM certificate/);
  has(problems(caCopy(0o644, `${pem()}\nstray text\n`)), /text other than PEM certificates/);
  has(problems(caCopy(0o644, `${pem()}\n${KEYBLOCK}\n`)), /private key/);
  has(problems(caCopy(0o644, '-----BEGIN CERTIFICATE-----\nAAAAAAAA\n-----END CERTIFICATE-----\n')), /cannot be parsed/);
  has(problems(caCopy(0o664)), /writable by group or others/); has(problems(caCopy(0o646)), /writable by group or others/);
  has(problems(caCopy(0o644, `${pem()}\n${'A'.repeat(70_000)}`)), /larger than/);
  has(problems(caCopy(), { now: new Date('2127-01-01') }), /has expired/); has(problems(caCopy(), { now: new Date('2000-01-01') }), /not valid yet/);
  has(problems(join(root, 'tests/fixtures/hosted-test-root-ca.pem')), /inside the repository/);
  has(problems(caCopy(), { uid: (process.getuid?.() ?? 0) + 1 }), /not owned by the current user/);
});

function env(over: Record<string, string> = {}) {
  const pf = join(tmp(), 'pgpass'); writeFileSync(pf, [`${POOLER}:5432:postgres:postgres.${REF}:p1`, `${POOLER}:6543:postgres:postgres.${REF}:p1`, `${POOLER}:5432:postgres:hackass_worker.${REF}:p2`, `${POOLER}:6543:postgres:hackass_worker.${REF}:p2`, `${DIRECT}:5432:postgres:postgres:p0`].join('\n') + '\n', { mode: 0o600 });
  return { STAGING_REF: REF, STAGING_URL: `https://${REF}.supabase.co`, STAGING_MIGRATE_HOST: DIRECT, STAGING_MIGRATE_PORT: '5432', STAGING_MIGRATE_USER: 'postgres', STAGING_POOLER_USER: `postgres.${REF}`,
    STAGING_POOLER_TXN_HOST: POOLER, STAGING_POOLER_TXN_PORT: '6543', STAGING_POOLER_SESSION_HOST: POOLER, STAGING_POOLER_SESSION_PORT: '5432', STAGING_WORKER_USER: `hackass_worker.${REF}`,
    STAGING_PGPASSFILE: pf, STAGING_PUBLISHABLE_KEY: 'sb_publishable_' + 'q'.repeat(20), STAGING_SECRET_KEY: 'sb_secret_' + 'q'.repeat(20), STAGING_SSLROOTCERT: caCopy(), FORBIDDEN_PROJECT_REFS: 'oldprojectref0123456', ...over } as Record<string, string>;
}
const errorsOf = (e: Record<string, string>, profile = 'staging') => cfg.validateTargets(e, { profile, repoRoot: root }).errors as string[];

test('3. target validation: the staging profile requires a good root certificate, the selftest profile (no TLS) refuses one', () => {
  assert.deepEqual(errorsOf(env()), []);
  has(errorsOf(env({ STAGING_SSLROOTCERT: '' })), /STAGING_SSLROOTCERT is not set/);
  has(errorsOf(env({ STAGING_SSLROOTCERT: caCopy(0o644, 'nope\n') })), /STAGING_SSLROOTCERT holds no PEM certificate/);
  has(errorsOf(env({ STAGING_SSLROOTCERT: caCopy(0o666) })), /writable by group or others/);
  has(errorsOf(env({ STAGING_SSLROOTCERT: join(root, 'tests/fixtures/hosted-test-root-ca.pem') })), /inside the repository/);
  const self = { HOSTED_SELFTEST: '1', STAGING_REF: 'selftest', STAGING_URL: 'http://127.0.0.1:54321', STAGING_MIGRATE_HOST: 'host.docker.internal', STAGING_MIGRATE_PORT: '54322', STAGING_MIGRATE_USER: 'postgres', STAGING_POOLER_USER: 'postgres',
    STAGING_POOLER_TXN_HOST: 'host.docker.internal', STAGING_POOLER_TXN_PORT: '54322', STAGING_POOLER_SESSION_HOST: 'host.docker.internal', STAGING_POOLER_SESSION_PORT: '54322', STAGING_WORKER_USER: 'hackass_worker',
    STAGING_PGPASSFILE: join(tmp(), 'pgpass'), STAGING_PUBLISHABLE_KEY: 'sb_publishable_' + 'q'.repeat(20), STAGING_SECRET_KEY: 'sb_secret_' + 'q'.repeat(20) };
  writeFileSync(self.STAGING_PGPASSFILE, 'host.docker.internal:54322:postgres:postgres:p\nhost.docker.internal:54322:postgres:hackass_worker:p\n', { mode: 0o600 });
  assert.deepEqual(errorsOf(self, 'selftest'), []); has(errorsOf({ ...self, STAGING_SSLROOTCERT: caCopy() }, 'selftest'), /selftest has no TLS/);
});

test('4. the psql connection string verifies certificate AND host name when asked, never weakens, and the selftest profile has no TLS', () => {
  const base = { host: DIRECT, port: 5432, user: 'postgres', profile: 'staging' };
  assert.match(cfg.conninfo({ ...base, verify: true }), /sslmode=verify-full sslrootcert=\/sslroot\.crt/); assert.match(cfg.conninfo(base), /sslmode=require/);
  assert.match(cfg.conninfo({ host: 'host.docker.internal', port: 54322, user: 'postgres', profile: 'selftest' }), /sslmode=disable/);
  assert.throws(() => cfg.conninfo({ host: 'host.docker.internal', port: 54322, user: 'postgres', profile: 'selftest', verify: true }), /no TLS to verify/);
  for (const s of [cfg.conninfo({ ...base, verify: true })]) assert.ok(!/sslmode=(disable|allow|prefer|require|verify-ca)/.test(s));
});

test('5. the CLI url carries verify-full and the root certificate path (spaces encoded); staging without a root certificate cannot build one', () => {
  const f = caCopy(); const u = cfg.cliUrl({ host: DIRECT, port: 5432, user: 'postgres', profile: 'staging', sslRootCert: f });
  const q = new URL(u).searchParams; assert.equal(q.get('sslmode'), 'verify-full'); assert.equal(q.get('sslrootcert'), f); assert.match(u, /sslrootcert=[^&\s]*%20/);
  for (const bad of [undefined, '', 'relative/ca.pem', null]) assert.throws(() => cfg.cliUrl({ host: DIRECT, port: 5432, user: 'postgres', profile: 'staging', sslRootCert: bad }), /certificate verification is required/);
  assert.equal(new URL(cfg.cliUrl({ host: 'host.docker.internal', port: 54322, user: 'postgres', profile: 'selftest' })).searchParams.get('sslmode'), 'disable');
});

test('6. the actual migration invocation hands the CLI verify-full and the root certificate', async () => {
  const f = caCopy(); let seen: string[] = [];
  const ctx = { profile: 'staging', targets: { migrate: { host: DIRECT, port: 5432, user: 'postgres' }, passfile: '/nonexistent', sslRootCert: f, ref: REF } };
  const deps = { sql: async () => ({ ok: true, stdout: '1760567890.123456', stderr: '' }), run: async (_c: string, args: string[]) => { seen = args; return { code: 0, signal: null, stdout: '{"type":"result","data":{"upToDate":true,"migrations":[]}}\n', stderr: '', timedOut: false, truncated: false }; }, sleep: async () => {} };
  await migrate.pushMigrations(ctx, { cli: '/bin/true', deps });
  const url = new URL(seen[seen.indexOf('--db-url') + 1]); assert.equal(url.searchParams.get('sslmode'), 'verify-full'); assert.equal(url.searchParams.get('sslrootcert'), f);
  await assert.rejects(() => migrate.pushMigrations({ ...ctx, targets: { ...ctx.targets, sslRootCert: '' } }, { cli: '/bin/true', deps: { ...deps, run: async () => { throw new Error('the CLI must not start'); } } }), /certificate verification is required/);
});

test('7. CA status is recorded, not enforced: a non-CA (leaf) certificate is accepted and reported as ca = false', () => {
  const leaf = readFileSync(join(root, 'tests/fixtures/hosted-test-leaf.pem'), 'utf8');
  const r = rc.rootCertProblems(caCopy(0o644, leaf), { repoRoot: root });
  assert.deepEqual(r.problems, []); assert.equal(r.certs.length, 1); assert.equal(r.certs[0].ca, false);
  assert.equal(rc.rootCertProblems(caCopy(), { repoRoot: root }).certs[0].ca, true);
  const doc = readFileSync(join(root, 'docs/hosted/migration-route.md'), 'utf8'); assert.match(doc, /does \*\*not require\*\* it/); assert.ok(!/checked as a trust anchor/.test(doc));
  assert.match(readFileSync(join(root, 'scripts/hosted/lib/rootcert.mjs'), 'utf8'), /does not enforce CA status/);
});
