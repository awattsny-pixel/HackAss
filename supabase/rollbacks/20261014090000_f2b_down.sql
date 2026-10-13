-- Rollback for the four F2-B migrations (20261014090000, 090100, 090200, 090300). Apply BY HAND (psql as postgres); rehearsed
-- inside a rolled-back transaction by scripts/local-f2b-checks.mjs (check R2) and, together with the F2-A rollback, by
-- scripts/local-f2a-checks.mjs (check R1). F2-A objects (roles, accounts, staff_assignments, guards, api.whoami/staff_probe) stay.
--
-- DATA WARNING: this DROPS every hack, version, child record and submission. Export first if anything beyond test data exists.
-- Order matters: the tables go before the app_content schema, because their CHECK constraints call app_content.clean_text.
-- Hosted/linked project, afterwards:
--   supabase migration repair --status reverted 20261014090000 20261014090100 20261014090200 20261014090300
-- Local development: `supabase stop --no-backup` discards the whole disposable database instead.
begin;

set local role hackass_owner;

drop function if exists api.create_draft(uuid), api.save_draft(uuid, jsonb), api.get_version(uuid), api.list_my_versions(),
                        api.submit_version(uuid, text), api.delete_draft(uuid);

drop table if exists app.submissions, app.version_assets, app.version_attributions, app.source_claims, app.version_tags,
                     app.hack_requirements, app.hack_materials, app.hack_steps, app.version_lifecycle, app.hack_versions,
                     app.hacks, app.categories;

drop schema if exists app_content cascade;

reset role;

delete from supabase_migrations.schema_migrations where version in ('20261014090000', '20261014090100', '20261014090200', '20261014090300');

commit;
