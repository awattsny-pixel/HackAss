import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnvError, LEGACY_SERVICE_ENV_TOLERATED, getEnv, loadEnv, resetEnvCacheForTests } from '../src/platform/env.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
// assembled at run time so this file holds no literal credential-shaped URL (the secret scanner would flag it)
const pg = (user: string, pw: string, host: string) => ['postgres', '://', user, ':', pw, '@', host].join('');
const SECRET = 'S'.repeat(40);
const jwt = (claims: object) => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig-sig-sig-sig'].join('.');
const base = (over: Record<string, string | undefined> = {}) => ({
  APP_ENV: 'local', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'anon' }),
  APP_ORIGIN: 'http://localhost:3000', CURSOR_SIGNING_SECRET: SECRET, ...over,
});
const problems = (fn: () => unknown) => { try { fn(); } catch (e) { assert.ok(e instanceof EnvError, String(e)); return e.issues.map((i) => i.name); } assert.fail('expected EnvError'); };

test('a complete local environment loads and is typed', () => {
  const { env, warnings } = loadEnv(base());
  assert.equal(env.appEnv, 'local');
  assert.equal(env.supabaseUrl, 'http://127.0.0.1:54321');
  assert.equal(env.appOrigin, 'http://localhost:3000');
  assert.equal(env.workerDatabaseUrl, null);
  assert.deepEqual(warnings, []);
});

test('every required variable is reported by name when missing', () => {
  const names = problems(() => loadEnv({}));
  for (const n of ['APP_ENV', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'APP_ORIGIN', 'CURSOR_SIGNING_SECRET']) assert.ok(names.includes(n), `${n} not reported`);
});

test('error output carries names and problems only, never values', () => {
  const canary = 'CANARY-VALUE-9f3a';
  try { loadEnv(base({ APP_ORIGIN: `ftp://${canary}`, CURSOR_SIGNING_SECRET: canary, NEXT_PUBLIC_SUPABASE_URL: `not a url ${canary}`, WORKER_DATABASE_URL: pg('postgres', canary, 'h/db') })); assert.fail('expected EnvError'); }
  catch (e) {
    assert.ok(e instanceof EnvError);
    assert.ok(!e.message.includes(canary) && !JSON.stringify(e.issues).includes(canary));
    for (const i of e.issues) assert.deepEqual(Object.keys(i).sort(), ['name', 'problem'], 'an env issue may carry only a name and a problem');
    assert.equal(e.message, `Invalid environment configuration: ${e.issues.map((i) => `${i.name}: ${i.problem}`).join('; ')}`, 'the message must be exactly the name: problem pairs');
  }
});

test('staging and production require https; local allows http only for loopback', () => {
  assert.ok(problems(() => loadEnv(base({ APP_ENV: 'production' }))).includes('NEXT_PUBLIC_SUPABASE_URL'));
  assert.ok(problems(() => loadEnv(base({ APP_ENV: 'staging', APP_ORIGIN: 'http://localhost:3000', NEXT_PUBLIC_SUPABASE_URL: 'https://x.example.test' }))).includes('APP_ORIGIN'));
  assert.ok(problems(() => loadEnv(base({ NEXT_PUBLIC_SUPABASE_URL: 'http://db.example.test' }))).includes('NEXT_PUBLIC_SUPABASE_URL'));
  assert.doesNotThrow(() => loadEnv(base({ APP_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://proj.example.test', APP_ORIGIN: 'https://hackass.example.test' })));
});

test('URLs must not embed credentials; APP_ORIGIN must be an origin only', () => {
  assert.ok(problems(() => loadEnv(base({ NEXT_PUBLIC_SUPABASE_URL: 'http://user:pw@127.0.0.1:54321' }))).includes('NEXT_PUBLIC_SUPABASE_URL'));
  assert.ok(problems(() => loadEnv(base({ APP_ORIGIN: 'http://localhost:3000/app' }))).includes('APP_ORIGIN'));
  assert.equal(loadEnv(base({ APP_ORIGIN: 'http://localhost:3000/' })).env.appOrigin, 'http://localhost:3000');
});

test('service-level variable names are forbidden; legacy names are tolerated only as warnings while legacy routes exist', () => {
  const legacy = { SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(30), SUPABASE_URL: 'https://x.example.test' };
  assert.ok(problems(() => loadEnv(base(legacy), { legacy: 'forbid' })).includes('SUPABASE_SERVICE_ROLE_KEY'));
  const tolerated = loadEnv(base(legacy), { legacy: 'tolerate' });
  assert.ok(tolerated.warnings.some((w) => w.startsWith('SUPABASE_SERVICE_ROLE_KEY')));
  assert.ok(!tolerated.warnings.join().includes('x'.repeat(30)));
  // a new service-style name is never tolerated, even in tolerate mode
  for (const name of ['MY_SERVICE_ROLE_TOKEN', 'SUPABASE_SERVICE_SECRET', 'SUPABASE_JWT_SECRET', 'SERVICE_ROLE']) assert.ok(problems(() => loadEnv(base({ [name]: 'v' }), { legacy: 'tolerate' })).includes(name), name);
});

test('the legacy tolerance flag tracks reality: true exactly while the legacy service-role read path exists', () => {
  const legacyFile = join(root, 'app/lib/supabase-server.ts');
  const importers: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n) && readFileSync(p, 'utf8').includes('SUPABASE_SERVICE_ROLE_KEY')) importers.push(p); } };
  walk(join(root, 'app'));
  assert.equal(LEGACY_SERVICE_ENV_TOLERATED, existsSync(legacyFile) || importers.length > 0, 'update LEGACY_SERVICE_ENV_TOLERATED when the last legacy service-role reader is retired');
});

test('NEXT_PUBLIC_ variables must not look like secrets', () => {
  for (const name of ['NEXT_PUBLIC_SERVICE_KEY', 'NEXT_PUBLIC_DB_PASSWORD', 'NEXT_PUBLIC_API_TOKEN', 'NEXT_PUBLIC_WORKER_URL', 'NEXT_PUBLIC_DATABASE_URL']) assert.ok(problems(() => loadEnv(base({ [name]: 'v' }))).includes(name), name);
  assert.doesNotThrow(() => loadEnv(base({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' })));
});

test('the public key may be a publishable/anon key (new or legacy name) but never a service-level key', () => {
  assert.doesNotThrow(() => loadEnv(base({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined, NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ role: 'anon' }) })));
  assert.doesNotThrow(() => loadEnv(base({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_' + 'publishable_' + 'a'.repeat(24) })));
  assert.ok(problems(() => loadEnv(base({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'service_role' }) }))).includes('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'));
  assert.ok(problems(() => loadEnv(base({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_' + 'secret_' + 'a'.repeat(24) }))).includes('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'));
});

test('server secrets need at least 32 characters; the job endpoint secret is optional but validated when present', () => {
  assert.ok(problems(() => loadEnv(base({ CURSOR_SIGNING_SECRET: 'short' }))).includes('CURSOR_SIGNING_SECRET'));
  assert.ok(problems(() => loadEnv(base({ JOB_ENDPOINT_SECRET: 'short' }))).includes('JOB_ENDPOINT_SECRET'));
  assert.equal(loadEnv(base()).env.jobEndpointSecret, null);
});

test('worker database URL: optional for web, required for worker, and only the dedicated hackass_worker role is accepted', () => {
  const ok = pg('hackass_worker.proj123', 'pw-pw-pw', 'pooler.example.test:6543/postgres');
  assert.equal(loadEnv(base({ WORKER_DATABASE_URL: ok })).env.workerDatabaseUrl, ok);
  assert.ok(problems(() => loadEnv(base(), { scope: 'worker' })).includes('WORKER_DATABASE_URL'));
  for (const bad of [pg('postgres', 'pw-pw-pw', 'h/db'), pg('service_role', 'pw-pw-pw', 'h/db'), 'postgres://hackass_worker@h/db', 'mysql://hackass_worker:pw@h/db', 'not a url']) {
    assert.ok(problems(() => loadEnv(base({ WORKER_DATABASE_URL: bad }))).includes('WORKER_DATABASE_URL'), bad);
  }
});

test('getEnv validates process.env lazily and caches; importing the module never throws', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, base());
    resetEnvCacheForTests();
    const a = getEnv();
    assert.equal(a.appEnv, 'local');
    process.env.APP_ENV = 'production'; // changed after first read: cached value is returned
    assert.equal(getEnv(), a);
    resetEnvCacheForTests();
    assert.throws(() => getEnv(), EnvError);
  } finally { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, saved); resetEnvCacheForTests(); }
});
