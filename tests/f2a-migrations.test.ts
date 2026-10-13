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

test('F2-A and F2-B migrations: seven timestamped, ordered files, no stray files', () => {
  assert.deepEqual(files.map((f) => f.replace(/^\d{14}_/, '')), ['f2a_roles_and_schemas.sql', 'f2a_identity_and_staff.sql', 'f2a_authorization_guards.sql', 'f2b_content_tables.sql', 'f2b_canonical_hash.sql', 'f2b_immutability.sql', 'f2b_content_rpc.sql']);
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
    'api.create_draft(uuid), api.save_draft(uuid, jsonb), api.get_version(uuid), api.list_my_versions(), api.submit_version(uuid, text), api.delete_draft(uuid) to authenticated;',
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

test('every function in an application schema has PUBLIC execute revoked, and no table is ever granted to anyone', () => {
  const c = code(all);
  const created = [...c.matchAll(/create function ((?:api|app_guard|app_content|app_bridge|worker)\.\w+)\(/g)].map((m) => m[1]);
  assert.ok(created.length >= 30, `only ${created.length} functions found`);
  const revokes = (c.match(/revoke all on function[\s\S]*?from public;/gi) ?? []).join('\n');
  const defaults = /alter default privileges revoke all on functions from public;/.test(c);
  assert.ok(defaults, 'default privileges revoke PUBLIC execute for everything the owner creates');
  for (const fn of created) assert.ok(revokes.includes(`${fn}(`), `${fn} has no explicit revoke from public`);
  assert.ok(!/\bgrant\b[^;]*\bon\s+(table\s+)?(app|public)\.\w+/i.test(c), 'no GRANT on any table');
  assert.ok(!/\bgrant\s+(select|insert|update|delete|truncate|references|all)\b/i.test(c), 'no table-level privilege is ever granted');
});

test('every application table has RLS enabled and is covered by the immutability / append-only / truncate triggers where it holds content', () => {
  const c = code(all).replace(/\s+/g, ' ');
  const tables = [...c.matchAll(/create table (app\.\w+)/g)].map((m) => m[1]);
  assert.equal(tables.length, 14);
  for (const t of tables) assert.match(c, new RegExp(`alter table ${t.replace('.', '\\.')} enable row level security;`), `${t} lacks RLS`);
  for (const t of ['hack_steps', 'hack_materials', 'hack_requirements', 'version_tags', 'version_attributions', 'source_claims', 'version_assets']) {
    assert.match(c, new RegExp(`create trigger ${t}_guard before insert or update or delete on app\\.${t} for each row execute function app_content\\.guard_child\\(\\);`), `${t} lacks the child guard`);
    assert.match(c, new RegExp(`create trigger ${t}_no_truncate before truncate on app\\.${t}`), `${t} lacks the truncate guard`);
  }
  assert.match(c, /create trigger hack_versions_guard before insert or update or delete on app\.hack_versions for each row execute function app_content\.guard_version\(\);/);
  assert.match(c, /create trigger submissions_append_only before update or delete on app\.submissions/);
});

test('lock order and the freeze: child guards lock parents FOR SHARE in ascending id order; the freeze locks FOR UPDATE and hashes after the lock', () => {
  const guard = code(sql['20261014090200_f2b_immutability.sql']).match(/create function app_content\.guard_child\(\)[\s\S]*?\n\$\$;/)![0];
  assert.match(guard, /order by v\.id for share/);
  assert.match(guard, /v\.id = any \(v_ids\)/);
  const freeze = code(sql['20261014090300_f2b_content_rpc.sql']).match(/create function app_content\.freeze_version[\s\S]*?\n\$\$;/)![0];
  const iLock = freeze.indexOf('for update'), iHash = freeze.indexOf('app_content.version_hash(p_version_id)'), iCmp = freeze.indexOf('p_expected is distinct from v_hash'), iSet = freeze.indexOf('update app.hack_versions set frozen_at');
  assert.ok(iLock > 0 && iLock < iHash && iHash < iCmp && iCmp < iSet, 'lock, then hash, then compare, then freeze');
  const save = code(sql['20261014090300_f2b_content_rpc.sql']).match(/create function api\.save_draft[\s\S]*?\n\$\$;/)![0];
  assert.ok(save.indexOf('app_guard.require_member()') < save.indexOf('created_by into v_owner') && save.indexOf('created_by into v_owner') < save.indexOf('for update') && save.indexOf('for update') < save.indexOf('app_content.write_doc'), 'guard, ownership, lock, then write');
  const trig = code(sql['20261014090200_f2b_immutability.sql']).match(/create function app_content\.guard_version\(\)[\s\S]*?\n\$\$;/)![0];
  assert.match(trig, /new\.content_hash is distinct from app_content\.version_hash\(new\.id\)/, 'the trigger re-verifies the hash on freeze');
});

test('no contributor-editable content column is privileged: classification and approval fields do not exist in the content tables', () => {
  const c = code(sql['20261014090000_f2b_content_tables.sql']);
  for (const forbidden of ['risk', 'rights', 'approved', 'approval', 'decision', 'reviewer', 'clearance', 'assessment']) assert.ok(!new RegExp(`\\b${forbidden}\\w*\\s+(text|boolean|uuid|integer|smallint|timestamptz)`, 'i').test(c), `a ${forbidden} column exists in the content tables`);
});

test('the schemas that PostgREST exposes are exactly public, graphql_public and api; the application schemas are not exposed', () => {
  const toml = readFileSync(join(root, 'supabase/config.toml'), 'utf8');
  assert.match(toml, /^schemas = \["public", "graphql_public", "api"\]$/m);
  assert.ok(!/^schemas = .*\b(app|app_guard|worker|app_bridge)\b/m.test(toml));
});

test('the rollback scripts remove every schema, table, role and trigger the migrations create, and un-ledger exactly their versions', () => {
  const read = (f: string) => code(readFileSync(join(root, 'supabase/rollbacks', f), 'utf8'));
  const downA = read('20261013130000_f2a_down.sql');
  const downB = read('20261014090000_f2b_down.sql');
  const createdSchemas = [...all.matchAll(/create schema (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(createdSchemas, ['api', 'app', 'app_bridge', 'app_content', 'app_guard', 'worker']);
  for (const s of ['api', 'worker', 'app_guard', 'app', 'app_bridge']) assert.match(downA, new RegExp(`drop schema if exists ${s} cascade;`), `F2-A rollback must drop schema ${s}`);
  assert.match(downB, /drop schema if exists app_content cascade;/);
  for (const r of ['hackass_worker', 'hackass_owner']) assert.match(downA, new RegExp(`drop role if exists ${r};`));
  for (const t of [...all.matchAll(/create trigger (hackass_\w+)/g)].map((m) => m[1])) assert.match(downA, new RegExp(`drop trigger if exists ${t} on auth\\.users;`));
  // F2-B drops its tables (before the schema whose function their CHECKs call) and its api functions
  const f2bTables = [...code(sql['20261014090000_f2b_content_tables.sql']).matchAll(/create table (app\.\w+)/g)].map((m) => m[1]);
  assert.equal(f2bTables.length, 12);
  for (const t of f2bTables) assert.ok(downB.includes(t), `F2-B rollback must drop ${t}`);
  assert.ok(downB.indexOf('drop table') < downB.indexOf('drop schema if exists app_content'), 'tables before the schema');
  const f2bApi = [...code(sql['20261014090300_f2b_content_rpc.sql']).matchAll(/create function (api\.\w+)\(/g)].map((m) => m[1]);
  assert.equal(f2bApi.length, 6);
  for (const f of f2bApi) assert.ok(downB.includes(f), `F2-B rollback must drop ${f}`);
  const versions = (prefix: string) => files.filter((f) => f.includes(prefix)).map((f) => f.slice(0, 14));
  assert.match(downA, new RegExp(`version in \\(${versions('_f2a_').map((v) => `'${v}'`).join(', ')}\\)`));
  assert.match(downB, new RegExp(`version in \\(${versions('_f2b_').map((v) => `'${v}'`).join(', ')}\\)`));
  for (const d of [downA, downB]) { assert.match(d, /^\s*begin;/m); assert.match(d, /^\s*commit;/m); assert.ok(!/drop schema (if exists )?(auth|public|storage|extensions)\b/i.test(d)); }
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

test('F2-B correction round: identifier format, list caps and the quota/category guards are defined consistently in SQL, TypeScript and the docs', () => {
  const rpc = code(sql['20261014090300_f2b_content_rpc.sql']);
  const canon = code(sql['20261014090100_f2b_canonical_hash.sql']);
  const imm = code(sql['20261014090200_f2b_immutability.sql']);
  const ts = readFileSync(join(root, 'src/modules/submissions/hashcanon.ts'), 'utf8');
  // identical identifier patterns in SQL and TypeScript
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  assert.ok(canon.includes(`'^${uuid}$'`) && ts.includes(`/^${uuid}$/`), 'UUID pattern differs between SQL and TypeScript');
  assert.ok(canon.includes("'^[0-9a-f]{64}$'") && ts.includes('/^[0-9a-f]{64}$/'), 'digest pattern differs between SQL and TypeScript');
  assert.match(canon, /app_content\.j_uuid\(r\.item, 'profile_id'\)/);
  assert.match(canon, /app_content\.j_hex64\(a\.item, 'sha256'\)/);
  assert.match(rpc, /app_content\.j_uuid\(r\.item, 'profile_id'\)::uuid/);
  assert.match(rpc, /app_content\.j_uuid\(r\.item, 'asset_id'\)::uuid/);
  // caps: assert_limits == child guard backstop == table checks == documentation
  const caps = Object.fromEntries([...rpc.matchAll(/\('(\w+)', (\d+)\)/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(caps, { steps: 50, materials: 50, requirements: 30, tags: 10, attributions: 10, source_claims: 10, assets: 20 });
  assert.match(imm, /when 'hack_requirements' then 30 when 'version_tags' then 10 when 'version_assets' then 20/);
  const tables = code(sql['20261014090000_f2b_content_tables.sql']);
  assert.match(tables, /hack_steps[\s\S]*?position between 1 and 50/);
  assert.match(tables, /attribution_no between 1 and 10/);
  assert.match(tables, /claim_no between 1 and 10/);
  assert.match(rpc, /octet_length\(p::text\) > 131072/);
  const doc = readFileSync(join(root, 'docs/db/f2b-content.md'), 'utf8');
  for (const [list, n] of Object.entries(caps)) assert.match(doc, new RegExp(`\\| ${list} \\| ${n} \\|`), `docs state the ${list} cap`);
  assert.match(doc, /131072 bytes/);
  assert.ok(!/30-ish/.test(doc));
  // the limits run before anything is replaced
  const wd = rpc.match(/create function app_content\.write_doc[\s\S]*?\n\$\$;/)![0];
  assert.ok(wd.indexOf('assert_limits') > 0 && wd.indexOf('assert_limits') < wd.indexOf('update app.hack_versions') && wd.indexOf('assert_limits') < wd.indexOf('delete from app.hack_steps'));
  // quota: account row locked first, in both create and delete, before the version row
  const cd = rpc.match(/create function api\.create_draft[\s\S]*?\n\$\$;/)![0];
  assert.ok(cd.indexOf('for no key update') > 0 && cd.indexOf('for no key update') < cd.indexOf('pg_catalog.count(*)'), 'create_draft locks the account before counting');
  const dd = rpc.match(/create function api\.delete_draft[\s\S]*?\n\$\$;/)![0];
  assert.ok(dd.indexOf('for no key update') > 0 && dd.indexOf('for no key update') < dd.indexOf('for update;'), 'delete_draft locks the account before the version row');
  // category guard
  assert.match(imm, /create trigger categories_guard before update on app\.categories/);
  assert.match(imm, /new\.slug is distinct from old\.slug/);
});
