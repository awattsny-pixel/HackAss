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

test('F2-A, F2-B, F2-C1, F2-C2 and F2-D1 migrations: sixteen timestamped, ordered files, no stray files', () => {
  assert.deepEqual(files.map((f) => f.replace(/^\d{14}_/, '')), ['f2a_roles_and_schemas.sql', 'f2a_identity_and_staff.sql', 'f2a_authorization_guards.sql', 'f2b_content_tables.sql', 'f2b_canonical_hash.sql', 'f2b_immutability.sql', 'f2b_content_rpc.sql', 'f2c1_review_tables.sql', 'f2c1_review_rules.sql', 'f2c1_review_rpc.sql', 'f2c2_publication_tables.sql', 'f2c2_publication_rules.sql', 'f2c2_publication_rpc.sql', 'f2d1_jobs_tables.sql', 'f2d1_jobs_rules.sql', 'f2d1_worker_rpc.sql']);
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
    'api.list_submissions_for_review(integer, text[], timestamptz, uuid), api.get_submission_for_review(uuid), api.start_review(uuid, text), api.record_risk_assessment(uuid, text, text, text), api.record_rights_review(uuid, text, integer, text, text, text, date), api.record_decision(uuid, text, text, text[], text, uuid) to authenticated;',
    'api.publish_version(uuid, text, uuid, text), api.withdraw_publication(uuid, text, text), api.get_publication(uuid) to authenticated;',
    'api.whoami(), api.staff_probe(text, integer) to authenticated;',
    'app_bridge.session_valid(uuid, uuid) to hackass_owner;',
    'app_guard.on_auth_user_created(), app_guard.on_auth_user_deleted() to postgres;',
    'app_guard.on_auth_user_created(), app_guard.on_auth_user_deleted() to supabase_auth_admin;',
    'worker.healthcheck() to hackass_worker;',
    'worker.claim_job(text), worker.heartbeat_job(uuid, bigint), worker.get_job_subject(uuid, bigint), worker.complete_job(uuid, bigint), worker.fail_job(uuid, bigint, text) to hackass_worker;',
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
  const created = [...c.matchAll(/create function ((?:api|app_guard|app_content|app_bridge|app_review|worker)\.\w+)\(/g)].map((m) => m[1]);
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
  assert.equal(tables.length, 21);
  for (const t of tables) assert.match(c, new RegExp(`alter table ${t.replace('.', '\\.')} enable row level security;`), `${t} lacks RLS`);
  for (const t of ['hack_steps', 'hack_materials', 'hack_requirements', 'version_tags', 'version_attributions', 'source_claims', 'version_assets']) {
    assert.match(c, new RegExp(`create trigger ${t}_guard before insert or update or delete on app\\.${t} for each row execute function app_content\\.guard_child\\(\\);`), `${t} lacks the child guard`);
    assert.match(c, new RegExp(`create trigger ${t}_no_truncate before truncate on app\\.${t}`), `${t} lacks the truncate guard`);
  }
  assert.match(c, /create trigger hack_versions_guard before insert or update or delete on app\.hack_versions for each row execute function app_content\.guard_version\(\);/);
  assert.match(c, /create trigger submissions_append_only before update or delete on app\.submissions/);
});

test('lock order and the freeze: child guards lock parents FOR NO KEY UPDATE (one mode, so no upgrades) in ascending id order; the freeze locks FOR UPDATE and hashes after the lock', () => {
  const guard = code(sql['20261014090200_f2b_immutability.sql']).match(/create function app_content\.guard_child\(\)[\s\S]*?\n\$\$;/)![0];
  assert.match(guard, /order by v\.id for no key update/);
  assert.ok(!/for share/.test(guard), 'one lock mode for every child operation: no shared lock that could later be upgraded');
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
  assert.deepEqual(createdSchemas, ['api', 'app', 'app_bridge', 'app_content', 'app_guard', 'app_review', 'worker']);
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
  const iAcct = dd.indexOf('from app.accounts a where a.user_id = v_actor.user_id for no key update'), iHack = dd.indexOf('from app.hacks h where h.id = v_hack'), iVer = dd.indexOf('and v.hack_id = v_locked_hack for update'), iDelV = dd.indexOf('delete from app.hack_versions'), iDelH = dd.indexOf('delete from app.hacks');
  assert.ok(iAcct > 0 && iAcct < iHack && iHack < iVer && iVer < iDelV && iDelV < iDelH, 'delete_draft: account, then hack, then version, then deletes');
  assert.match(dd, /h\.created_by = v_actor\.user_id for update;\s+if v_locked_hack is null then raise exception 'not_found'/, 'a vanished hack is not_found');
  assert.match(dd, /for update;\s+if not found or v_owner is distinct from v_actor\.user_id then raise exception 'not_found'/, 'a vanished version is not_found');
  const sd = rpc.match(/create function api\.save_draft[\s\S]*?\n\$\$;/)![0];
  assert.match(sd, /for update;[^\n]*\n[^\n]*\n\s+if not found or v_owner is distinct from v_actor\.user_id then raise exception 'not_found'/, 'save_draft re-checks existence under the lock');
  // category guard
  assert.match(imm, /create trigger categories_guard before update on app\.categories/);
  assert.match(imm, /new\.slug is distinct from old\.slug/);
});

test('F2-C1: the review functions take no caller identity, require the reviewed hash, start with the staff guard, and lock the submission first', () => {
  const rpc = code(sql['20261015090200_f2c1_review_rpc.sql']);
  const rules = code(sql['20261015090100_f2c1_review_rules.sql']);
  const fns = [...rpc.matchAll(/create function (api\.\w+)\(([\s\S]*?)\) returns jsonb\s+language plpgsql[^\n]*\nas \$\$([\s\S]*?)\n\$\$;/g)];
  assert.equal(fns.length, 6);
  for (const [, name, params, body] of fns) {
    assert.ok(!/\b(p_actor|p_reviewer|p_user|p_staff|p_account|_id_of_reviewer)\w*/i.test(params), `${name} has a caller-identity parameter`);
    assert.match(body, /^\s*(?:declare[\s\S]*?)?begin\s+v_staff := app_guard\.require_staff\('reviewer', interval '15 minutes'\);/, `${name} must start with the staff guard`);
    if (!/^api\.(list_submissions_for_review|get_submission_for_review)$/.test(name)) {
      assert.match(params, /p_expected_hash text/, `${name} must name the reviewed hash`);
      const iLock = body.indexOf('app_review.lock_submission'), iVerify = body.indexOf('app_review.verify_binding'), iOk = body.indexOf('app_review.assert_reviewer_ok');
      assert.ok(iLock > 0 && iLock < iVerify && iVerify < iOk, `${name}: lock the submission, verify the hash, check reviewer eligibility, in that order`);
    }
  }
  const dec = fns.find(([, n]) => n === 'api.record_decision')![3];
  assert.ok(dec.indexOf('decision_conflict') > dec.indexOf('lock_submission') && dec.indexOf('approval_blockers') > dec.indexOf('decision_conflict') && dec.indexOf('insert into app.moderation_decisions') > dec.indexOf('approval_blockers'), 'record_decision: lock, conflict check, blockers, then insert');
  assert.match(dec, /v_latest is distinct from p_expected_prior_decision_id/, 'the optimistic-concurrency check exists');
  // the trigger repeats the important rules for any other writer
  const g = rules.match(/create function app_review\.guard_decision\(\)[\s\S]*?\n\$\$;/)![0];
  for (const needle of ['lock_submission(new.submission_id)', 'assert_reviewer_ok(s, new.actor_id)', 'version_hash(new.version_id) is distinct from new.content_hash', 'new.seq :=', 'new.supersedes_id :=', "approval_blockers(new.submission_id, new.actor_id)"]) assert.ok(g.includes(needle), `guard_decision lacks ${needle}`);
  assert.match(rules, /rights_reviews_guard before insert on app\.rights_reviews/);
  assert.match(rules, /new\.claim_hash := app_review\.claim_hash\(new\.version_id, new\.claim_no\)/);
  // approval blockers: the full list of reasons
  const b = rules.match(/create function app_review\.approval_blockers[\s\S]*?\n\$\$;/)![0];
  for (const reason of ['self_review', 'assessment_missing', 'risk_prohibited', 'risk_high_needs_admin', 'rights_not_clear:', 'unresolved_references:', 'submission_missing']) assert.ok(b.includes(reason), `missing blocker ${reason}`);
  assert.match(b, /rr\.status = 'clear'/);
  assert.match(b, /rr\.expires_on is null or rr\.expires_on >= current_date/);
  assert.match(b, /rr\.claim_hash = app_review\.claim_hash\(s\.version_id, r\.claim_no\)/);
  const tables = code(sql['20261015090000_f2c1_review_tables.sql']);
  assert.equal([...tables.matchAll(/foreign key \(submission_id, version_id, content_hash, canon_version\)\s+references app\.submissions \(id, version_id, content_hash, canon_version\)/g)].length, 3, 'all three record tables are bound to the exact submission');
  assert.match(tables, /foreign key \(version_id, claim_no\) references app\.source_claims \(version_id, claim_no\)/, 'rights reviews name individual claims');
  assert.match(tables, /decided_by_kind text\s+not null default 'human' check \(decided_by_kind = 'human'\)/);
  assert.match(tables, /create unique index decisions_one_successor on app\.moderation_decisions \(supersedes_id\)/);
});

test('F2-C1 rollback removes everything it created, in order, and un-ledgers exactly its three versions', () => {
  const down = code(readFileSync(join(root, 'supabase/rollbacks/20261015090000_f2c1_down.sql'), 'utf8'));
  for (const t of ['app.moderation_decisions', 'app.rights_reviews', 'app.version_assessments']) assert.ok(down.includes(t), t);
  const fns = [...code(sql['20261015090200_f2c1_review_rpc.sql']).matchAll(/create function (api\.\w+)\(/g)].map((m) => m[1]);
  assert.equal(fns.length, 6);
  for (const f of fns) assert.ok(down.includes(f), f);
  assert.ok(down.indexOf('drop table') < down.indexOf('drop constraint') && down.indexOf('drop constraint') < down.indexOf('drop schema if exists app_review cascade'));
  assert.match(down, /version in \('20261015090000', '20261015090100', '20261015090200'\)/);
});

test('F2-C2: one lock protocol (submission row, then hack row, then lifecycle rows in ascending id order) is followed by publish, withdraw and every review write', () => {
  const rules = code(sql['20261016090100_f2c2_publication_rules.sql']);
  const rpc = code(sql['20261016090200_f2c2_publication_rpc.sql']);
  // step 1 and 2 live in lock_submission, which every review write already calls first
  const lock = rules.match(/create or replace function app_review\.lock_submission[\s\S]*?\n\$\$;/)![0];
  assert.ok(lock.indexOf('from app.submissions where id = p_submission_id for update') > 0 && lock.indexOf('from app.hacks h where h.id = s.hack_id for no key update') > lock.indexOf('for update;'), 'submission FOR UPDATE, then hack FOR NO KEY UPDATE');
  const pub = rpc.match(/create function api\.publish_version[\s\S]*?\n\$\$;/)![0];
  const wd = rpc.match(/create function api\.withdraw_publication[\s\S]*?\n\$\$;/)![0];
  assert.match(pub, /^[\s\S]*?begin\s+v_staff := app_guard\.require_staff\('reviewer', interval '15 minutes'\);/, 'publish starts with the staff guard');
  assert.match(wd, /^[\s\S]*?begin\s+v_staff := app_guard\.require_staff\('reviewer', interval '15 minutes'\);/, 'withdraw starts with the staff guard');
  const iLock = pub.indexOf('app_review.lock_submission'), iVerify = pub.indexOf('app_review.verify_binding'), iOk = pub.indexOf('app_review.assert_reviewer_ok'), iLife = pub.indexOf('from app.version_lifecycle l where l.version_id in (s.version_id, v_old.version_id) order by l.version_id for update');
  assert.ok(iLock > 0 && iLock < iVerify && iVerify < iOk && iOk < iLife, 'publish: lock submission+hack, verify the hash, check the publisher, then the lifecycle rows in ascending order');
  assert.ok(pub.indexOf('publication_blockers') > iLife && pub.indexOf('withdraw_locked') > pub.indexOf('publication_blockers') && pub.indexOf('insert into app.publications') > pub.indexOf('withdraw_locked') && pub.indexOf('update app.hacks set') > pub.indexOf('insert into app.publication_rights'), 'publish: checks, then supersede, then the insert, then the pointer');
  assert.match(pub, /decision_conflict/);
  assert.ok(wd.indexOf('app_review.lock_submission') > 0 && wd.indexOf('app_review.lock_submission') < wd.indexOf('not_current') && wd.indexOf('not_current') < wd.indexOf('from app.version_lifecycle l where l.version_id = p.version_id for update') && wd.indexOf('for update') < wd.indexOf('withdraw_locked'), 'withdraw: lock submission+hack, re-check currency under the lock, then the lifecycle row, then the withdrawal');
  for (const body of [pub, wd]) assert.ok(!/\b(p_actor|p_reviewer|p_user|p_staff|p_account)\w*/i.test(body), 'no caller identity parameter');
  // withdrawal order: record first, pointer second, lifecycle last (the triggers depend on it)
  const w = rules.match(/create function app_review\.withdraw_locked[\s\S]*?\n\$\$;/)![0];
  assert.ok(w.indexOf('insert into app.publication_withdrawals') < w.indexOf('update app.hacks set current_publication_id = null') && w.indexOf('update app.hacks') < w.indexOf('update app.version_lifecycle'));
  // review writes that can make a publication ineligible withdraw it in the same transaction
  for (const t of ['decisions_after_write after insert on app.moderation_decisions', 'assessments_after_write after insert on app.version_assessments', 'rights_reviews_after_write after insert on app.rights_reviews']) assert.ok(rules.includes(`create trigger ${t} for each row execute function app_review.after_review_write();`), t);
  // the insert guard repeats the rules for any other writer, and the pointer guard allows only the two lawful moves
  const g = rules.match(/create function app_review\.guard_publication\(\)[\s\S]*?\n\$\$;/)![0];
  for (const needle of ['lock_submission(new.submission_id)', 'assert_reviewer_ok(s, new.published_by)', "is distinct from 'approved'", 'decision_conflict', 'assessment_stale', 'publication_blockers(s.id, new.published_by)', 'publisher_role', 'snapshot_mismatch']) assert.ok(g.includes(needle), `guard_publication: ${needle}`);
  const hk = rules.match(/create function app_review\.guard_hack\(\)[\s\S]*?\n\$\$;/)![0];
  for (const needle of ['identity_immutable', 'slug_immutable', 'pointer_must_be_cleared', 'publication_withdrawn', 'withdrawal_required']) assert.ok(hk.includes(needle), `guard_hack: ${needle}`);
  assert.match(rules, /create constraint trigger publications_children_check after insert on app\.publications deferrable initially deferred/);
  assert.match(rules, /create constraint trigger withdrawals_cleared_check after insert on app\.publication_withdrawals deferrable initially deferred/);
  // keys
  const tables = code(sql['20261016090000_f2c2_publication_tables.sql']);
  assert.match(tables, /foreign key \(version_id, hack_id\) references app\.hack_versions \(id, hack_id\)/, 'a publication\'s version belongs to its hack');
  assert.match(tables, /foreign key \(current_publication_id, id\) references app\.publications \(id, hack_id\)/, 'the pointer targets a publication of the same hack');
  assert.match(tables, /foreign key \(submission_id, version_id, content_hash, canon_version\)\s+references app\.submissions \(id, version_id, content_hash, canon_version\)/);
  assert.match(tables, /constraint publications_one_per_decision unique \(decision_id\)/);
  assert.match(tables, /snapshot_format = 'HACKASS-PUB-1'/);
  // nothing for members: no public projection, no grants
  assert.ok(!/\bgrant\b[^;]*\bto\s+(anon|public|service_role)\b/i.test(rules + rpc + tables));
});

test('F2-C2 rollback removes everything it created, in order, restores the F2-C1 lock_submission, and un-ledgers exactly its three versions', () => {
  const down = code(readFileSync(join(root, 'supabase/rollbacks/20261016090000_f2c2_down.sql'), 'utf8'));
  for (const t of ['app.publications', 'app.publication_rights', 'app.publication_withdrawals', 'current_publication_id', 'decisions_id_submission', 'assessments_id_submission', 'rights_review_binding']) assert.ok(down.includes(t), t);
  const fns = [...code(sql['20261016090200_f2c2_publication_rpc.sql']).matchAll(/create function (api\.\w+)\(/g)].map((m) => m[1]);
  assert.equal(fns.length, 3);
  for (const f of fns) assert.ok(down.includes(f), f);
  for (const f of [...code(sql['20261016090100_f2c2_publication_rules.sql']).matchAll(/create function (app_review\.\w+)\(/g)].map((m) => m[1])) assert.ok(down.includes(f), f);
  assert.ok(down.indexOf('drop function if exists app_review.withdraw_locked') < down.indexOf('drop table if exists app.publication_withdrawals'), 'the function over the row type goes before the table');
  assert.ok(down.indexOf('drop trigger if exists decisions_after_write') < down.indexOf('drop function if exists app_review.after_review_write'));
  assert.ok(down.indexOf('drop table') < down.indexOf('drop constraint if exists decisions_id_submission'));
  const orig = code(sql['20261015090100_f2c1_review_rules.sql']).match(/create function app_review\.lock_submission[\s\S]*?\n\$\$;/)![0].replace('create function', 'create or replace function');
  assert.ok(down.replace(/\s+/g, ' ').includes(orig.replace(/\s+/g, ' ')), 'the restored lock_submission is exactly the F2-C1 definition');
  assert.match(down, /version in \('20261016090000', '20261016090100', '20261016090200'\)/);
});

test('F2-D1: worker functions check the worker login first, take only a job id and an epoch, and grant nothing else; the job row is locked last', () => {
  const rpc = code(sql['20261017090200_f2d1_worker_rpc.sql']);
  const rules = code(sql['20261017090100_f2d1_jobs_rules.sql']);
  const tables = code(sql['20261017090000_f2d1_jobs_tables.sql']);
  const fns = [...rpc.matchAll(/create function (worker\.\w+)\(([^)]*)\) returns jsonb\s+language plpgsql[^\n]*\nas \$\$([\s\S]*?)\n\$\$;/g)];
  assert.equal(fns.length, 5);
  for (const [, name, params, body] of fns) {
    assert.match(body, /^\s*begin\s+if session_user <> 'hackass_worker' then raise exception 'not_worker' using errcode = '42501'; end if;\s+return app_review\.job_\w+\(/, `${name}: the worker-login check comes first, then the owner-only logic`);
    assert.ok(!/\b(target|publication|hack|version|submission|lease_secs|interval|note|text_)\w*/i.test(params.replace(/p_job_type text|p_error_code text/g, '')), `${name} takes a target or free text: ${params}`);
  }
  assert.match(rpc, /grant execute on function worker\.claim_job\(text\), worker\.heartbeat_job\(uuid, bigint\), worker\.get_job_subject\(uuid, bigint\), worker\.complete_job\(uuid, bigint\), worker\.fail_job\(uuid, bigint, text\) to hackass_worker;/);
  assert.ok(!/\bgrant\b[^;]*\bon\s+(table|all tables|schema)\b/i.test(rpc + rules + tables), 'no table or schema grant');
  assert.ok(!/\bgrant\b[^;]*\bto\s+(anon|public|authenticated|service_role)\b/i.test(rpc + rules + tables));
  // complete: unlocked read of the job, then submission+hack, lifecycle, THEN the job row, then the lease check, then the effect
  const c = rules.match(/create function app_review\.job_complete[\s\S]*?\n\$\$;/)![0];
  const i = ['from app.jobs where id = p_job_id;', 'app_review.lock_submission(p.submission_id)', 'from app.version_lifecycle l where l.version_id = p.version_id for update', 'from app.jobs where id = p_job_id for update', 'app_review.job_assert_lease(j, p_epoch)', 'job_effect_publication_recheck(j)', "update app.jobs set status = 'succeeded'"].map((n) => c.indexOf(n));
  assert.ok(i.every((x) => x > 0) && i.every((x, k) => k === 0 || x > i[k - 1]), `job_complete lock order: ${i}`);
  // claim: skip locked, expiry counts as an attempt, epoch +1
  const cl = rules.match(/create function app_review\.job_claim[\s\S]*?\n\$\$;/)![0];
  assert.match(cl, /for update skip locked/);
  assert.match(cl, /lease_epoch = lease_epoch \+ 1/);
  assert.match(cl, /interval '5 minutes'/);
  // the effect only ends a publication; it never sets a pointer
  const eff = rules.match(/create function app_review\.job_effect_publication_recheck[\s\S]*?\n\$\$;/)![0];
  assert.ok(!/update\s+app\.hacks/.test(eff) && eff.includes("withdraw_locked(p, 'recheck'"), 'the recheck can only withdraw');
  assert.match(tables, /constraint withdrawals_actor_unless_recheck check \(\(cause = 'recheck'\) = \(withdrawn_by is null\)\)/);
  assert.match(tables, /create unique index jobs_one_active on app\.jobs \(job_type, target_publication_id\) where status in \('queued', 'leased'\)/);
  // the evidence-note-hash backstop
  assert.match(rules, /pr\.evidence_note_hash is distinct from app_content\.hash_text\(rr\.evidence_note\)/);
});

test('F2-D1 rollback drops the functions over the row type before the table, restores the F2-C2 definitions, and un-ledgers exactly its three versions', () => {
  const down = code(readFileSync(join(root, 'supabase/rollbacks/20261017090000_f2d1_down.sql'), 'utf8'));
  for (const f of [...code(sql['20261017090200_f2d1_worker_rpc.sql']).matchAll(/create function (worker\.\w+)\(/g)].map((m) => m[1])) assert.ok(down.includes(f), f);
  for (const f of [...code(sql['20261017090100_f2d1_jobs_rules.sql']).matchAll(/create function (app_review\.job_\w+|app_review\.guard_job)\(/g)].map((m) => m[1])) assert.ok(down.includes(f), f);
  assert.ok(down.indexOf('job_effect_publication_recheck(app.jobs)') < down.indexOf('drop table if exists app.jobs') && down.indexOf('drop trigger if exists publications_schedule_recheck') < down.indexOf('drop table if exists app.jobs'));
  assert.ok(down.indexOf('drop table if exists app.jobs') < down.indexOf('drop function if exists app_review.guard_job()'));
  const c2 = code(sql['20261016090100_f2c2_publication_rules.sql']);
  for (const name of ['after_review_write', 'check_publication_children']) {
    const orig = c2.match(new RegExp(`create function app_review\\.${name}\\(\\)[\\s\\S]*?\\n\\$\\$;`))![0].replace('create function', 'create or replace function');
    assert.ok(down.replace(/\s+/g, ' ').includes(orig.replace(/\s+/g, ' ')), `${name}: the restored definition is exactly the F2-C2 one`);
  }
  assert.match(down, /version in \('20261017090000', '20261017090100', '20261017090200'\)/);
});
