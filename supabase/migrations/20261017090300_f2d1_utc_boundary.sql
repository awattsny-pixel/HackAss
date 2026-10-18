-- F2-D1 (4/4): the rights-expiry boundary is the UTC calendar day. The F2-C1 approval rule and the F2-C1 rights-review input check used current_date, which
-- follows the SESSION time zone: a session in UTC+14 saw a review that expires today (UTC) as already expired, and a session in UTC-12 accepted an expiry of
-- today (UTC) as still in the future. Both now use app_review.utc_today(), the same UTC boundary the recheck scheduler uses. Same signatures, same owner, same
-- grants (create or replace); the rollback restores the F2-C1 definitions.

set local role hackass_owner;

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
         and (rr.expires_on is null or rr.expires_on >= app_review.utc_today())
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
  if p_expires_on is not null and p_expires_on <= app_review.utc_today() then
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

reset role;
