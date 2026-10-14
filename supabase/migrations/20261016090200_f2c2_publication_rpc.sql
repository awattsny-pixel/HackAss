-- F2-C2 (3/3): the guarded staff RPCs for publication. Every function starts with app_guard.require_staff('reviewer', 15 minutes): a verified live
-- session, an active account, a CURRENT database-held staff assignment, aal2 and TOTP verified within 15 minutes and not in the future. The actor is
-- always the guard's; no function accepts a user id. Lock order is the protocol in the rules migration: submission row, hack row (both inside
-- app_review.lock_submission), then lifecycle rows. High-risk publication needs an admin (the 'risk_high_needs_admin' blocker).
-- Errors: PT404 not_found; PT409 hash_mismatch / invalid_state / decision_conflict / approval_blocked (detail = blockers) / slug_taken;
-- 42501 not_staff, self_review, mfa_required, mfa_stale; PT422 invalid_content (detail = the field, never a value).

set local role hackass_owner;

-- ---- publish -------------------------------------------------------------------------------------------------------------------------
-- The staff member names the content hash and the PUBLISH decision they are publishing (the latest decision of the submission). p_slug is required
-- the first time a hack is published (it becomes the hack's permanent slug) and must be NULL or equal to the existing slug afterwards.
-- Publishing a newer version of a hack that already has a current publication ends the old publication ('superseded') and moves the pointer, atomically.
create function api.publish_version(p_submission_id uuid, p_expected_hash text, p_expected_decision_id uuid, p_slug text) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_staff app_guard.staff_actor;
  s app.submissions;
  v_hack app.hacks;
  v_old app.publications;
  v_old_no integer;
  v_new_no integer;
  v_state text;
  v_latest uuid;
  v_latest_a uuid;
  v_role text;
  v_blockers text[];
  v_rights uuid[];
  v_text text;
  v_pub uuid;
  v_hash bytea;
begin
  v_staff := app_guard.require_staff('reviewer', interval '15 minutes');
  if p_expected_decision_id is null then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_expected_decision_id'; end if;
  s := app_review.lock_submission(p_submission_id);                                  -- submission row, then hack row
  perform app_review.verify_binding(s, p_expected_hash);
  perform app_review.assert_reviewer_ok(s, v_staff.user_id);
  select * into v_hack from app.hacks h where h.id = s.hack_id;
  if v_hack.current_publication_id is not null then
    select * into v_old from app.publications p where p.id = v_hack.current_publication_id;
  end if;
  -- lifecycle rows, ascending version id
  perform 1 from app.version_lifecycle l where l.version_id in (s.version_id, v_old.version_id) order by l.version_id for update;
  select l.state into v_state from app.version_lifecycle l where l.version_id = s.version_id;
  if v_state is distinct from 'approved' then raise exception 'invalid_state' using errcode = 'PT409', detail = coalesce(v_state, 'none'); end if;
  -- the decision: must still be the latest of this submission, a PUBLISH, and not already used
  select d.id into v_latest from app.moderation_decisions d where d.submission_id = s.id order by d.seq desc limit 1;
  if v_latest is distinct from p_expected_decision_id then
    raise exception 'decision_conflict' using errcode = 'PT409', detail = coalesce(v_latest::text, 'none');
  end if;
  if exists (select 1 from app.publications p where p.decision_id = v_latest) then
    raise exception 'invalid_state' using errcode = 'PT409', detail = 'decision_already_published';
  end if;
  v_blockers := app_review.publication_blockers(s.id, v_staff.user_id);
  if pg_catalog.cardinality(v_blockers) > 0 then
    raise exception 'approval_blocked' using errcode = 'PT409', detail = pg_catalog.array_to_string(v_blockers, ',');
  end if;
  -- slug
  if v_hack.slug is null then
    if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or pg_catalog.char_length(p_slug) > 80 then
      raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_slug';
    end if;
  elsif p_slug is not null and p_slug <> v_hack.slug then
    raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_slug';
  end if;
  -- a newer version replaces the current one; an older one needs an explicit withdrawal first
  if v_old.id is not null then
    select v.version_no into v_old_no from app.hack_versions v where v.id = v_old.version_id;
    select v.version_no into v_new_no from app.hack_versions v where v.id = s.version_id;
    if v_new_no <= v_old_no then raise exception 'invalid_state' using errcode = 'PT409', detail = 'newer_version_is_current'; end if;
    perform app_review.withdraw_locked(v_old, 'superseded', null, null, array[]::text[], null, null, v_staff.user_id, 'superseded');
  end if;
  v_role := case when 'admin' = any (v_staff.roles) then 'admin' else 'reviewer' end;
  select a.id into v_latest_a from app.version_assessments a where a.submission_id = s.id order by a.seq desc limit 1;
  v_rights := app_review.effective_rights(s.id);
  v_text := app_review.snapshot_text(s.hack_id, s.version_id, s.id, s.content_hash, s.canon_version, v_latest, v_latest_a, v_staff.user_id, v_role, v_rights);
  v_hash := app_content.hash_text(v_text);
  insert into app.publications (hack_id, version_id, submission_id, content_hash, canon_version, decision_id, assessment_id, published_by, publisher_role,
                                snapshot_format, snapshot_text, snapshot_hash)
    values (s.hack_id, s.version_id, s.id, s.content_hash, s.canon_version, v_latest, v_latest_a, v_staff.user_id, v_role, 'HACKASS-PUB-1', v_text, v_hash)
    returning id into v_pub;
  insert into app.publication_rights (publication_id, submission_id, claim_no, rights_review_id, claim_hash, evidence_note_hash)
    select v_pub, rr.submission_id, rr.claim_no, rr.id, rr.claim_hash, app_content.hash_text(rr.evidence_note)
      from app.rights_reviews rr where rr.id = any (v_rights);
  begin
    update app.hacks set slug = coalesce(slug, p_slug), current_publication_id = v_pub where id = s.hack_id;
  exception when unique_violation then
    raise exception 'slug_taken' using errcode = 'PT409';
  end;
  return pg_catalog.jsonb_build_object('publication_id', v_pub, 'hack_id', s.hack_id, 'version_id', s.version_id, 'decision_id', v_latest,
    'snapshot_hash', pg_catalog.encode(v_hash, 'hex'), 'superseded_publication_id', v_old.id);
end
$$;

-- ---- withdraw ------------------------------------------------------------------------------------------------------------------------
-- Ends the CURRENT publication of a hack: clears the pointer, records who and why, and takes the version out of 'approved' (state 'withdrawn'; a new
-- version is the way back). The publication and its snapshot stay exactly as they were. Any staff member may withdraw (taking content down is the
-- safe direction, so the self-review restriction does not apply).
create function api.withdraw_publication(p_publication_id uuid, p_reason_code text, p_note text) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_staff app_guard.staff_actor;
  p app.publications;
  v_c text;
  v_col text;
begin
  v_staff := app_guard.require_staff('reviewer', interval '15 minutes');
  if p_reason_code is null or p_reason_code not in ('quality', 'safety', 'rights', 'attribution', 'duplicate', 'off_topic', 'spam', 'other') then
    raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_reason_code';
  end if;
  select * into p from app.publications x where x.id = p_publication_id;       -- immutable row: safe to read before locking
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  perform app_review.lock_submission(p.submission_id);                         -- submission row, then hack row
  if not exists (select 1 from app.hacks h where h.id = p.hack_id and h.current_publication_id = p.id) then
    raise exception 'invalid_state' using errcode = 'PT409', detail = 'not_current';
  end if;
  perform 1 from app.version_lifecycle l where l.version_id = p.version_id for update;
  begin
    perform app_review.withdraw_locked(p, 'staff', p_reason_code, app_content.canon_str(p_note), array[]::text[], null, null, v_staff.user_id, 'withdrawn');
  exception when check_violation or not_null_violation then
    get stacked diagnostics v_c = constraint_name, v_col = column_name;
    raise exception 'invalid_content' using errcode = 'PT422', detail = coalesce(v_c, v_col, 'withdrawal');
  end;
  return pg_catalog.jsonb_build_object('publication_id', p.id, 'hack_id', p.hack_id, 'state', 'withdrawn');
end
$$;

-- ---- reading (staff only; publication records are private in this slice) ----------------------------------------------------------------
create function api.get_publication(p_publication_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_staff app_guard.staff_actor;
  p app.publications;
  s app.submissions;
begin
  v_staff := app_guard.require_staff('reviewer', interval '15 minutes');
  select * into p from app.publications x where x.id = p_publication_id;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  select * into s from app.submissions x where x.id = p.submission_id;
  perform app_review.assert_reviewer_ok(s, v_staff.user_id);
  return pg_catalog.jsonb_build_object(
    'publication_id', p.id, 'hack_id', p.hack_id, 'version_id', p.version_id, 'submission_id', p.submission_id,
    'content_hash', pg_catalog.encode(p.content_hash, 'hex'), 'decision_id', p.decision_id, 'assessment_id', p.assessment_id,
    'published_by', p.published_by, 'publisher_role', p.publisher_role, 'published_at', p.published_at,
    'snapshot_format', p.snapshot_format, 'snapshot_text', p.snapshot_text, 'snapshot_hash', pg_catalog.encode(p.snapshot_hash, 'hex'),
    'is_current', exists (select 1 from app.hacks h where h.id = p.hack_id and h.current_publication_id = p.id),
    'rights', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('claim_no', r.claim_no, 'rights_review_id', r.rights_review_id,
                          'claim_hash', pg_catalog.encode(r.claim_hash, 'hex'), 'evidence_note_hash', pg_catalog.encode(r.evidence_note_hash, 'hex')) order by r.claim_no)
                          from app.publication_rights r where r.publication_id = p.id), '[]'::jsonb),
    'withdrawal', (select pg_catalog.jsonb_build_object('cause', w.cause, 'reason_code', w.reason_code, 'blockers', pg_catalog.to_jsonb(w.blockers),
                          'trigger_table', w.trigger_table, 'trigger_id', w.trigger_id, 'withdrawn_by', w.withdrawn_by, 'withdrawn_at', w.withdrawn_at)
                     from app.publication_withdrawals w where w.publication_id = p.id));
end
$$;

revoke all on function api.publish_version(uuid, text, uuid, text), api.withdraw_publication(uuid, text, text), api.get_publication(uuid) from public;
grant execute on function api.publish_version(uuid, text, uuid, text), api.withdraw_publication(uuid, text, text), api.get_publication(uuid) to authenticated;

reset role;
