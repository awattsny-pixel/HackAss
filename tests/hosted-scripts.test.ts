// Unit tests for scripts/hosted: target validation, the password-file reader, redaction, the SQL allowlist, the execution gates and static limits on what the scripts may contain.
// Nothing here contacts a hosted system, Docker, the Supabase CLI or a database (the integration run is scripts/hosted/selftest.mjs against the disposable local stack).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const load = (f: string) => import(pathToFileURL(join(root, 'scripts/hosted', f)).href);
const cfg = await load('lib/config.mjs');
const pass = await load('lib/passfile.mjs');
const red = await load('lib/redact.mjs');
const guard = await load('lib/sqlguard.mjs');
const gates = await load('lib/gates.mjs');
const cli = await load('lib/cli.mjs');
const oa = await load('lib/openapi.mjs');
const ctxm = await load('lib/context.mjs');

const REF = cfg.STAGING.ref as string;
const HOST = 'aws-0-us-east-1.pooler.supabase.com';
const OLD = 'oldprojectref0123456';
// secret-shaped test values are assembled at run time so that no literal key or credential URL is committed
const shaped = (kind: string) => `sb_${kind}_${'q'.repeat(20)}`;
const FAKE_DBURL = ['postgresql:/', '/u:hunter2pass@h:5432/postgres'].join('');
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const key = (ref: string) => [b64({ alg: 'HS256' }), b64({ ref }), b64({ sig: 'x' })].join('.');
function passfile(lines: string[], mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-test-')); const f = join(dir, 'pgpass');
  writeFileSync(f, lines.join('\n') + '\n'); chmodSync(f, mode); return f;
}
const goodLines = [`${HOST}:5432:postgres:postgres.${REF}:p1`, `${HOST}:6543:postgres:postgres.${REF}:p1`, `${HOST}:5432:postgres:hackass_worker.${REF}:p2`, `${HOST}:6543:postgres:hackass_worker.${REF}:p2`];
function env(over: Record<string, string> = {}, lines = goodLines) {
  return {
    STAGING_REF: REF, STAGING_URL: `https://${REF}.supabase.co`, STAGING_MIGRATE_HOST: HOST, STAGING_MIGRATE_PORT: '5432', STAGING_MIGRATE_USER: `postgres.${REF}`,
    STAGING_POOLER_TXN_HOST: HOST, STAGING_POOLER_TXN_PORT: '6543', STAGING_POOLER_SESSION_HOST: HOST, STAGING_POOLER_SESSION_PORT: '5432', STAGING_WORKER_USER: `hackass_worker.${REF}`,
    STAGING_PGPASSFILE: passfile(lines), STAGING_PUBLISHABLE_KEY: shaped('publishable'), STAGING_SECRET_KEY: shaped('secret'), FORBIDDEN_PROJECT_REFS: OLD, ...over,
  };
}
const errorsOf = (e: Record<string, string>, profile = 'staging') => cfg.validateTargets(e, { profile, repoRoot: root }).errors as string[];
const refused = (e: Record<string, string>, re: RegExp, profile = 'staging') => { const errs = errorsOf(e, profile); assert.ok(errs.some((x) => re.test(x)), `expected an error matching ${re}; got ${JSON.stringify(errs)}`); };

test('H0 accepts a fully consistent staging target set', () => { assert.deepEqual(errorsOf(env()), []); });
test('H0 rejects a wrong or forbidden project reference, and a missing forbidden list', () => {
  refused(env({ STAGING_REF: 'abcdefghijklmnopqrst' }), /STAGING_REF must be exactly/);
  refused(env({ FORBIDDEN_PROJECT_REFS: REF }), /in FORBIDDEN_PROJECT_REFS/);
  refused(env({ FORBIDDEN_PROJECT_REFS: '' }), /must name at least/);
  refused(env({ STAGING_URL: `https://${OLD}.supabase.co` }), /STAGING_URL must equal|forbidden/);
});
test('H0 rejects an API reference that does not match the database endpoints (each endpoint is validated on its own)', () => {
  refused(env({ STAGING_MIGRATE_USER: `postgres.${OLD}` }), /migration login on the pooler must be/);
  refused(env({ STAGING_WORKER_USER: `hackass_worker.${OLD}` }), /worker login must be/);
  refused(env({ STAGING_POOLER_TXN_HOST: 'aws-0-eu-west-1.pooler.supabase.com' }), /same host/);
  refused(env({ STAGING_MIGRATE_HOST: 'aws-0-eu-west-1.pooler.supabase.com' }), /must equal the pooler host/);
  refused(env({ STAGING_POOLER_TXN_PORT: '5432' }), /transaction port must be 6543/);
  refused(env({ STAGING_POOLER_SESSION_PORT: '6543' }), /session port must be 5432/);
});
test('H0 rejects loopback, private, address-literal and container hosts for a hosted profile', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.4', '192.168.1.1', 'host.docker.internal', 'supabase_db_x']) refused(env({ STAGING_POOLER_TXN_HOST: h, STAGING_POOLER_SESSION_HOST: h, STAGING_MIGRATE_HOST: h }), /host must|public DNS|must end|migration host/);
  refused(env({ STAGING_URL: 'http://127.0.0.1:54321' }), /STAGING_URL must equal/);
});
test('H0 validates the password file: presence, mode, location, entries, and forbidden references', () => {
  refused(env({ STAGING_PGPASSFILE: passfile(goodLines, 0o644) }), /mode must be 0600/);
  refused(env({ STAGING_PGPASSFILE: join(tmpdir(), 'does-not-exist-pgpass') }), /does not exist/);
  refused(env({ STAGING_PGPASSFILE: 'relative/pgpass' }), /absolute/);
  refused(env({ STAGING_PGPASSFILE: join(root, 'package.json') }), /inside the repository/);
  refused(env({}, goodLines.slice(0, 2)), /no entry for hackass_worker/);
  refused(env({}, [...goodLines, `${HOST}:5432:postgres:postgres.${OLD}:p3`]), /forbidden project reference|suffix/);
});
test('H0 rejects keys of another project and unset keys', () => {
  refused(env({ STAGING_SECRET_KEY: key(OLD) }), /different project reference|forbidden project/);
  refused(env({ STAGING_PUBLISHABLE_KEY: '' }), /STAGING_PUBLISHABLE_KEY is not set/);
  assert.deepEqual(errorsOf(env({ STAGING_SECRET_KEY: key(REF) })), []);
});
test('the staging profile never accepts selftest targets and the selftest profile never accepts hosted ones', () => {
  refused(env({ STAGING_REF: 'selftest', STAGING_URL: 'http://127.0.0.1:54321', STAGING_MIGRATE_HOST: 'host.docker.internal' }), /STAGING_REF must be exactly/);
  refused(env(), /STAGING_REF must be exactly "selftest"/, 'selftest');
  refused(env({ STAGING_REF: 'selftest' }), /selftest STAGING_URL|selftest .* host must be/, 'selftest');
  assert.throws(() => ctxm.createContext(env({ STAGING_REF: 'abcdefghijklmnopqrst' }), { profile: 'staging', repoRoot: root }), /target validation failed/);
});
test('the password file reader never returns a password', () => {
  const f = passfile(['h:5432:postgres:u:SuperSecret-Value!']);
  const e = pass.parsePassfileEntries(f);
  assert.equal(e.length, 1); assert.deepEqual(Object.keys(e[0]).sort(), ['database', 'host', 'login', 'port']);
  assert.ok(!JSON.stringify(e).includes('SuperSecret'));
  assert.ok(!JSON.stringify(pass.parsePassfileLine('h:5432:postgres:u:SuperSecret-Value!')).includes('SuperSecret'));
});
test('connection strings carry no password', () => {
  const t = { host: HOST, port: 5432, user: `postgres.${REF}`, profile: 'staging' };
  for (const s of [cfg.conninfo(t), cfg.cliUrl(t)]) { assert.ok(!/:[^@\s/]*@/.test(s.replace(/^postgres(ql)?:\/\//, '').split('@')[0].includes(':') ? s : 'x'), s); assert.ok(!/sslmode=(disable|allow|prefer)/.test(s)); }
});

test('redaction removes tokens, keys, passwords, connection strings and non-synthetic e-mail; registered secrets in any position', () => {
  red.clearRegisteredSecrets(); red.registerSecret('Pw-generated-secret-1234');
  const dirty = `jwt ${key(REF)} key ${shaped('secret')} url ${FAKE_DBURL} Bearer abcdefghijklmnop password=hunter3pass mail a@b.com ok x@example.test Pw-generated-secret-1234`;
  const out = red.redact(dirty);
  for (const s of ['eyJ', 'sb_secret' + '_q', 'hunter2pass', 'abcdefghijklmnop', 'hunter3pass', 'a@b.com', 'Pw-generated-secret-1234']) assert.ok(!out.includes(s), `${s} survived: ${out}`);
  assert.ok(out.includes('x@example.test'));
  assert.equal(red.looksSecret(out), false); assert.equal(red.looksSecret(dirty), true);
  red.clearRegisteredSecrets();
});

const UID = '11111111-2222-3333-4444-555555555555'; const OTHER = '99999999-2222-3333-4444-555555555555';
test('SQL guard: reads stay reads; every write kind is confined', () => {
  assert.doesNotThrow(() => guard.checkSql('select 1', 'read'));
  for (const bad of ['update app.jobs set status = 1', 'drop table app.hacks', 'select pg_sleep(1); delete from app.hacks', 'truncate app.hacks', 'alter role postgres password \'x\'', 'create extension x', 'grant all on app.hacks to anon']) assert.throws(() => guard.checkSql(bad, 'read'), guard.SqlRefused, bad);
  for (const bad of ['drop schema app cascade', 'delete from app.hacks', 'update app.hacks set title = 1', 'insert into supabase_migrations.schema_migrations values (1)', 'alter user postgres with password \'x\'', 'alter role hackass_worker password \'x\'', 'select set_config(\'a\',\'b\',false)']) assert.throws(() => guard.checkSql(`set role hackass_owner;\n${bad}`, 'fixture', { fixtureIds: new Set([UID]) }), guard.SqlRefused, bad);
});
test('SQL guard: role administration is only the marker, only as postgres, never after SET ROLE', () => {
  assert.doesNotThrow(() => guard.checkSql(guard.MARKER_SET_SQL('0123456789abcdef0123'), 'admin'));
  assert.doesNotThrow(() => guard.checkSql(guard.MARKER_RESET_SQL, 'admin'));
  assert.throws(() => guard.checkSql(`set role hackass_owner;\n${guard.MARKER_RESET_SQL}`, 'admin'), guard.SqlRefused);
  assert.throws(() => guard.checkSql('alter role hackass_worker password \'x\'', 'admin'), guard.SqlRefused);
  assert.throws(() => guard.checkSql('comment on role postgres is \'x\'', 'admin'), guard.SqlRefused);
  assert.throws(() => guard.checkSql(guard.STAFF_INSERT_SQL(UID), 'admin'), guard.SqlRefused);
});
test('SQL guard: fixture DML needs SET ROLE first and names only fixture users, the registered job, or the category', () => {
  const ids = new Set([UID]);
  assert.throws(() => guard.checkSql(guard.STAFF_INSERT_SQL(UID), 'fixture', { fixtureIds: ids }), /SET ROLE/);
  assert.doesNotThrow(() => guard.checkSql(`set role hackass_owner;\n${guard.STAFF_INSERT_SQL(UID)};\n${guard.STAFF_REVOKE_SQL(UID)}`, 'fixture', { fixtureIds: ids }));
  assert.throws(() => guard.checkSql(`set role hackass_owner;\n${guard.STAFF_INSERT_SQL(OTHER)}`, 'fixture', { fixtureIds: ids }), /not a fixture/);
  assert.doesNotThrow(() => guard.checkSql(`set role hackass_owner;\n${guard.CATEGORY_INSERT_SQL('stg-run-1')}`, 'fixture'));
  const J = '33333333-3333-3333-3333-333333333333'; const P = '44444444-4444-4444-4444-444444444444';
  assert.doesNotThrow(() => guard.checkSql(`set role hackass_owner;\n${guard.JOB_DUE_SQL(J, P)}`, 'fixture', { allowedJobTargets: new Set([`${J}:${P}`]) }));
  assert.throws(() => guard.checkSql(`set role hackass_owner;\n${guard.JOB_DUE_SQL(J, P)}`, 'fixture', { allowedJobTargets: new Set() }), /not registered/);
});
test('SQL guard: the worker probes are a fixed list', () => {
  for (const p of guard.PROBES) assert.deepEqual(guard.checkSql(p, 'probe'), [p]);
  assert.throws(() => guard.checkSql('select 1 from app.hacks', 'probe'), guard.SqlRefused);
  assert.throws(() => guard.checkSql('select 1', 'unknown-kind'), /unknown SQL kind/);
});

const SHA = 'a'.repeat(40); const git = { head: SHA, clean: true };
const flagsFor = (stage: string, extra: Record<string, string> = {}) => ({ authorized: `${require_group(stage)}@${SHA}`, ...extra });
function require_group(stage: string) { return stage === 'cleanup' ? 'S9' : ['preflight'].includes(stage) ? 'S6' : ['identity', 'migrate', 'exposure', 'worker-marker', 'rerun', 'inventory'].includes(stage) ? 'S7' : 'S8'; }
const done = (...s: string[]) => ({ binding: { commit: SHA, profile: 'staging', targets: 'T' }, stages: Object.fromEntries(s.map((x) => [x, { status: 'done', commit: SHA }])) });
test('gates: authorization names the group and the exact HEAD; the tree must be clean for staging', () => {
  const ok = () => gates.checkGates('preflight', flagsFor('preflight'), done(), git, { profile: 'staging', targetsHash: 'T' });
  assert.doesNotThrow(ok);
  assert.throws(() => gates.checkGates('preflight', {}, done(), git, { profile: 'staging', targetsHash: 'T' }), /authorized/);
  assert.throws(() => gates.checkGates('preflight', { authorized: `S7@${SHA}` }, done(), git, { profile: 'staging', targetsHash: 'T' }), /belongs to authorization S6/);
  assert.throws(() => gates.checkGates('preflight', { authorized: `S6@${'b'.repeat(40)}` }, done(), git, { profile: 'staging', targetsHash: 'T' }), /not the checked-out HEAD/);
  assert.throws(() => gates.checkGates('preflight', { authorized: `S6@${'a'.repeat(7)}` }, done(), git, { profile: 'staging', targetsHash: 'T' }), /authorized/);
  assert.throws(() => gates.checkGates('preflight', flagsFor('preflight'), done(), { head: SHA, clean: false }, { profile: 'staging', targetsHash: 'T' }), /not clean/);
});
test('gates: mutating stages need their own confirmation, their prerequisites, the owner confirmations, and run once', () => {
  assert.throws(() => gates.checkGates('identity', flagsFor('identity'), done('preflight'), git, { profile: 'staging', targetsHash: 'T' }), /confirm-mutating=identity/);
  assert.doesNotThrow(() => gates.checkGates('identity', flagsFor('identity', { 'confirm-mutating': 'identity' }), done('preflight'), git, { profile: 'staging', targetsHash: 'T' }));
  assert.throws(() => gates.checkGates('migrate', flagsFor('migrate', { 'confirm-mutating': 'migrate' }), done('preflight'), git, { profile: 'staging', targetsHash: 'T' }), /identity must be completed/);
  assert.throws(() => gates.checkGates('exposure', flagsFor('exposure'), done('preflight', 'identity', 'migrate'), git, { profile: 'staging', targetsHash: 'T' }), /owner action "exposure"/);
  assert.doesNotThrow(() => gates.checkGates('exposure', flagsFor('exposure', { 'owner-confirmed': 'exposure' }), done('preflight', 'identity', 'migrate'), git, { profile: 'staging', targetsHash: 'T' }));
  assert.throws(() => gates.checkGates('worker-marker', flagsFor('worker-marker', { 'confirm-mutating': 'worker-marker', 'owner-confirmed': 'exposure' }), done('preflight', 'identity', 'migrate', 'exposure'), git, { profile: 'staging', targetsHash: 'T' }), /worker-password/);
  assert.throws(() => gates.checkGates('migrate', flagsFor('migrate', { 'confirm-mutating': 'migrate' }), done('preflight', 'identity', 'migrate'), git, { profile: 'staging', targetsHash: 'T' }), /not repeatable/);
  assert.doesNotThrow(() => gates.checkGates('preflight', flagsFor('preflight'), done('preflight'), git, { profile: 'staging', targetsHash: 'T' }), 'read-only stages may be repeated');
});
test('gates: a failed stage blocks the run, except that cleanup may always be repeated; cleanup needs only preflight', () => {
  const failed = { ...done('preflight'), stages: { preflight: { status: 'done', commit: SHA }, identity: { status: 'failed', commit: SHA } } };
  assert.throws(() => gates.checkGates('identity', flagsFor('identity', { 'confirm-mutating': 'identity' }), failed, git, { profile: 'staging', targetsHash: 'T' }), /not healthy/);
  const cf = { ...done('preflight'), stages: { preflight: { status: 'done', commit: SHA }, cleanup: { status: 'failed', commit: SHA } } };
  assert.doesNotThrow(() => gates.checkGates('cleanup', flagsFor('cleanup', { 'confirm-mutating': 'cleanup' }), cf, git, { profile: 'staging', targetsHash: 'T' }));
  assert.doesNotThrow(() => gates.checkGates('cleanup', flagsFor('cleanup', { 'confirm-mutating': 'cleanup' }), done('preflight'), git, { profile: 'staging', targetsHash: 'T' }));
  assert.doesNotThrow(() => gates.checkGates('evidence', {}, failed, git, { profile: 'staging', targetsHash: 'T' }), 'evidence is available for a failed run');
});
test('flags: unknown shapes are refused', () => {
  assert.deepEqual(cli.parseFlags(['--run-id=abc', '--delete-raw']), { 'run-id': 'abc', 'delete-raw': true });
  assert.throws(() => cli.parseFlags(['run-id=abc']), /unexpected argument/);
  assert.throws(() => cli.parseFlags(['--PASSWORD=x']), /unexpected argument/);
});
test('the OpenAPI surface separates functions from everything else', () => {
  const s = oa.openApiSurface({ paths: { '/': {}, '/rpc/whoami': {}, '/rpc/list_public_hacks': {}, '/hacks': {} } });
  assert.deepEqual(s, { rpc: ['list_public_hacks', 'whoami'], other: ['/hacks'] });
});

// ---- static limits on the scripts themselves ----
const dir = join(root, 'scripts/hosted');
const files = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : p.endsWith('.mjs') ? [p] : []; });
const sources = files(dir).map((p) => ({ name: relative(root, p), text: readFileSync(p, 'utf8') }));
test('no script links a project, logs in, pushes, deploys, or passes a password in an argument or URL', () => {
  for (const { name, text } of sources) {
    for (const re of [/['"`]link['"`]/, /\bsupabase\s+(login|link|projects)\b/, /git\s+push|['"]push['"]\s*,\s*['"]origin/, /\bvercel\b/i, /SUPABASE_DB_PASSWORD/, /--password\b/, /PGPASSWORD/, /postgres(ql)?:\/\/[^'"`\s$]*:[^'"`\s@$]+@/]) {
      const hit = text.split('\n').filter((l) => re.test(l) && !/^\s*\/\//.test(l)); // comments may explain what is not done
      assert.deepEqual(hit, [], `${name} matches ${re}`);
    }
  }
});
test('read-only stages import nothing that can change hosted state', () => {
  for (const f of ['preflight.mjs', 'isolation.mjs']) {
    const t = sources.find((s) => s.name.endsWith(`hosted/${f}`))!.text;
    assert.ok(!/kind:\s*'(admin|fixture)'/.test(t), `${f} runs mutating SQL`);
    assert.ok(!/adminCreateUser|adminDeleteUser|MARKER_SET|STAFF_INSERT|JOB_DUE_SQL|db['"],\s*['"]push/.test(t), `${f} imports a mutating helper`);
  }
});
test('no real project reference of the legacy project or a key-shaped string is committed in the scripts', () => {
  for (const { name, text } of sources) { assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(text), `${name} holds a JWT`); assert.ok(!/sb_(secret|publishable)_[A-Za-z0-9_-]{16,}/.test(text), `${name} holds a key`); }
});
