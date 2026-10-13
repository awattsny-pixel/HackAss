-- F2-A: role, schema, table and function privilege inventory, checked against the real catalog.
-- Every expectation below is a golden value reviewed by hand: any drift (a new grant, a changed owner, a function without
-- search_path = '') fails this file. Application behaviour is tested in 020_authorization.test.sql.
begin;
select no_plan();

-- ---- roles ----------------------------------------------------------------------------------------------------------
select has_role('hackass_owner',  'hackass_owner exists');
select has_role('hackass_worker', 'hackass_worker exists');

select is(
  (select row(rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit, rolconnlimit)::text from pg_roles where rolname = 'hackass_owner'),
  '(f,f,f,f,f,f,f,0)',
  'hackass_owner: NOLOGIN, not superuser/createrole/createdb/replication/bypassrls, no inheritance, zero connections');
select is(
  (select row(rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit, rolconnlimit)::text from pg_roles where rolname = 'hackass_worker'),
  '(t,f,f,f,f,f,f,10)',
  'hackass_worker: LOGIN only, no privileged attributes, no inheritance, at most 10 connections');
select is(
  (select pg_catalog.array_to_string(array(select c from pg_catalog.unnest(setconfig) c order by c), ' | ') from pg_db_role_setting where setrole = 'hackass_worker'::regrole and setdatabase = 0),
  'idle_in_transaction_session_timeout=30s | search_path="" | statement_timeout=30s',
  'hackass_worker has session defaults: statement and idle-transaction timeouts and an empty search_path (defaults, not hard limits)');

select is(
  (select coalesce(string_agg(m.rolname || ':inherit=' || a.inherit_option || ':set=' || a.set_option, ',' order by m.rolname), '')
     from pg_auth_members a join pg_roles m on m.oid = a.member where a.roleid = 'hackass_owner'::regrole and m.rolname = 'postgres'),
  'postgres:inherit=false:set=false,postgres:inherit=false:set=true',
  'postgres can SET ROLE hackass_owner (set=true) but never inherits its privileges (the extra set=false row is the role creator''s default admin grant)');
select is(
  (select count(*)::int from pg_auth_members where roleid in ('hackass_owner'::regrole, 'hackass_worker'::regrole) and member not in ('postgres'::regrole)),
  0, 'no role other than postgres is a member of hackass_owner or hackass_worker');
select is(
  (select count(*)::int from pg_auth_members where member in ('hackass_owner'::regrole, 'hackass_worker'::regrole)),
  0, 'hackass_owner and hackass_worker are members of no role (no inherited privileges)');

-- ---- schemas --------------------------------------------------------------------------------------------------------
select is(
  (select string_agg(nspname || '=' || pg_get_userbyid(nspowner), ',' order by nspname) from pg_namespace where nspname in ('app', 'app_guard', 'api', 'worker', 'app_bridge', 'app_content')),
  'api=hackass_owner,app=hackass_owner,app_bridge=postgres,app_content=hackass_owner,app_guard=hackass_owner,worker=hackass_owner',
  'schema owners');

select is(
  (select coalesce(string_agg(n.nspname || ':' || r.rolname || ':' || p.priv, ', ' order by n.nspname, r.rolname, p.priv), '')
     from pg_namespace n
     cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin', 'hackass_owner', 'hackass_worker', 'postgres')) r
     cross join (values ('USAGE'), ('CREATE')) p(priv)
    where n.nspname in ('app', 'app_guard', 'api', 'worker', 'app_bridge', 'app_content')
      and has_schema_privilege(r.rolname, n.oid, p.priv)),
  'api:anon:USAGE, api:authenticated:USAGE, api:hackass_owner:CREATE, api:hackass_owner:USAGE, api:postgres:USAGE, '
  'app:hackass_owner:CREATE, app:hackass_owner:USAGE, app:postgres:USAGE, '
  'app_bridge:hackass_owner:USAGE, app_bridge:postgres:CREATE, app_bridge:postgres:USAGE, '
  'app_content:hackass_owner:CREATE, app_content:hackass_owner:USAGE, app_content:postgres:USAGE, '
  'app_guard:hackass_owner:CREATE, app_guard:hackass_owner:USAGE, app_guard:postgres:USAGE, app_guard:supabase_auth_admin:USAGE, '
  'worker:hackass_owner:CREATE, worker:hackass_owner:USAGE, worker:hackass_worker:USAGE, worker:postgres:USAGE',
  'schema privileges: exactly the intended grants. postgres (break-glass) shows USAGE because the platform makes it a member of pg_read_all_data; nothing for service_role, authenticator or hackass_worker on app/app_guard/app_bridge');
select is(
  (select count(*)::int from pg_namespace n, pg_catalog.aclexplode(n.nspacl) x
    where n.nspname in ('app', 'app_guard', 'api', 'worker', 'app_bridge', 'app_content') and x.grantee = 0),
  0, 'PUBLIC has no privilege on any application schema');

-- ---- tables ---------------------------------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(c.relname || ':' || r.rolname || ':' || p.priv, ', ' order by c.relname, r.rolname, p.priv), '')
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'app'
     cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin', 'hackass_worker')) r
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
    where c.relkind = 'r' and has_table_privilege(r.rolname, c.oid, p.priv)),
  '',
  'no application role (anon, authenticated, service_role, authenticator, supabase_auth_admin, hackass_worker) holds ANY privilege on ANY app.* table: members and the worker have no direct table-write (or read) access');
select is(
  (select coalesce(string_agg(c.relname || ':' || p.priv, ', ' order by c.relname, p.priv), '')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'app'
     cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
    where c.relkind = 'r' and has_table_privilege('postgres', c.oid, p.priv)),
  '', 'break-glass postgres can read app.* (pg_read_all_data) but holds no write privilege on any of it');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r' and c.relacl is not null and c.relacl::text <> '{hackass_owner=arwdDxtm/hackass_owner}'),
  0, 'every table ACL is the owner alone (NULL = owner default, or exactly the owner entry); nothing for PUBLIC or any other role');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r' and (not c.relrowsecurity or c.relforcerowsecurity)),
  0, 'row-level security is on for every application table (owner exempt; no policies exist, so any other role is denied)');
select is((select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app'), 0, 'no RLS policy exists (default deny)');
select is(
  (select string_agg(c.relname, ', ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r'),
  'accounts, categories, hack_materials, hack_requirements, hack_steps, hack_versions, hacks, source_claims, staff_assignments, submissions, version_assets, version_attributions, version_lifecycle, version_tags',
  'app contains exactly these 14 tables (any new table must be added here, with its grants reviewed)');
select is(
  (select string_agg(c.relname, ', ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r'
      and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname like '%\_guard' or t.tgrelid = c.oid and t.tgname like '%\_append\_only') and c.relname in ('hack_versions', 'hack_steps', 'hack_materials', 'hack_requirements', 'version_tags', 'version_attributions', 'source_claims', 'version_assets', 'submissions')),
  null, 'every hashed table and submissions has its immutability trigger');
select is(
  (select string_agg(c.relname, ', ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r'
      and c.relname in ('hack_versions', 'hack_steps', 'hack_materials', 'hack_requirements', 'version_tags', 'version_attributions', 'source_claims', 'version_assets', 'submissions')
      and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname like '%\_no\_truncate')),
  null, 'every hashed table and submissions refuses TRUNCATE');

select is(
  (select string_agg(t.tgname, ', ' order by t.tgname) from pg_trigger t where t.tgrelid = 'app.categories'::regclass and not t.tgisinternal),
  'categories_guard, categories_no_truncate', 'categories: slug/id immutability trigger and TRUNCATE guard are installed');

-- ---- functions: owner, definer, empty search_path, EXECUTE grantees ----------------------------------------------------
select is(
  (select string_agg(
     p.oid::regprocedure::text || ' owner=' || pg_get_userbyid(p.proowner) || ' definer=' || p.prosecdef || ' vol=' || p.provolatile::text
       || ' search_path=' || coalesce((select substring(cfg from '^search_path=(.*)$') from unnest(p.proconfig) cfg where cfg like 'search_path=%'), 'UNSET')
       || ' execute=' || coalesce((select string_agg(case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end, ',' order by case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end)
                                     from aclexplode(p.proacl) x where x.privilege_type = 'EXECUTE'), 'NONE'),
     E'\n' order by p.oid::regprocedure::text)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'app_guard', 'api', 'worker', 'app_bridge', 'app_content')),
  $golden$api.create_draft(uuid) owner=hackass_owner definer=true vol=v search_path="" execute=authenticated,hackass_owner
api.delete_draft(uuid) owner=hackass_owner definer=true vol=v search_path="" execute=authenticated,hackass_owner
api.get_version(uuid) owner=hackass_owner definer=true vol=s search_path="" execute=authenticated,hackass_owner
api.list_my_versions() owner=hackass_owner definer=true vol=s search_path="" execute=authenticated,hackass_owner
api.save_draft(uuid,jsonb) owner=hackass_owner definer=true vol=v search_path="" execute=authenticated,hackass_owner
api.staff_probe(text,integer) owner=hackass_owner definer=true vol=s search_path="" execute=authenticated,hackass_owner
api.submit_version(uuid,text) owner=hackass_owner definer=true vol=v search_path="" execute=authenticated,hackass_owner
api.whoami() owner=hackass_owner definer=true vol=s search_path="" execute=authenticated,hackass_owner
app_bridge.session_valid(uuid,uuid) owner=postgres definer=true vol=s search_path="" execute=hackass_owner,postgres
app_content.assert_keys(jsonb,text[],text) owner=hackass_owner definer=true vol=i search_path="" execute=hackass_owner
app_content.assert_limits(jsonb) owner=hackass_owner definer=true vol=i search_path="" execute=hackass_owner
app_content.assert_submittable(uuid) owner=hackass_owner definer=true vol=s search_path="" execute=hackass_owner
app_content.canon_str(text) owner=hackass_owner definer=true vol=i search_path="" execute=hackass_owner
app_content.canonical_text_json(jsonb) owner=hackass_owner definer=true vol=i search_path="" execute=hackass_owner
app_content.canonical_text(uuid) owner=hackass_owner definer=true vol=s search_path="" execute=hackass_owner
app_content.clean_text(text,integer,integer) owner=hackass_owner definer=true vol=i search_path="" execute=hackass_owner
app_content.freeze_version(uuid,uuid,bytea) owner=hackass_owner definer=true vol=v search_path="" execute=hackass_owner
app_content.fv(text) owner=hackass_owner definer=true vol=i search_path="" execute=hackass_owner
app_content.guard_category() owner=hackass_owner definer=true vol=v search_path="" execute=hackass_owner
app_content.guard_child() owner=hackass_owner definer=true vol=v search_path="" execute=hackass_owner
app_content.guard_submission() owner=hackass_owner definer=true vol=v search_path="" execute=hackass_owner
app_content.guard_truncate() owner=hackass_owner definer=true vol=v search_path="" execute=hackass_owner
app_content.guard_version() owner=hackass_owner definer=true vol=v search_path="" execute=hackass_owner
app_content.hash_text(text) owner=hackass_owner definer=true vol=i search_path="" execute=hackass_owner
app_content.j_arr(jsonb,text) owner=hackass_owner definer=true vol=i search_path="" execute=hackass_owner
app_content.j_hex64(jsonb,text) owner=hackass_owner definer=true vol=i search_path="" execute=hackass_owner
app_content.j_int(jsonb,text) owner=hackass_owner definer=true vol=i search_path="" execute=hackass_owner
app_content.j_text(jsonb,text) owner=hackass_owner definer=true vol=i search_path="" execute=hackass_owner
app_content.j_uuid(jsonb,text) owner=hackass_owner definer=true vol=i search_path="" execute=hackass_owner
app_content.version_doc(uuid) owner=hackass_owner definer=true vol=s search_path="" execute=hackass_owner
app_content.version_hash(uuid) owner=hackass_owner definer=true vol=s search_path="" execute=hackass_owner
app_content.write_doc(uuid,jsonb) owner=hackass_owner definer=true vol=v search_path="" execute=hackass_owner
app_guard.on_auth_user_created() owner=hackass_owner definer=true vol=v search_path="" execute=hackass_owner,supabase_auth_admin
app_guard.on_auth_user_deleted() owner=hackass_owner definer=true vol=v search_path="" execute=hackass_owner,supabase_auth_admin
app_guard.require_member() owner=hackass_owner definer=true vol=s search_path="" execute=hackass_owner
app_guard.require_staff(text,interval) owner=hackass_owner definer=true vol=s search_path="" execute=hackass_owner
worker.healthcheck() owner=hackass_owner definer=true vol=s search_path="" execute=hackass_owner,hackass_worker$golden$,
  'function inventory: owner, SECURITY DEFINER, search_path = empty, volatility, explicit EXECUTE grantees (never PUBLIC, anon or service_role). Only the api functions are executable by authenticated; vol: v volatile (writers and triggers), s stable, i immutable');

select is(
  (select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'app_guard', 'api', 'worker', 'app_bridge', 'app_content') and p.proowner <> 'hackass_owner'::regrole),
  'app_bridge.session_valid(uuid,uuid)',
  'G-3 exception: the ONLY application-schema function not owned by hackass_owner is the postgres-owned bridge');
select is(
  (select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'app_guard', 'api', 'worker', 'app_bridge', 'app_content')
      and (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '(\mfrom|\mjoin|(?<!for\s)(?<!distinct\s)\mupdate)\s+(?!app\.|auth\.|pg_catalog\.|app_bridge\.|app_guard\.|app_content\.|api\.|v_|p_|old\.|new\.)[a-z_]+'
        or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'insert\s+into\s+(?!app\.)' or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'delete\s+from\s+(?!app\.)')),
  null, 'no function body names a table or function without a schema (everything is fully qualified)');
select is(
  (select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api' and p.prosrc !~* '^\s*(declare[\s\S]*?)?begin\s+(v_\w+\s*:=\s*)?app_guard\.require_(member|staff)\('),
  null, 'every api function begins with a guard call (the caller check precedes all protected work)');
select is(
  (select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_guard' and p.proname in ('require_staff') and p.prosrc !~* '^\s*declare[\s\S]*?begin\s+v_actor := app_guard\.require_member\('),
  null, 'the staff guard starts by calling the member guard');
select ok(
  (select p.prosrc ~ 'begin\s+if session_user <> ''hackass_worker'' then' from pg_proc p where p.oid = 'worker.healthcheck()'::regprocedure),
  'worker.healthcheck checks the calling login first');
select is(
  (select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('api', 'app_guard', 'worker', 'app_bridge', 'app_content') and p.provolatile = 'v' and p.prorettype <> 'trigger'::regtype),
  'api.create_draft(uuid), api.delete_draft(uuid), api.save_draft(uuid,jsonb), api.submit_version(uuid,text), app_content.freeze_version(uuid,uuid,bytea), app_content.write_doc(uuid,jsonb)',
  'exactly the writing functions are VOLATILE; every reader, guard, validator and hash function is STABLE or IMMUTABLE');

-- ---- hackass_owner holds nothing it does not need -----------------------------------------------------------------------
select is(
  (select row(has_schema_privilege('hackass_owner', 'auth', 'usage'),
              has_table_privilege('hackass_owner', 'auth.sessions', 'select'),
              has_table_privilege('hackass_owner', 'auth.users', 'select'),
              has_any_column_privilege('hackass_owner', 'auth.sessions', 'select'),
              has_any_column_privilege('hackass_owner', 'auth.users', 'select'),
              has_schema_privilege('hackass_owner', 'public', 'create'),
              has_database_privilege('hackass_owner', current_database(), 'create'))::text),
  '(f,f,f,f,f,f,f)',
  'hackass_owner has no privilege on the auth schema or its tables, cannot create in public, cannot create schemas');
select is(
  (select row(has_function_privilege('hackass_owner', 'app_bridge.session_valid(uuid,uuid)', 'execute'), has_schema_privilege('hackass_owner', 'app_bridge', 'usage'))::text),
  '(t,t)', 'the only route from hackass_owner to auth state is the postgres-owned bridge function');
select throws_ok($$set local role hackass_owner; select count(*) from auth.sessions$$, '42501', null, 'hackass_owner cannot read auth.sessions directly');
reset role;
select throws_ok($$set local role hackass_owner; select count(*) from auth.users$$, '42501', null, 'hackass_owner cannot read auth.users directly');
reset role;

-- ---- default privileges: new functions/tables made by the owner are not implicitly public ---------------------------------
set local role hackass_owner;
create function app.zz_default_acl_probe() returns int language sql as 'select 1';
create table app.zz_default_acl_probe (id int);
reset role;
select is(
  (select row(has_function_privilege('anon', 'app.zz_default_acl_probe()', 'execute'), has_function_privilege('authenticated', 'app.zz_default_acl_probe()', 'execute'),
              has_function_privilege('service_role', 'app.zz_default_acl_probe()', 'execute'), has_function_privilege('hackass_worker', 'app.zz_default_acl_probe()', 'execute'),
              (select count(*) from aclexplode((select proacl from pg_proc where oid = 'app.zz_default_acl_probe()'::regprocedure)) x where x.grantee = 0))::text),
  '(f,f,f,f,0)', 'a function later created by the owner is not executable by PUBLIC, anon, authenticated, service_role or the worker');
select is(
  (select row(has_table_privilege('anon', 'app.zz_default_acl_probe', 'select'), has_table_privilege('authenticated', 'app.zz_default_acl_probe', 'select'), has_table_privilege('service_role', 'app.zz_default_acl_probe', 'select'), has_table_privilege('hackass_worker', 'app.zz_default_acl_probe', 'select'))::text),
  '(f,f,f,f)', 'a table later created by the owner is not readable by any application role');

-- ---- Auth triggers ----------------------------------------------------------------------------------------------------
select is(
  (select string_agg(t.tgname || ':' || t.tgfoid::regproc::text, ', ' order by t.tgname) from pg_trigger t where t.tgrelid = 'auth.users'::regclass and t.tgname like 'hackass_%'),
  'hackass_account_created:app_guard.on_auth_user_created, hackass_account_deleted:app_guard.on_auth_user_deleted',
  'the two account-lifecycle triggers are installed on auth.users');
select is(
  (select row(has_function_privilege('postgres', 'app_guard.on_auth_user_created()', 'execute'), has_schema_privilege('postgres', 'app_guard', 'usage'))::text),
  '(f,t)', 'postgres was given EXECUTE only while creating the triggers and no longer holds it (its schema USAGE is the pg_read_all_data break-glass membership)');

select * from finish();
rollback;
