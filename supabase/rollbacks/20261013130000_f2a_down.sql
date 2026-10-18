-- Rollback for the three F2-A migrations (20261013130000, 20261013130100, 20261013130200).
-- Migrations are forward-only; this file is applied BY HAND (psql as postgres) and is rehearsed by
-- scripts/local-f2a-checks.mjs inside a transaction that is rolled back. It removes everything F2-A created, in dependency
-- order, and leaves the Supabase-managed schemas (auth, storage, ...) exactly as they were.
--
-- Data warning: this DROPS app.accounts and app.staff_assignments. Export them first if anything beyond test data exists.
-- Hosted/linked project: after running this, mark the versions reverted so a later push can re-apply them:
--   supabase migration repair --status reverted 20261013130000 20261013130100 20261013130200
-- Local development: `supabase stop --no-backup` discards the whole disposable database instead.
begin;

-- triggers on the Supabase-owned table
drop trigger if exists hackass_account_created on auth.users;
drop trigger if exists hackass_account_deleted on auth.users;

-- postgres-owned bridge
drop schema if exists app_bridge cascade;

-- objects owned by hackass_owner (postgres may SET ROLE to it but does not inherit it)
set local role hackass_owner;
drop schema if exists api cascade;
drop schema if exists worker cascade;
drop schema if exists app_guard cascade;
drop schema if exists app cascade;
drop owned by hackass_owner;                                    -- also removes the default-privilege entries made in migration 1
reset role;

-- roles (the worker owns nothing and holds only grants that lived on the dropped schemas)
drop role if exists hackass_worker;
drop role if exists hackass_owner;

-- let the Supabase CLI re-apply the migrations after a rollback on a local database
delete from supabase_migrations.schema_migrations where version in ('20261013130000', '20261013130100', '20261013130200');

commit;
