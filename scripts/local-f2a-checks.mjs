#!/usr/bin/env node
// F2-A authority checks against the REAL local Supabase stack: direct calls to the exposed functions with real user JWTs
// through PostgREST, the restricted worker login over a real password-authenticated connection, the role/grant inventory,
// and a rehearsal of the rollback script.
//
// Run through `npm run db:test:auth` (starts the disposable stack, runs pgTAP and the checks, always stops it). Directly,
// with the stack up:  node --conditions=react-server scripts/local-f2a-checks.mjs
// Prints facts and PASS/FAIL only: never keys, tokens or passwords. Exit 0 all passed, 1 a check failed, 2 stack unreachable.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_CONTAINER, DOCKER, NETWORK, SECRET, admin, confirmedSession, createRunner, decode, elevateToAal2, ok, psql, rpc, signatureValid, wait, API, PUB } from './lib/local-stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, failed } = createRunner();
const ops = (sqlText) => psql(`set role hackass_owner;\n${sqlText}`).out;                 // operations performed as the database owner role
const api = (name, token, args) => rpc('api', name, token, args);
const code = (r) => r.body?.code;
const msg = (r) => r.body?.message;
const expectDenied = (r, status, c, m, what) => ok(r.status === status && code(r) === c && msg(r) === m, `${what}: got HTTP ${r.status} ${code(r)} ${msg(r)}, expected ${status} ${c} ${m}`);

// ---- inventory (facts, not assertions) -------------------------------------------------------------------------------------
console.log('== role / grant inventory (from the live catalog) ==');
console.log(psql(`
select 'role   ' || rolname || ' login=' || rolcanlogin || ' super=' || rolsuper || ' createrole=' || rolcreaterole || ' createdb=' || rolcreatedb || ' replication=' || rolreplication || ' bypassrls=' || rolbypassrls || ' inherit=' || rolinherit || ' connlimit=' || rolconnlimit
  from pg_roles where rolname in ('hackass_owner', 'hackass_worker') order by rolname;
select 'schema ' || nspname || ' owner=' || pg_get_userbyid(nspowner) || ' acl=' || coalesce(nspacl::text, 'default') from pg_namespace where nspname in ('app', 'app_guard', 'api', 'worker', 'app_bridge') order by nspname;
select 'table  ' || n.nspname || '.' || c.relname || ' owner=' || pg_get_userbyid(c.relowner) || ' acl=' || coalesce(c.relacl::text, 'none') || ' rls=' || c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r' order by 1;
select 'func   ' || p.oid::regprocedure || ' owner=' || pg_get_userbyid(p.proowner) || ' definer=' || p.prosecdef || ' acl=' || coalesce(p.proacl::text, 'default') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app_guard', 'api', 'worker', 'app_bridge') order by 1;
select 'member ' || pg_get_userbyid(roleid) || ' <- ' || pg_get_userbyid(member) || ' inherit=' || inherit_option || ' set=' || set_option from pg_auth_members where roleid = 'hackass_owner'::regrole or member in ('hackass_owner'::regrole, 'hackass_worker'::regrole) order by 1;
select 'owner-on-auth  schema_usage=' || has_schema_privilege('hackass_owner', 'auth', 'usage') || ' sessions_select=' || has_any_column_privilege('hackass_owner', 'auth.sessions', 'select') || ' users_select=' || has_any_column_privilege('hackass_owner', 'auth.users', 'select');
`).out);
console.log('');

// ---- direct user-JWT RPC through PostgREST ---------------------------------------------------------------------------------
await check('F1', 'a live user session passes api.whoami through PostgREST with a real JWT', async () => {
  const { session, userId } = await confirmedSession();
  const r = await api('whoami', session.access_token);
  ok(r.status === 200 && r.body.user_id === userId && r.body.session_id === decode(session.access_token).claims.session_id, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  const row = psql(`select status from app.accounts where user_id = '${userId}'`).out;
  ok(row === 'active', `the trigger should have created an active account, found ${JSON.stringify(row)}`);
  return `HTTP 200, account created by the Auth trigger (status=${row})`;
});

await check('F2', 'no user token: the anon key (anon role) and the service key cannot execute the function', async () => {
  const anonRes = await api('whoami', PUB);
  ok(anonRes.status === 401 || anonRes.status === 403, `anon got HTTP ${anonRes.status}`);
  ok(code(anonRes) === '42501', `anon code ${code(anonRes)}`);
  const noAuth = await fetch(`${API}/rest/v1/rpc/whoami`, { method: 'POST', headers: { apikey: PUB, 'content-type': 'application/json', 'content-profile': 'api' }, body: '{}' });
  ok(noAuth.status === 401 || noAuth.status === 403, `no Authorization header got HTTP ${noAuth.status}`);
  const svc = await api('whoami', SECRET);
  ok(svc.status === 401 || svc.status === 403, `the service key got HTTP ${svc.status}`);
  ok(code(svc) === '42501', `service key code ${code(svc)}`);
  return `anon key: HTTP ${anonRes.status} ${code(anonRes)}; service key: HTTP ${svc.status} ${code(svc)}; no header: HTTP ${noAuth.status}`;
});

await check('F3', 'a signed-out session whose access token is still unexpired and correctly signed is refused inside the database', async () => {
  const { c, session } = await confirmedSession();
  const token = session.access_token;
  ok((await api('whoami', token)).status === 200, 'baseline call should pass');
  await c.auth.signOut();
  ok(await signatureValid(token) && decode(token).claims.exp * 1000 > Date.now(), 'the token must still look valid (signature and exp)');
  const r = await api('whoami', token);
  expectDenied(r, 403, '28000', 'session_invalid', 'signed-out token');
  return `token signature valid and unexpired; database answered HTTP ${r.status} ${msg(r)}`;
});

await check('F4', 'a session row that no longer exists is refused (missing session)', async () => {
  const { session } = await confirmedSession();
  const sid = decode(session.access_token).claims.session_id;
  psql(`delete from auth.sessions where id = '${sid}'`);
  expectDenied(await api('whoami', session.access_token), 403, '28000', 'session_invalid', 'missing session');
  return 'HTTP 403 session_invalid';
});

await check('F5', 'a disabled account is refused although its session and token are valid; reactivating restores access at once', async () => {
  const { session, userId } = await confirmedSession();
  ok((await api('whoami', session.access_token)).status === 200, 'baseline');
  ops(`update app.accounts set status = 'disabled' where user_id = '${userId}';`);
  expectDenied(await api('whoami', session.access_token), 403, '42501', 'account_inactive', 'disabled account');
  ops(`update app.accounts set status = 'active' where user_id = '${userId}';`);
  ok((await api('whoami', session.access_token)).status === 200, 'reactivated account should pass');
  return 'disabled -> 403 account_inactive; active -> 200';
});

await check('F6', 'a banned user and a deleted user are refused (ban via the Auth admin API; deletion also marks the account and revokes staff)', async () => {
  const banned = await confirmedSession();
  const { error: be } = await admin.auth.admin.updateUserById(banned.userId, { ban_duration: '1h' });
  ok(!be, `ban: ${be?.message}`);
  const rb = await api('whoami', banned.session.access_token);
  ok(rb.status === 403 && code(rb) === '28000', `banned user got HTTP ${rb.status} ${code(rb)} ${msg(rb)}`);
  const gone = await confirmedSession();
  ops(`insert into app.staff_assignments (user_id, role, granted_by) values ('${gone.userId}', 'reviewer', 'check');`);
  const { error: de } = await admin.auth.admin.deleteUser(gone.userId);
  ok(!de, `delete: ${de?.message}`);
  const rd = await api('whoami', gone.session.access_token);
  ok(rd.status === 403 && code(rd) === '28000', `deleted user got HTTP ${rd.status} ${code(rd)}`);
  const state = psql(`select status || ':' || (select count(*) from app.staff_assignments s where s.user_id = a.user_id and s.revoked_at is null) from app.accounts a where user_id = '${gone.userId}'`).out;
  ok(state === 'deleted:0', `account/staff state after deletion was ${state}`);
  return `banned -> ${msg(rb)}; deleted -> ${msg(rd)}; account=${state}`;
});

await check('F7', 'staff authority: not staff, aal1, aal2 and removal of the assignment are each enforced on the same JWT calls', async () => {
  const { c, session, userId } = await confirmedSession();
  expectDenied(await api('staff_probe', session.access_token), 403, '42501', 'not_staff', 'member with no assignment');
  ops(`insert into app.staff_assignments (user_id, role, granted_by) values ('${userId}', 'reviewer', 'check');`);
  expectDenied(await api('staff_probe', session.access_token), 403, '42501', 'mfa_required', 'reviewer at aal1 (insufficient MFA)');
  const t2 = await elevateToAal2(c);
  const good = await api('staff_probe', t2);
  ok(good.status === 200 && good.body.roles.length === 1 && good.body.roles[0] === 'reviewer', `reviewer at aal2: HTTP ${good.status} ${JSON.stringify(good.body)}`);
  expectDenied(await api('staff_probe', t2, { p_min_role: 'admin' }), 403, '42501', 'not_staff', 'reviewer asking for the admin tier');
  ops(`update app.staff_assignments set revoked_at = now(), revoked_by = 'check' where user_id = '${userId}' and revoked_at is null;`);
  expectDenied(await api('staff_probe', t2), 403, '42501', 'not_staff', 'same aal2 token after the assignment was removed');
  ops(`insert into app.staff_assignments (user_id, role, granted_by) values ('${userId}', 'admin', 'check');`);
  const adm = await api('staff_probe', t2, { p_min_role: 'admin' });
  ok(adm.status === 200 && adm.body.roles[0] === 'admin', `admin tier after grant: HTTP ${adm.status}`);
  return 'not_staff -> mfa_required (aal1) -> allowed (aal2) -> not_staff (removed) -> allowed as admin; no new token was needed';
});

await check('F8', 'stale MFA with a real aal2 token: the caller can shorten the window but never lengthen it', async () => {
  const { c, userId } = await confirmedSession();
  ops(`insert into app.staff_assignments (user_id, role, granted_by) values ('${userId}', 'reviewer', 'check');`);
  const t2 = await elevateToAal2(c);
  ok((await api('staff_probe', t2)).status === 200, 'fresh MFA should pass');
  await wait(3500);
  expectDenied(await api('staff_probe', t2, { p_max_mfa_age_seconds: 2 }), 403, '42501', 'mfa_stale', '3.5 s old MFA against a 2 s window');
  ok((await api('staff_probe', t2, { p_max_mfa_age_seconds: 100000 })).status === 200, 'a lengthened window is clamped to 15 minutes, and 3.5 s is inside that');
  return 'fresh -> ok; 3.5 s old vs 2 s window -> mfa_stale (the 20-minute and future cases are in 020_authorization.test.sql)';
});

await check('F10', 'guard arguments fail closed through PostgREST: NULL or unknown role names are rejected; a NULL window means the 15-minute default, never unlimited', async () => {
  const { c, userId } = await confirmedSession();
  ops(`insert into app.staff_assignments (user_id, role, granted_by) values ('${userId}', 'reviewer', 'check');`);
  const t2 = await elevateToAal2(c);
  ok((await api('staff_probe', t2)).status === 200, 'baseline');
  for (const [args, what] of [[{ p_min_role: null }, 'NULL role'], [{ p_min_role: 'owner' }, 'unknown role'], [{ p_min_role: null, p_max_mfa_age_seconds: null }, 'NULL role and window']]) {
    const r = await api('staff_probe', t2, args);
    ok(r.status === 400 && code(r) === '22023' && msg(r) === 'invalid_argument', `${what}: HTTP ${r.status} ${code(r)} ${msg(r)}`);
  }
  const nullWindow = await api('staff_probe', t2, { p_max_mfa_age_seconds: null });
  ok(nullWindow.status === 200, `NULL window: HTTP ${nullWindow.status}`);
  return 'NULL/unknown role -> HTTP 400 22023 invalid_argument; NULL window -> default 15-minute window';
});

await check('F9', 'nothing behind the functions is reachable through the REST API: the app schema is not exposed, even to the service key', async () => {
  const { session } = await confirmedSession();
  const get = async (key, token, profile) => fetch(`${API}/rest/v1/accounts?select=*`, { headers: { apikey: key, authorization: `Bearer ${token}`, 'accept-profile': profile } });
  for (const profile of ['app', 'app_guard', 'worker']) {
    const r = await get(PUB, session.access_token, profile);
    ok(r.status >= 400, `schema ${profile} answered HTTP ${r.status} for a user token`);
  }
  const g = await fetch(`${API}/rest/v1/rpc/require_member`, { method: 'POST', headers: { apikey: PUB, authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json', 'content-profile': 'app_guard' }, body: '{}' });
  ok(g.status >= 400, `app_guard.require_member answered HTTP ${g.status}`);
  return 'user token cannot read app/app_guard/worker through REST or call a guard directly (HTTP 4xx)';
});

// ---- the restricted worker login ---------------------------------------------------------------------------------------------
const workerPw = randomBytes(18).toString('base64url');
psql(`alter role hackass_worker password '${workerPw}'`); // set out of band, on the disposable database only
const image = spawnSync(DOCKER, ['inspect', DB_CONTAINER, '--format', '{{.Config.Image}}'], { encoding: 'utf8' }).stdout.trim();
// A sibling container on the stack's network: connections from there use the scram-sha-256 rules (connections made from inside the DB container are trusted).
function asWorker(sqlText, password = workerPw) {
  const r = spawnSync(DOCKER, ['run', '--rm', '-i', '-e', `PGPASSWORD=${password}`, '--network', NETWORK, image, 'psql', '-h', DB_CONTAINER, '-U', 'hackass_worker', '-d', 'postgres', '-v', 'ON_ERROR_STOP=0', '-At', '-X'], { input: sqlText, encoding: 'utf8', timeout: 90_000 });
  return { out: r.stdout.trim(), err: r.stderr.trim(), status: r.status };
}

await check('W1', 'the worker login authenticates with its password over a real connection, and fails with a wrong or empty password', async () => {
  ok(asWorker('select current_user').out === 'hackass_worker', 'correct password should connect');
  const wrong = asWorker('select 1', 'definitely-wrong');
  ok(wrong.status !== 0 && /password authentication failed/.test(wrong.err), `wrong password: ${wrong.err.split('\n')[0]}`);
  const empty = asWorker('select 1', '');
  ok(empty.status !== 0, 'an empty password must fail');
  return 'correct password connects; wrong and empty passwords are refused (scram-sha-256)';
});

await check('W2', 'the worker can execute worker.healthcheck() (and, since F2-D1, the five job functions: see local-f2d1-checks.mjs) and nothing else', async () => {
  const r = asWorker(`
select 'health=' || worker.healthcheck();
select 'accounts=' || (select count(*) from app.accounts);
select 'staff=' || (select count(*) from app.staff_assignments);
select 'authusers=' || (select count(*) from auth.users);
select 'authsessions=' || (select count(*) from auth.sessions);
select 'whoami=' || api.whoami();
select 'guard=' || app_guard.require_member();
select 'bridge=' || app_bridge.session_valid(null, null);
create table public.zz_worker_probe (id int);
set role hackass_owner;
set role postgres;
select 'authid=' || count(*) from pg_authid;
select 'setting=' || current_setting('statement_timeout') || '/' || current_setting('search_path');
select 'visible_tables=' || count(*) from information_schema.tables where table_schema in ('app', 'auth');
select 'table_privs=' || count(*) from information_schema.role_table_grants where grantee = 'hackass_worker';
select 'any_priv=' || coalesce(bool_or(has_table_privilege('hackass_worker', c.oid, 'select,insert,update,delete')), false) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('app', 'auth', 'public') and c.relkind = 'r';
`);
  const lines = r.out.split('\n');
  const errs = r.err.split('\n').filter((l) => /ERROR/.test(l));
  ok(lines.includes('health=ok'), `healthcheck did not answer: ${r.out} / ${r.err.split('\n')[0]}`);
  // 10 denied statements: 2 account tables, 2 auth tables... see the list above; every ERROR must be a privilege refusal
  const denied = errs.filter((l) => /permission denied|permission to set role|must be member of role/i.test(l));
  ok(errs.length === 11 && denied.length === 11, `expected exactly 11 privilege refusals, got ${errs.length} errors (${denied.length} privilege refusals): ${errs.map((e) => e.slice(0, 70)).join(' | ')}`);
  ok(!lines.some((l) => /^(accounts|staff|authusers|authsessions|whoami|guard|bridge)=/.test(l)), `a protected statement returned data: ${lines.join(',')}`);
  ok(lines.includes('visible_tables=0') && lines.includes('table_privs=0') && lines.includes('any_priv=false'), `catalog facts: ${lines.join(',')}`);
  ok(lines.some((l) => l === 'setting=30s/""'), `session defaults were ${lines.find((l) => l.startsWith('setting='))}`);
  return `denied: ${errs.length} protected statements (tables, auth, api, guards, bridge, DDL, SET ROLE, pg_authid); visible app/auth tables=0; table grants=0; defaults ${lines.find((l) => l.startsWith('setting='))}`;
});

// ---- the rollback rehearsal --------------------------------------------------------------------------------------------------
await check('R1', 'rollback scripts (F2-D1, then F2-C2, then F2-C1, then F2-B, then F2-A): remove every application object and role (rehearsed in a transaction that is rolled back), leave auth intact', async () => {
  const downD1 = readFileSync(path.join(root, 'supabase/rollbacks/20261017090000_f2d1_down.sql'), 'utf8').replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '');
  const downC2 = downD1 + readFileSync(path.join(root, 'supabase/rollbacks/20261016090000_f2c2_down.sql'), 'utf8').replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '');
  const downC1 = downC2 + readFileSync(path.join(root, 'supabase/rollbacks/20261015090000_f2c1_down.sql'), 'utf8').replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '');
  const downB = readFileSync(path.join(root, 'supabase/rollbacks/20261014090000_f2b_down.sql'), 'utf8').replace(/^begin;\s*$/m, () => `begin;\n${downC1}`).replace(/^commit;\s*$/m, '');
  const down = readFileSync(path.join(root, 'supabase/rollbacks/20261013130000_f2a_down.sql'), 'utf8').replace(/^begin;\s*$/m, () => `begin;\n${downB}`);
  const probe = `
select 'schemas=' || count(*) from pg_namespace where nspname in ('app', 'app_guard', 'api', 'worker', 'app_bridge', 'app_content', 'app_review');
select 'roles=' || count(*) from pg_roles where rolname in ('hackass_owner', 'hackass_worker');
select 'triggers=' || count(*) from pg_trigger where tgname like 'hackass_%';
select 'ledger=' || count(*) from supabase_migrations.schema_migrations where version like '2026101313%' or version like '2026101409%' or version like '20261015%' or version like '20261016%' or version like '20261017%';
select 'auth_users_table=' || (to_regclass('auth.users') is not null);
select 'default_acl=' || count(*) from pg_default_acl d where pg_get_userbyid(d.defaclrole) = 'hackass_owner';
`;
  const before = psql(probe).out.replace(/\n/g, ' ');
  ok(/schemas=7 roles=2 triggers=2 ledger=16/.test(before), `before rollback: ${before}`);
  const body = down.replace(/^commit;\s*$/m, () => `${probe}\nrollback;`);
  const after = psql(body).out.replace(/\n/g, ' ');
  ok(/schemas=0 roles=0 triggers=0 ledger=0 auth_users_table=true default_acl=0/.test(after), `inside rolled-back rollback: ${after}`);
  const restored = psql(probe).out.replace(/\n/g, ' ');
  ok(/schemas=7 roles=2 triggers=2 ledger=16/.test(restored), `after the rehearsal the database must be unchanged: ${restored}`);
  return `before: ${before} | after rollback script: ${after} | rehearsal transaction rolled back: state restored`;
});

const n = failed();
console.log(`\nF2-A authority checks: ${n === 0 ? 'all passed' : `${n} FAILED`}`);
console.log('NOT run here (hosted only): the same checks against the hosted pooler/staging project; hackass_worker through the hosted pooler; whether the platform permits the same grants on hosted Supabase.');
process.exit(n ? 1 : 0);
