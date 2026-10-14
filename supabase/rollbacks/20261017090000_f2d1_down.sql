-- Rollback for the three F2-D1 migrations (20261017090000, 090100, 090200). Apply BY HAND (psql as postgres); rehearsed inside a rolled-back
-- transaction by scripts/local-f2d1-checks.mjs (check R5) and, ahead of the F2-C2, F2-C1, F2-B and F2-A rollbacks, by R4, R3, R2 and R1.
-- F2-C2 and earlier objects stay.
--
-- DATA WARNING: this DROPS every job (the job history, with its attempts and outcomes). Publication withdrawals that a recheck made (cause 'recheck')
-- STAY: they are history of the publication, so the three constraints F2-D1 relaxed on publication_withdrawals (cause 'recheck', trigger table 'jobs',
-- no staff actor) are deliberately left relaxed. The F2-C2 definitions of after_review_write and check_publication_children are restored.
-- Hosted/linked project, afterwards:
--   supabase migration repair --status reverted 20261017090000 20261017090100 20261017090200
-- Local development: `supabase stop --no-backup` discards the whole disposable database instead.
begin;

set local role hackass_owner;

drop function if exists worker.claim_job(text), worker.heartbeat_job(uuid, bigint), worker.get_job_subject(uuid, bigint), worker.complete_job(uuid, bigint), worker.fail_job(uuid, bigint, text);

drop trigger if exists publications_schedule_recheck on app.publications;
drop function if exists app_review.job_complete(uuid, bigint), app_review.job_effect_publication_recheck(app.jobs), app_review.job_fail(uuid, bigint, text),
  app_review.job_subject(uuid, bigint), app_review.job_heartbeat(uuid, bigint), app_review.job_claim(text), app_review.job_after_publication(),
  app_review.job_ensure_recheck(app.publications), app_review.job_assert_lease(app.jobs, bigint);

-- the functions over the app.jobs row type go before the table
drop table if exists app.jobs;
drop function if exists app_review.guard_job();

-- the F2-C2 definitions
create or replace function app_review.after_review_write() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  p app.publications;
  v_blockers text[];
  v_by uuid;
begin
  select pb.* into p from app.publications pb
    join app.hacks h on h.id = pb.hack_id and h.current_publication_id = pb.id
   where pb.submission_id = new.submission_id;
  if not found then return null; end if;
  v_blockers := app_review.publication_blockers(new.submission_id, p.published_by);
  if pg_catalog.cardinality(v_blockers) = 0 then return null; end if;
  v_by := coalesce((pg_catalog.to_jsonb(new) ->> 'actor_id'), (pg_catalog.to_jsonb(new) ->> 'assessed_by'), (pg_catalog.to_jsonb(new) ->> 'reviewer_id'))::uuid;
  perform app_review.withdraw_locked(p, 'review_change', null, null, v_blockers, tg_table_name, new.id, v_by, 'under_review');
  return null;
end
$$;

create or replace function app_review.check_publication_children() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  v_rights uuid[];
  v_claims integer;
  v_listed integer;
begin
  select coalesce(pg_catalog.array_agg(pr.rights_review_id order by pr.claim_no), array[]::uuid[]), pg_catalog.count(*) into v_rights, v_listed
    from app.publication_rights pr where pr.publication_id = new.id;
  select pg_catalog.count(*) into v_claims from app.source_claims c where c.version_id = new.version_id;
  if v_claims = 0 or v_listed <> v_claims or v_rights is distinct from app_review.effective_rights(new.submission_id)
     or exists (select 1 from app.rights_reviews rr where rr.id = any (v_rights) and (rr.status <> 'clear' or (rr.expires_on is not null and rr.expires_on < current_date))) then
    raise exception 'snapshot_mismatch' using errcode = 'PT409', detail = 'rights';
  end if;
  if new.snapshot_text is distinct from app_review.snapshot_text(new.hack_id, new.version_id, new.submission_id, new.content_hash, new.canon_version,
       new.decision_id, new.assessment_id, new.published_by, new.publisher_role, v_rights)
     or new.snapshot_hash is distinct from app_content.hash_text(new.snapshot_text) then
    raise exception 'snapshot_mismatch' using errcode = 'PT409';
  end if;
  return null;
end
$$;

reset role;

delete from supabase_migrations.schema_migrations where version in ('20261017090000', '20261017090100', '20261017090200');

commit;
