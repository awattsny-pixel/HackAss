-- Rollback for the four F2-D1 migrations (20261017090000, 090100, 090200, 090300). Apply BY HAND (psql as postgres); rehearsed inside a rolled-back
-- transaction by scripts/local-f2d1-checks.mjs (check R5) and, ahead of the F2-C2, F2-C1, F2-B and F2-A rollbacks, by R4, R3, R2 and R1.
-- F2-C2 and earlier objects stay.
--
-- DATA WARNING: this DROPS every job (the job history, with its attempts and outcomes). Publication withdrawals that a recheck made (cause 'recheck')
-- STAY: they are history of the publication, so the three constraints F2-D1 relaxed on publication_withdrawals (cause 'recheck', trigger table 'jobs',
-- no staff actor) are deliberately left relaxed; the F2-D1 migration is written to be re-applied over them (drop-if-exists, then add). The F2-C2 definitions of after_review_write and check_publication_children are restored.
-- Hosted/linked project, afterwards:
--   supabase migration repair --status reverted 20261017090000 20261017090100 20261017090200 20261017090300
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

-- the F2-C1 definitions (current_date)
create or replace function app_review.approval_blockers(p_submission_id uuid, p_actor uuid) returns text[]
  language plpgsql stable security definer set search_path = ''
as $$
declare
  s app.submissions;
  b text[] := array[]::text[];
  v_risk text;
  v_admin boolean;
  v_claims integer;
  r record;
  u text;
begin
  select * into s from app.submissions where id = p_submission_id;
  if not found then return array['submission_missing']; end if;
  if s.submitter_id = p_actor or exists (select 1 from app.version_attributions a where a.version_id = s.version_id and a.profile_id = p_actor) then
    b := pg_catalog.array_append(b, 'self_review');
  end if;
  v_admin := exists (select 1 from app.staff_assignments st where st.user_id = p_actor and st.role = 'admin' and st.revoked_at is null);
  select a.risk_class into v_risk from app.version_assessments a where a.submission_id = s.id order by a.seq desc limit 1;
  if v_risk is null then b := pg_catalog.array_append(b, 'assessment_missing');
  elsif v_risk = 'prohibited' then b := pg_catalog.array_append(b, 'risk_prohibited');
  elsif v_risk = 'high' and not v_admin then b := pg_catalog.array_append(b, 'risk_high_needs_admin');
  end if;
  select pg_catalog.count(*) into v_claims from app.source_claims c where c.version_id = s.version_id;
  if v_claims = 0 then b := pg_catalog.array_append(b, 'rights_not_clear:none'); end if;
  for r in select c.claim_no from app.source_claims c where c.version_id = s.version_id order by c.claim_no loop
    if not exists (
      select 1 from app.rights_reviews rr
       where rr.submission_id = s.id and rr.claim_no = r.claim_no
         and rr.seq = (select pg_catalog.max(x.seq) from app.rights_reviews x where x.submission_id = s.id and x.claim_no = r.claim_no)
         and rr.status = 'clear'
         and (rr.expires_on is null or rr.expires_on >= current_date)
         and rr.claim_hash = app_review.claim_hash(s.version_id, r.claim_no)
    ) then
      b := pg_catalog.array_append(b, 'rights_not_clear:' || r.claim_no);
    end if;
  end loop;
  foreach u in array app_review.unresolved_references(s.version_id) loop
    b := pg_catalog.array_append(b, 'unresolved_references:' || u);
  end loop;
  return b;
end
$$;

create or replace function api.record_rights_review(
  p_submission_id uuid, p_expected_hash text, p_claim_no integer, p_status text, p_basis_code text, p_evidence_note text, p_expires_on date
) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_staff app_guard.staff_actor;
  s app.submissions;
  v_state text;
  v_id uuid;
  v_seq integer;
  v_c text;
  v_col text;
begin
  v_staff := app_guard.require_staff('reviewer', interval '15 minutes');
  s := app_review.lock_submission(p_submission_id);
  perform app_review.verify_binding(s, p_expected_hash);
  perform app_review.assert_reviewer_ok(s, v_staff.user_id);
  select l.state into v_state from app.version_lifecycle l where l.version_id = s.version_id;
  if v_state <> all (array['under_review', 'approved', 'rejected']) then raise exception 'invalid_state' using errcode = 'PT409', detail = v_state; end if;
  if not exists (select 1 from app.source_claims c where c.version_id = s.version_id and c.claim_no = p_claim_no) then
    raise exception 'not_found' using errcode = 'PT404', detail = 'claim';
  end if;
  if p_expires_on is not null and p_expires_on <= current_date then
    raise exception 'invalid_content' using errcode = 'PT422', detail = 'expires_on';
  end if;
  begin
    insert into app.rights_reviews (submission_id, version_id, content_hash, canon_version, claim_no, status, basis_code, evidence_note, expires_on, reviewer_id)
      values (s.id, s.version_id, s.content_hash, s.canon_version, p_claim_no, p_status, p_basis_code, app_content.canon_str(p_evidence_note), p_expires_on, v_staff.user_id)
      returning id, seq into v_id, v_seq;
  exception when check_violation or not_null_violation then
    get stacked diagnostics v_c = constraint_name, v_col = column_name;
    raise exception 'invalid_content' using errcode = 'PT422', detail = coalesce(v_c, v_col, 'rights_review');
  end;
  return pg_catalog.jsonb_build_object('rights_review_id', v_id, 'claim_no', p_claim_no, 'seq', v_seq, 'status', p_status);
end
$$;

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

drop function if exists app_review.utc_today();

reset role;

delete from supabase_migrations.schema_migrations where version in ('20261017090000', '20261017090100', '20261017090200', '20261017090300');

commit;
