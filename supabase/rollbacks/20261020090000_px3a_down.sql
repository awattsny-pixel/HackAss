-- Rollback for the four PX-3a migrations (20261020090000 .. 20261020090300): private saving of prompts and results.
-- Migrations are forward-only; this file is applied BY HAND (psql as postgres) and is rehearsed by scripts/local-px3a-checks.mjs (first inside a transaction that is
-- rolled back, then as a COMMITTED rollback followed by re-application). It removes everything PX-3a created, in dependency order, and touches nothing else.
--
-- DATA WARNING: this DROPS app.saved_prompts and app.saved_reflections, i.e. EVERY member's saved prompts and results. Export what must be kept first
-- (api.export_my_data is the member-level export; an operator export is a plain pg_dump of those two tables).
-- Hosted/linked project: after running this, mark the versions reverted so a later push can re-apply them:
--   supabase migration repair --status reverted 20261020090000 20261020090100 20261020090200 20261020090300
begin;

-- the trigger on the Supabase-owned table, then its function
drop trigger if exists hackass_work_content_deleted on auth.users;

set local role hackass_owner;
drop function if exists app_guard.on_auth_user_deleted_content();

-- the exposed functions (schema api is shared with F2, so they are dropped one by one, never by schema)
drop function if exists api.save_prompt(uuid, jsonb, uuid, integer);
drop function if exists api.get_my_prompt(uuid);
drop function if exists api.list_my_prompts(integer, timestamptz, uuid);
drop function if exists api.delete_my_prompt(uuid, integer);
drop function if exists api.save_reflection(uuid, uuid, integer, jsonb);
drop function if exists api.save_prompt_and_result(uuid, jsonb, jsonb, uuid, integer);
drop function if exists api.update_my_reflection(uuid, integer, jsonb);
drop function if exists api.delete_my_reflection(uuid, integer);
drop function if exists api.list_my_results(integer, text, timestamptz, uuid);
drop function if exists api.get_my_result(uuid);
drop function if exists api.export_my_data(text, uuid, integer);

-- helpers and their types (write_result's signature names the prompts table, so this precedes the tables)
drop schema if exists app_work cascade;

-- tables (results first: they reference prompts)
drop table if exists app.saved_reflections;
drop table if exists app.saved_prompts;
reset role;

-- let the Supabase CLI re-apply the migrations after a rollback on a local database
delete from supabase_migrations.schema_migrations where version in ('20261020090000', '20261020090100', '20261020090200', '20261020090300');

commit;
