// The read-only queries of the checks, one JSON (or text) value each. Kept in one place so tests can pin them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP_SCHEMAS, REPO_ROOT } from './config.mjs';

const list = APP_SCHEMAS.map((s) => `'${s}'`).join(',');

export const FACTS_SQL = `select json_build_object(
  'server_version', current_setting('server_version'),
  'version', version(),
  'extensions', (select json_agg(json_build_object('name', name, 'installed', installed_version) order by name) from pg_available_extensions where name in ('pgcrypto','citext','pg_trgm')),
  'roles', (select json_agg(json_build_object('role', rolname, 'super', rolsuper, 'createrole', rolcreaterole, 'createdb', rolcreatedb, 'bypassrls', rolbypassrls, 'login', rolcanlogin) order by rolname) from pg_roles where rolname in ('postgres','authenticator','anon','authenticated','service_role','supabase_auth_admin')),
  'app_schemas', (select coalesce(json_agg(schema_name order by schema_name), '[]'::json) from information_schema.schemata where schema_name in (${list})),
  'postgres_auth_usage', has_schema_privilege('postgres','auth','usage'),
  'postgres_sessions_select', has_table_privilege('postgres','auth.sessions','select'),
  'public_objects', (select count(*) from pg_class where relnamespace = 'public'::regnamespace)
)::text`;

export const LEDGER_EXISTS_SQL = `select (to_regclass('supabase_migrations.schema_migrations') is not null)::text`;
export const LEDGER_SQL = `select json_build_object('count', count(*), 'versions', coalesce(json_agg(version order by version), '[]'::json), 'md5', coalesce(md5(string_agg(version, ',' order by version)), ''))::text from supabase_migrations.schema_migrations`;

export const FINGERPRINT_SQL = `select md5(
  coalesce((select string_agg(pg_get_functiondef(p.oid) || '|' || coalesce(p.proacl::text, ''), E'\\n' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in (${list})), '') || '#' ||
  coalesce((select string_agg(n.nspname || ':' || coalesce(n.nspacl::text, ''), E'\\n' order by n.nspname) from pg_namespace n where n.nspname in (${list})), '') || '#' ||
  coalesce((select string_agg(c.oid::regclass::text || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity::text, E'\\n' order by c.oid::regclass::text) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in (${list}) and c.relkind in ('r','v','m','S')), ''))`;

/** The function inventory query of supabase/tests/database/010_roles_and_grants.test.sql, as text. */
export const INVENTORY_SQL = `select string_agg(p.oid::regprocedure::text || ' owner=' || pg_get_userbyid(p.proowner) || ' definer=' || p.prosecdef || ' vol=' || p.provolatile::text || ' search_path=' || coalesce((select substring(cfg from '^search_path=(.*)$') from unnest(p.proconfig) cfg where cfg like 'search_path=%'), 'UNSET') || ' execute=' || coalesce((select string_agg(case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end, ',' order by case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end) from aclexplode(p.proacl) x where x.privilege_type = 'EXECUTE'), 'NONE'), E'\\n' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in (${list})`;

/** The golden inventory text from the 010 pgTAP file (what the migrations must produce). */
export function goldenInventory(root = REPO_ROOT) {
  const t = readFileSync(path.join(root, 'supabase/tests/database/010_roles_and_grants.test.sql'), 'utf8');
  const a = t.indexOf('$golden$api.create_draft');
  const b = t.indexOf('$golden$', a + 8);
  if (a < 0 || b < 0) throw new Error('the golden inventory block was not found');
  return t.slice(a + '$golden$'.length, b).trim();
}

/** Table, COLUMN and SEQUENCE privileges (effective, as has_*_privilege reports them) of the three roles that must hold none, and row-level security on every application table. */
export const PRIVS_SQL = `select json_build_object(
  'table_privileges', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join (values ('anon'),('authenticated'),('hackass_worker')) r(rn) cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv) where n.nspname in (${list}) and c.relkind in ('r','v','m','p') and has_table_privilege(r.rn, c.oid, p.priv)),
  'column_privileges', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped cross join (values ('anon'),('authenticated'),('hackass_worker')) r(rn) cross join (values ('select'),('insert'),('update'),('references')) p(priv) where n.nspname in (${list}) and c.relkind in ('r','v','m','p') and has_column_privilege(r.rn, c.oid, a.attnum, p.priv)),
  'sequence_privileges', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join (values ('anon'),('authenticated'),('hackass_worker')) r(rn) cross join (values ('usage'),('select'),('update')) p(priv) where n.nspname in (${list}) and c.relkind = 'S' and has_sequence_privilege(r.rn, c.oid, p.priv)),
  'tables_total', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in (${list}) and c.relkind in ('r','p')),
  'tables_without_rls', (select coalesce(json_agg(n.nspname || '.' || c.relname order by n.nspname, c.relname), '[]'::json) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in (${list}) and c.relkind in ('r','p') and not c.relrowsecurity),
  'owner_auth_privileges', (has_schema_privilege('hackass_owner','auth','usage') or has_any_column_privilege('hackass_owner','auth.users','select') or has_any_column_privilege('hackass_owner','auth.sessions','select')),
  'owner_role', (select json_build_object('login', rolcanlogin, 'inherit', rolinherit, 'connlimit', rolconnlimit, 'super', rolsuper, 'createrole', rolcreaterole) from pg_roles where rolname = 'hackass_owner'),
  'worker_role', (select json_build_object('login', rolcanlogin, 'inherit', rolinherit, 'connlimit', rolconnlimit, 'super', rolsuper, 'createrole', rolcreaterole) from pg_roles where rolname = 'hackass_worker'),
  'public_objects', (select count(*) from pg_class where relnamespace = 'public'::regnamespace)
)::text`;

export const TRIGGERS_BRIDGE_SQL = `select json_build_object(
  'triggers', (select coalesce(json_agg(json_build_object('name', tgname, 'enabled', tgenabled) order by tgname), '[]'::json) from pg_trigger where tgrelid = 'auth.users'::regclass and tgname like 'hackass_%'),
  'bridge', (select json_build_object('owner', pg_get_userbyid(proowner), 'definer', prosecdef, 'config', proconfig) from pg_proc where oid = 'app_bridge.session_valid(uuid,uuid)'::regprocedure),
  'bridge_execute', json_build_object('hackass_owner', has_function_privilege('hackass_owner','app_bridge.session_valid(uuid,uuid)','execute'), 'anon', has_function_privilege('anon','app_bridge.session_valid(uuid,uuid)','execute'), 'authenticated', has_function_privilege('authenticated','app_bridge.session_valid(uuid,uuid)','execute'), 'hackass_worker', has_function_privilege('hackass_worker','app_bridge.session_valid(uuid,uuid)','execute'))
)::text`;
