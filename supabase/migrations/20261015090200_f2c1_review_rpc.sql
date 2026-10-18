-- F2-C1 (3/3): the guarded staff RPCs. Every function starts with app_guard.require_staff('reviewer', 15 minutes): a verified live session, an
-- active account, a CURRENT database-held staff assignment (reviewer or admin), aal2 and TOTP verified within 15 minutes and not in the future.
-- The reviewer is always the guard's actor; no function accepts a reviewer or user id. Every write names the content hash the reviewer looked at,
-- which must equal the submission's frozen hash and the hash recomputed from the committed rows. Staff may not review a submission they submitted or are
-- named in as a member author. All writes lock the submission row first (app_review.lock_submission), so concurrent reviewers serialize.
-- Errors: PT404 not_found; PT409 hash_mismatch / invalid_state / decision_conflict / approval_blocked (detail = blockers); 42501 not_staff, self_review,
-- mfa_required, mfa_stale; PT422 invalid_content (detail = the field or constraint, never a value).

set local role hackass_owner;

-- ---- reading -------------------------------------------------------------------------------------------------------------------------
create function api.list_submissions_for_review(
  p_limit integer default 20, p_states text[] default array['submitted', 'under_review']::text[], p_after_created_at timestamptz default null, p_after_id uuid default null
) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_staff app_guard.staff_actor;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  v_staff := app_guard.require_staff('reviewer', interval '15 minutes');
  if p_states is null or pg_catalog.cardinality(p_states) = 0 or not (p_states <@ array['submitted', 'under_review', 'approved', 'rejected']::text[]) then
    raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_states';
  end if;
  if (p_after_created_at is null) <> (p_after_id is null) then
    raise exception 'invalid_content' using errcode = 'PT422', detail = 'cursor';
  end if;
  -- oldest first; keyset pagination on (created_at, id); a reviewer never sees submissions they may not review
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'submission_id', t.id, 'version_id', t.version_id, 'hack_id', t.hack_id, 'title', t.title, 'state', t.state, 'submitted_at', t.created_at,
      'content_hash', pg_catalog.encode(t.content_hash, 'hex'), 'latest_decision', t.latest_decision, 'latest_decision_id', t.latest_decision_id) order by t.created_at, t.id)
    from (
      select s.id, s.version_id, s.hack_id, s.created_at, s.content_hash, v.title, l.state,
             (select d.decision from app.moderation_decisions d where d.submission_id = s.id order by d.seq desc limit 1) as latest_decision,
             (select d.id from app.moderation_decisions d where d.submission_id = s.id order by d.seq desc limit 1) as latest_decision_id
        from app.submissions s
        join app.hack_versions v on v.id = s.version_id
        join app.version_lifecycle l on l.version_id = s.version_id
       where l.state = any (p_states)
         and s.submitter_id <> v_staff.user_id
         and not exists (select 1 from app.version_attributions a where a.version_id = s.version_id and a.profile_id = v_staff.user_id)
         and (p_after_created_at is null or (s.created_at, s.id) > (p_after_created_at, p_after_id))
       order by s.created_at, s.id limit v_limit
    ) t), '[]'::jsonb);
end
$$;

create function api.get_submission_for_review(p_submission_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_staff app_guard.staff_actor;
  s app.submissions;
begin
  v_staff := app_guard.require_staff('reviewer', interval '15 minutes');
  select * into s from app.submissions x where x.id = p_submission_id;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  perform app_review.assert_reviewer_ok(s, v_staff.user_id);
  return pg_catalog.jsonb_build_object(
    'submission_id', s.id, 'version_id', s.version_id, 'hack_id', s.hack_id, 'submitted_at', s.created_at,
    'content_hash', pg_catalog.encode(s.content_hash, 'hex'), 'canon_version', s.canon_version,
    'state', (select l.state from app.version_lifecycle l where l.version_id = s.version_id),
    'content', app_content.version_doc(s.version_id),
    'claims', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('claim_no', c.claim_no, 'claim_hash', pg_catalog.encode(app_review.claim_hash(c.version_id, c.claim_no), 'hex')) order by c.claim_no)
                          from app.source_claims c where c.version_id = s.version_id), '[]'::jsonb),
    'assessment', (select pg_catalog.jsonb_build_object('seq', a.seq, 'risk_class', a.risk_class, 'rationale', a.rationale, 'assessed_at', a.assessed_at)
                     from app.version_assessments a where a.submission_id = s.id order by a.seq desc limit 1),
    'rights', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('claim_no', r.claim_no, 'seq', r.seq, 'status', r.status, 'basis_code', r.basis_code, 'expires_on', r.expires_on, 'reviewed_at', r.reviewed_at) order by r.claim_no)
                          from app.rights_reviews r where r.submission_id = s.id
                           and r.seq = (select pg_catalog.max(x.seq) from app.rights_reviews x where x.submission_id = s.id and x.claim_no = r.claim_no)), '[]'::jsonb),
    'decisions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', d.id, 'seq', d.seq, 'decision', d.decision, 'reason_codes', d.reason_codes, 'supersedes_id', d.supersedes_id, 'decided_at', d.decided_at) order by d.seq)
                             from app.moderation_decisions d where d.submission_id = s.id), '[]'::jsonb),
    'unresolved_references', pg_catalog.to_jsonb(app_review.unresolved_references(s.version_id)),
    'approval_blockers', pg_catalog.to_jsonb(app_review.approval_blockers(s.id, v_staff.user_id)));
end
$$;

-- ---- writing -------------------------------------------------------------------------------------------------------------------------
create function api.start_review(p_submission_id uuid, p_expected_hash text) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_staff app_guard.staff_actor;
  s app.submissions;
  v_state text;
begin
  v_staff := app_guard.require_staff('reviewer', interval '15 minutes');
  s := app_review.lock_submission(p_submission_id);
  perform app_review.verify_binding(s, p_expected_hash);
  perform app_review.assert_reviewer_ok(s, v_staff.user_id);
  select l.state into v_state from app.version_lifecycle l where l.version_id = s.version_id for update;
  if v_state = 'submitted' then
    update app.version_lifecycle set state = 'under_review', state_changed_at = pg_catalog.now() where version_id = s.version_id;
    v_state := 'under_review';
  elsif v_state <> 'under_review' then
    raise exception 'invalid_state' using errcode = 'PT409', detail = v_state;
  end if;
  return pg_catalog.jsonb_build_object('submission_id', s.id, 'state', v_state);
end
$$;

create function api.record_risk_assessment(p_submission_id uuid, p_expected_hash text, p_risk_class text, p_rationale text) returns jsonb
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
  begin
    insert into app.version_assessments (submission_id, version_id, content_hash, canon_version, risk_class, rationale, assessed_by)
      values (s.id, s.version_id, s.content_hash, s.canon_version, p_risk_class, app_content.canon_str(p_rationale), v_staff.user_id) returning id, seq into v_id, v_seq;
  exception when check_violation or not_null_violation then
    get stacked diagnostics v_c = constraint_name, v_col = column_name;
    raise exception 'invalid_content' using errcode = 'PT422', detail = coalesce(v_c, v_col, 'assessment');
  end;
  return pg_catalog.jsonb_build_object('assessment_id', v_id, 'seq', v_seq, 'risk_class', p_risk_class);
end
$$;

create function api.record_rights_review(
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

create function api.record_decision(
  p_submission_id uuid, p_expected_hash text, p_decision text, p_reason_codes text[], p_note text, p_expected_prior_decision_id uuid
) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_staff app_guard.staff_actor;
  s app.submissions;
  v_state text;
  v_latest uuid;
  v_blockers text[];
  v_id uuid;
  v_seq integer;
  v_super uuid;
  v_new_state text;
  v_c text;
  v_col text;
begin
  v_staff := app_guard.require_staff('reviewer', interval '15 minutes');
  if p_decision is null or p_decision not in ('PUBLISH', 'REQUEST_CHANGES', 'REJECT', 'HOLD') then
    raise exception 'invalid_content' using errcode = 'PT422', detail = 'decision';
  end if;
  s := app_review.lock_submission(p_submission_id);                       -- every decision of this submission queues here
  perform app_review.verify_binding(s, p_expected_hash);
  perform app_review.assert_reviewer_ok(s, v_staff.user_id);
  select l.state into v_state from app.version_lifecycle l where l.version_id = s.version_id for update;
  if v_state <> all (array['under_review', 'approved', 'rejected']) then raise exception 'invalid_state' using errcode = 'PT409', detail = v_state; end if;
  -- optimistic concurrency: the reviewer says which decision they saw as the latest (NULL = none yet); if another decision landed meanwhile, this is a conflict
  select d.id into v_latest from app.moderation_decisions d where d.submission_id = s.id order by d.seq desc limit 1;
  if v_latest is distinct from p_expected_prior_decision_id then
    raise exception 'decision_conflict' using errcode = 'PT409', detail = coalesce(v_latest::text, 'none');
  end if;
  if p_decision = 'PUBLISH' then
    v_blockers := app_review.approval_blockers(s.id, v_staff.user_id);
    if pg_catalog.cardinality(v_blockers) > 0 then
      raise exception 'approval_blocked' using errcode = 'PT409', detail = pg_catalog.array_to_string(v_blockers, ',');
    end if;
    -- approval additionally needs a recorded reviewer in the full staff role set (the actor's own role is what counts for 'high' risk, handled in the blockers)
  end if;
  begin
    insert into app.moderation_decisions (submission_id, version_id, content_hash, canon_version, decision, reason_codes, note, actor_id)
      values (s.id, s.version_id, s.content_hash, s.canon_version, p_decision, coalesce(p_reason_codes, array[]::text[]), app_content.canon_str(p_note), v_staff.user_id)
      returning id, seq, supersedes_id into v_id, v_seq, v_super;
  exception when check_violation or not_null_violation or invalid_text_representation then
    get stacked diagnostics v_c = constraint_name, v_col = column_name;
    raise exception 'invalid_content' using errcode = 'PT422', detail = coalesce(v_c, v_col, 'decision');
  end;
  v_new_state := case p_decision when 'PUBLISH' then 'approved' when 'REJECT' then 'rejected' else 'under_review' end;
  update app.version_lifecycle set state = v_new_state, state_changed_at = pg_catalog.now() where version_id = s.version_id;
  return pg_catalog.jsonb_build_object('decision_id', v_id, 'seq', v_seq, 'supersedes_id', v_super, 'decision', p_decision, 'state', v_new_state);
end
$$;

revoke all on function api.list_submissions_for_review(integer, text[], timestamptz, uuid), api.get_submission_for_review(uuid), api.start_review(uuid, text),
  api.record_risk_assessment(uuid, text, text, text), api.record_rights_review(uuid, text, integer, text, text, text, date),
  api.record_decision(uuid, text, text, text[], text, uuid) from public;
grant execute on function api.list_submissions_for_review(integer, text[], timestamptz, uuid), api.get_submission_for_review(uuid), api.start_review(uuid, text),
  api.record_risk_assessment(uuid, text, text, text), api.record_rights_review(uuid, text, integer, text, text, text, date),
  api.record_decision(uuid, text, text, text[], text, uuid) to authenticated;

reset role;
