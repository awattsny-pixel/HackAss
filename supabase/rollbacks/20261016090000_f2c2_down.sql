-- Rollback for the three F2-C2 migrations (20261016090000, 090100, 090200). Apply BY HAND (psql as postgres); rehearsed inside a rolled-back
-- transaction by scripts/local-f2c2-checks.mjs (check R4) and, ahead of the F2-C1, F2-B and F2-A rollbacks, by scripts/local-f2c-checks.mjs (R3),
-- scripts/local-f2b-checks.mjs (R2) and scripts/local-f2a-checks.mjs (R1). F2-C1, F2-B and F2-A objects stay.
--
-- DATA WARNING: this DROPS every publication, its rights rows and its withdrawals, and the hacks.current_publication_id column (and with it
-- every "what is published" answer). The slugs assigned at publication stay on app.hacks. Export first if anything beyond test data exists.
-- Order: the api functions; the triggers F2-C2 added to F2-C1 and F2-B tables; the pointer column; the publication tables (their own triggers go
-- with them); the keys F2-C2 added to the review tables; the F2-C2 functions; then the F2-C1 definition of lock_submission is restored.
-- Hosted/linked project, afterwards:
--   supabase migration repair --status reverted 20261016090000 20261016090100 20261016090200
-- Local development: `supabase stop --no-backup` discards the whole disposable database instead.
begin;

set local role hackass_owner;

drop function if exists api.publish_version(uuid, text, uuid, text), api.withdraw_publication(uuid, text, text), api.get_publication(uuid);

drop trigger if exists decisions_after_write on app.moderation_decisions;
drop trigger if exists assessments_after_write on app.version_assessments;
drop trigger if exists rights_reviews_after_write on app.rights_reviews;
drop trigger if exists hacks_guard on app.hacks;

alter table app.hacks drop constraint if exists hacks_current_publication_of_hack;
alter table app.hacks drop column if exists current_publication_id;

-- withdraw_locked takes the app.publications row type, so it goes before the table
drop function if exists app_review.withdraw_locked(app.publications, text, text, text, text[], text, uuid, uuid, text);
drop table if exists app.publication_withdrawals, app.publication_rights, app.publications;

alter table app.moderation_decisions drop constraint if exists decisions_id_submission;
alter table app.version_assessments  drop constraint if exists assessments_id_submission;
alter table app.rights_reviews       drop constraint if exists rights_review_binding;

drop function if exists app_review.after_review_write(), app_review.guard_hack(), app_review.guard_publication(), app_review.check_publication_children(),
  app_review.check_withdrawal_cleared(), app_review.publication_blockers(uuid, uuid), app_review.effective_rights(uuid),
  app_review.snapshot_text(uuid, uuid, uuid, bytea, smallint, uuid, uuid, uuid, text, uuid[]);

-- the F2-C1 definition (submission lock only)
create or replace function app_review.lock_submission(p_submission_id uuid) returns app.submissions
  language plpgsql security definer set search_path = ''
as $$
declare s app.submissions;
begin
  select * into s from app.submissions where id = p_submission_id for update;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  return s;
end
$$;

reset role;

delete from supabase_migrations.schema_migrations where version in ('20261016090000', '20261016090100', '20261016090200');

commit;
