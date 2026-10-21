-- PILOT CATALOGUE INVENTORY (read-only). Run as `postgres` over the DIRECT connection:
--   psql -X -q -At -v ON_ERROR_STOP=1 -f docs/px3d/pilot-inventory.sql > inventory.actual.txt
--   diff <(LC_ALL=C sort inventory.actual.txt) <(LC_ALL=C sort docs/px3d/pilot-inventory.expected.txt)      # must print nothing
-- Every statement is a SELECT; nothing is created, changed or deleted. The FUNCTION lines use exactly the catalogue expression of the golden inventory in
-- supabase/tests/database/010_roles_and_grants.test.sql (120 functions after PX-3a), so the hosted result is compared with the same reviewed truth. The sections are
-- independent of hosted-only schemas (auth, storage, extensions ...), which are not inventoried here.
-- Line prefixes: F function, T table, P table-privilege summary, R trigger on auth.users, S schema, L migration ledger row, C counts.
select line from (
select 'F|' || p.oid::regprocedure::text || ' owner=' || pg_get_userbyid(p.proowner) || ' definer=' || p.prosecdef || ' vol=' || p.provolatile::text
       || ' search_path=' || coalesce((select substring(cfg from '^search_path=(.*)$') from unnest(p.proconfig) cfg where cfg like 'search_path=%'), 'UNSET')
       || ' execute=' || coalesce((select string_agg(case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end, ',' order by case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end)
                                     from aclexplode(p.proacl) x where x.privilege_type = 'EXECUTE'), 'NONE')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('app', 'app_guard', 'api', 'worker', 'app_bridge', 'app_content', 'app_review', 'app_budget', 'app_work')
union all
select 'T|' || c.oid::regclass::text || ' owner=' || pg_get_userbyid(c.relowner) || ' rls=' || c.relrowsecurity || ' forced=' || c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r'
union all
-- no application role holds ANY privilege on ANY table of the application schemas (the tables are reachable only through the api functions)
select 'P|table_privileges_held_by_anon_authenticated_service_role_hackass_worker=' || count(*)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join (values ('anon'), ('authenticated'), ('service_role'), ('hackass_worker')) r(rolname)
       cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
 where n.nspname in ('app', 'app_guard', 'api', 'worker', 'app_bridge', 'app_content', 'app_review', 'app_budget', 'app_work') and c.relkind in ('r', 'p', 'v', 'm') and has_table_privilege(r.rolname, c.oid, p.priv)
union all
select 'R|' || t.tgname || ' -> ' || t.tgfoid::regproc::text from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal and t.tgname like 'hackass\_%'
union all
select 'S|' || n.nspname || ' owner=' || pg_get_userbyid(n.nspowner) || ' usage=' || coalesce((select string_agg(r.rolname, ',' order by r.rolname) from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'hackass_worker', 'hackass_owner') and has_schema_privilege(r.rolname, n.oid, 'usage')), 'none')
  from pg_namespace n where n.nspname in ('app', 'app_guard', 'api', 'worker', 'app_bridge', 'app_content', 'app_review', 'app_budget', 'app_work')
union all
select 'L|' || version || ' ' || name from supabase_migrations.schema_migrations
union all
select 'C|functions=' || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app', 'app_guard', 'api', 'worker', 'app_bridge', 'app_content', 'app_review', 'app_budget', 'app_work'))
       || ' tables=' || (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r')
       || ' migrations=' || (select count(*) from supabase_migrations.schema_migrations)
) q(line) order by line collate "C";
