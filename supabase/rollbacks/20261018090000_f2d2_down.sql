-- Rollback for the two F2-D2 migrations (20261018090000, 090100). Apply BY HAND (psql as postgres); rehearsed inside a rolled-back transaction by the chain
-- checks R1..R5 and, COMMITTED and followed by supabase migration up, by scripts/local-f2d2-checks.mjs (check R7). F2-D1 and earlier objects stay.
--
-- DATA LOSS: this DROPS every AI budget configuration, every reservation, EVERY LEDGER ENTRY and every running total: the whole spend history. Export them first if
-- anything beyond test data exists. Do NOT roll back while reservations are `unknown` or `reserved`: a provider may still charge for them and nothing would track it.
-- Order: the schema with its functions first (two of them take the reservation row type, and the table triggers that use its functions go with it), then the tables.
-- Hosted/linked project, afterwards:
--   supabase migration repair --status reverted 20261018090000 20261018090100
-- Local development: `supabase stop --no-backup` discards the whole disposable database instead.
begin;

set local role hackass_owner;

drop schema if exists app_budget cascade;

drop table if exists app.ai_ledger, app.ai_reservations, app.ai_budget_days, app.ai_operation_types, app.ai_budget_global;

reset role;

delete from supabase_migrations.schema_migrations where version in ('20261018090000', '20261018090100');

commit;
