-- Rollback for the three F2-C1 migrations (20261015090000, 090100, 090200). Apply BY HAND (psql as postgres); rehearsed inside a rolled-back
-- transaction by scripts/local-f2c-checks.mjs (check R3) and, ahead of the F2-B and F2-A rollbacks, by scripts/local-f2a-checks.mjs (check R1).
-- F2-B and F2-A objects stay.
--
-- DATA WARNING: this DROPS every risk assessment, rights review and moderation decision. Export them first if anything beyond test data exists.
-- Order: the api functions, then the tables (their triggers go with them), then the binding constraint on submissions, then the schema.
-- Hosted/linked project, afterwards:
--   supabase migration repair --status reverted 20261015090000 20261015090100 20261015090200
-- Local development: `supabase stop --no-backup` discards the whole disposable database instead.
begin;

set local role hackass_owner;

drop function if exists api.list_submissions_for_review(integer, text[], timestamptz, uuid), api.get_submission_for_review(uuid),
                        api.start_review(uuid, text), api.record_risk_assessment(uuid, text, text, text),
                        api.record_rights_review(uuid, text, integer, text, text, text, date), api.record_decision(uuid, text, text, text[], text, uuid);

drop table if exists app.moderation_decisions, app.rights_reviews, app.version_assessments;

alter table app.submissions drop constraint if exists submissions_review_binding;

drop schema if exists app_review cascade;

reset role;

delete from supabase_migrations.schema_migrations where version in ('20261015090000', '20261015090100', '20261015090200');

commit;
