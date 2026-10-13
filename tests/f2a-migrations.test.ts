// Static hygiene checks on the F2-A SQL (the behavioural proofs run against the real local stack: supabase/tests/database
// and scripts/local-f2a-checks.mjs). These catch convention drift without needing Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const migDir = join(root, 'supabase/migrations');
const files = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
const sql = Object.fromEntries(files.map((f) => [f, readFileSync(join(migDir, f), 'utf8')]));
const all = files.map((f) => sql[f]).join('\n');
const code = (t: string) => t.replace(/--.*$/gm, '');

test('F2-A migrations: three timestamped, ordered files, no stray files', () => {
  assert.deepEqual(files.map((f) => f.replace(/^\d{14}_/, '')), ['f2a_roles_and_schemas.sql', 'f2a_identity_and_staff.sql', 'f2a_authorization_guards.sql']);
  assert.deepEqual(readdirSync(migDir).filter((f) => !f.endsWith('.sql')), ['.gitkeep']);
  for (const f of files) assert.match(f, /^\d{14}_[a-z0-9_]+\.sql$/);
});

test('no secret in SQL: the worker role is created without a password and no migration sets one', () => {
  const c = code(all);
  assert.ok(!/\bpassword\b/i.test(c), 'migrations must not mention passwords outside comments');
  assert.match(c, /create role hackass_worker login;/);
  assert.match(c, /create role hackass_owner nologin;/);
});

test('every function created by a migration is SECURITY DEFINER with an empty search_path', () => {
  const stmts = code(all).match(/create (?:or replace )?function [\s\S]*?\$\$\s*;/gi) ?? [];
  assert.ok(stmts.length >= 8, `found only ${stmts.length} function definitions`);
  for (const s of stmts) {
    const name = s.match(/create (?:or replace )?function\s+([\w.]+)/i)![1];
    assert.match(s, /security definer/i, `${name} must be SECURITY DEFINER`);
    assert.match(s, /set search_path = ''/i, `${name} must set search_path = ''`);
  }
});

test('no grant to PUBLIC, anon or service_role beyond the api schema USAGE, and EXECUTE is never granted broadly', () => {
  const grants = (code(all).match(/\bgrant\b[^;]*;/gi) ?? []).map((g) => g.replace(/\s+/g, ' ').trim());
  for (const g of grants) {
    assert.ok(!/\bto\b[^;]*\bpublic\b/i.test(g), `grant to PUBLIC: ${g}`);
    assert.ok(!/\bservice_role\b/i.test(g), `grant involving service_role: ${g}`);
    if (/\banon\b/i.test(g)) assert.equal(g, 'grant usage on schema api to anon, authenticated;', `anon may only get USAGE on schema api: ${g}`);
    assert.ok(!/\ball privileges\b|\bon all (tables|functions|sequences)\b/i.test(g), `blanket grant: ${g}`);
  }
  const executes = grants.filter((g) => /grant execute/i.test(g));
  assert.deepEqual(executes.map((g) => g.replace(/^grant execute on function /i, '')).sort(), [
    'api.whoami(), api.staff_probe(text, integer) to authenticated;',
    'app_bridge.session_valid(uuid, uuid) to hackass_owner;',
    'app_guard.on_auth_user_created(), app_guard.on_auth_user_deleted() to postgres;',
    'app_guard.on_auth_user_created(), app_guard.on_auth_user_deleted() to supabase_auth_admin;',
    'worker.healthcheck() to hackass_worker;',
  ].sort(), 'the complete list of EXECUTE grants');
});

test('every function has its PUBLIC execute revoked before any grant, and every api function begins with a guard call', () => {
  const c = code(all);
  for (const fn of ['app_bridge.session_valid(uuid, uuid)', 'api.whoami()', 'api.staff_probe(text, integer)', 'worker.healthcheck()', 'app_guard.require_member()', 'app_guard.require_staff(text, interval)', 'app_guard.on_auth_user_created()']) {
    assert.ok(c.includes(fn), `${fn} missing`);
  }
  assert.match(c, /revoke all on function app_bridge\.session_valid\(uuid, uuid\) from public;/);
  assert.match(c, /revoke all on function app_guard\.require_member\(\), app_guard\.require_staff\(text, interval\),\s+api\.whoami\(\), api\.staff_probe\(text, integer\), worker\.healthcheck\(\) from public;/);
  for (const m of c.matchAll(/create function (api\.\w+)[\s\S]*?\$\$\s*(?:declare[\s\S]*?)?begin\s+(v_\w+ := |perform )?(app_guard\.require_\w+)\(/gi)) assert.ok(m[1] && m[3], m[0].slice(0, 60));
  assert.equal((c.match(/create function api\./g) ?? []).length, (c.match(/create function api\.\w+[\s\S]*?\$\$\s*(?:declare[\s\S]*?)?begin\s+(?:v_\w+ := |perform )?app_guard\.require_\w+\(/g) ?? []).length, 'every api function starts with a guard');
});

test('the staff guard has no MFA switch, no clock-skew allowance, and validates NULL/out-of-range arguments inside the guard', () => {
  const c = code(all);
  const guard = c.match(/create function app_guard\.require_staff\([\s\S]*?\n\$\$;/)![0];
  assert.ok(!/boolean/i.test(guard) && !/p_require_mfa/.test(guard), 'no boolean/optional-MFA parameter');
  assert.ok(!/interval '1 minute'/.test(guard), 'no skew allowance');
  assert.match(guard, /p_min_role is null or p_min_role not in \('reviewer', 'admin'\)/);
  assert.match(guard, /p_max_mfa_age is null or p_max_mfa_age <= interval '0' or p_max_mfa_age > interval '15 minutes'/);
  assert.match(guard, /v_actor\.mfa_verified_at > pg_catalog\.now\(\)/);
  assert.match(guard, /v_actor\.aal is distinct from 'aal2'/);
  assert.match(guard, /raise exception 'invalid_argument' using errcode = '22023'/);
});

test('the schemas that PostgREST exposes are exactly public, graphql_public and api; the application schemas are not exposed', () => {
  const toml = readFileSync(join(root, 'supabase/config.toml'), 'utf8');
  assert.match(toml, /^schemas = \["public", "graphql_public", "api"\]$/m);
  assert.ok(!/^schemas = .*\b(app|app_guard|worker|app_bridge)\b/m.test(toml));
});

test('the rollback script removes every schema, role and trigger the migrations create, and un-ledgers exactly their versions', () => {
  const down = code(readFileSync(join(root, 'supabase/rollbacks/20261013130000_f2a_down.sql'), 'utf8'));
  const created = [...all.matchAll(/create schema (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(created, ['api', 'app', 'app_bridge', 'app_guard', 'worker']);
  for (const s of created) assert.match(down, new RegExp(`drop schema if exists ${s} cascade;`), `rollback must drop schema ${s}`);
  for (const r of ['hackass_worker', 'hackass_owner']) assert.match(down, new RegExp(`drop role if exists ${r};`));
  for (const t of [...all.matchAll(/create trigger (\w+)/g)].map((m) => m[1])) assert.match(down, new RegExp(`drop trigger if exists ${t} on auth\\.users;`));
  const versions = files.map((f) => f.slice(0, 14));
  assert.match(down, new RegExp(`version in \\(${versions.map((v) => `'${v}'`).join(', ')}\\)`));
  assert.match(down, /^\s*begin;/m);
  assert.match(down, /^\s*commit;/m);
  assert.ok(!/drop schema (if exists )?(auth|public|storage|extensions)\b/i.test(down), 'the rollback never touches Supabase-managed schemas');
});

test('the pgTAP files exist and keep their no-drift inventory assertions', () => {
  const inventory = readFileSync(join(root, 'supabase/tests/database/010_roles_and_grants.test.sql'), 'utf8');
  for (const needle of ['function inventory', 'schema privileges', 'hackass_owner has no privilege on the auth schema', 'row-level security is on', 'a function later created by the owner is not executable by PUBLIC']) assert.ok(inventory.includes(needle), needle);
  const authz = readFileSync(join(root, 'supabase/tests/database/020_authorization.test.sql'), 'utf8');
  for (const needle of ['user/session mismatch', 'an expired session is rejected', 'a banned user', 'a disabled account is rejected although', 'the service_role has no EXECUTE', 'MFA 16 minutes old is stale', 'insufficient MFA', 'after the assignment is revoked']) assert.ok(authz.includes(needle), needle);
});

test('G-3 in the F2 acceptance contract records the exact bridge ownership exception instead of a blanket owner rule', () => {
  const g3 = readFileSync(join(root, 'docs/foundation/f2-acceptance.md'), 'utf8').split('\n').find((l) => l.startsWith('| G-3 |'))!;
  assert.match(g3, /with exactly one exception/);
  assert.match(g3, /app_bridge\.session_valid\(uuid, uuid\)/);
  assert.match(g3, /owned by `postgres`/);
  assert.match(g3, /grantee \(`hackass_owner` only\)/);
});
