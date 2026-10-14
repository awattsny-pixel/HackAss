-- F2-C1 (2/3): the rules, as owner-only functions and triggers. The api functions of the third migration call them, and the triggers repeat the
-- important ones, so no future caller of these tables can skip them.
--
-- Lock rule for everything here: lock the submission row FOR UPDATE first; it serializes every review write of that submission (assessments,
-- rights reviews, decisions) and is the only lock these operations take besides the lifecycle row of the same version. The frozen version and its
-- children are immutable and are only read. Freeze (F2-B) runs before the submission exists, so the two never contend.

set local role hackass_owner;

-- ---- helpers -------------------------------------------------------------------------------------------------------------------------
create function app_review.lock_submission(p_submission_id uuid) returns app.submissions
  language plpgsql security definer set search_path = ''
as $$
declare s app.submissions;
begin
  select * into s from app.submissions where id = p_submission_id for update;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  return s;
end
$$;

-- The reviewer names the content hash they reviewed. It must equal the submission's frozen hash AND the hash recomputed from the committed rows.
create function app_review.verify_binding(p_sub app.submissions, p_expected_hash text) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  if p_expected_hash is null or p_expected_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_content' using errcode = 'PT422', detail = 'expected_hash';
  end if;
  if pg_catalog.encode(p_sub.content_hash, 'hex') <> p_expected_hash then
    raise exception 'hash_mismatch' using errcode = 'PT409', detail = 'the reviewed hash is not the submission''s frozen hash';
  end if;
  if p_sub.canon_version <> 1 or app_content.version_hash(p_sub.version_id) is distinct from p_sub.content_hash then
    raise exception 'hash_mismatch' using errcode = 'PT409', detail = 'the stored content no longer hashes to the frozen hash';
  end if;
end
$$;

-- Current database-held staff authority (any role) and no conflict of interest: the submitter, or anyone named as a member author in the content,
-- may not review it.
create function app_review.assert_reviewer_ok(p_sub app.submissions, p_actor uuid) returns void
  language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (select 1 from app.staff_assignments s where s.user_id = p_actor and s.revoked_at is null) then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if p_sub.submitter_id = p_actor
     or exists (select 1 from app.version_attributions a where a.version_id = p_sub.version_id and a.profile_id = p_actor) then
    raise exception 'self_review' using errcode = '42501';
  end if;
end
$$;

-- The canonical line of one source claim (same format as HashCanon-1) and its hash. A rights review is bound to this hash.
create function app_review.claim_line(p_version_id uuid, p_claim_no integer) returns text
  language sql stable security definer set search_path = ''
as $$
  select 'claim;' || c.claim_no || ';' || app_content.fv(app_content.canon_str(c.kind)) || ';' || app_content.fv(app_content.canon_str(c.canonical_url))
         || ';' || app_content.fv(app_content.canon_str(c.source_author)) || ';' || app_content.fv(app_content.canon_str(c.license_spdx))
         || ';' || app_content.fv(app_content.canon_str(c.license_version)) || ';' || app_content.fv(app_content.canon_str(c.permission_note))
         || ';' || app_content.fv(app_content.canon_str(c.asset_rights_note)) || E'\n'
    from app.source_claims c where c.version_id = p_version_id and c.claim_no = p_claim_no
$$;
create function app_review.claim_hash(p_version_id uuid, p_claim_no integer) returns bytea
  language sql stable security definer set search_path = ''
as $$ select app_content.hash_text(app_review.claim_line(p_version_id, p_claim_no)) $$;

-- References that cannot be resolved yet: profiles and the asset store do not exist in this slice, so ANY member-profile attribution or asset
-- is unresolved and keeps the version ineligible for approval. (A later slice replaces this with real existence checks.)
create function app_review.unresolved_references(p_version_id uuid) returns text[]
  language sql stable security definer set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(x order by x), array[]::text[]) from (
    select 'profile_id' as x where exists (select 1 from app.version_attributions a where a.version_id = p_version_id and a.profile_id is not null)
    union all
    select 'asset_id' where exists (select 1 from app.version_assets s where s.version_id = p_version_id)
  ) t
$$;

-- Why a submission cannot be approved right now by this actor ({} = nothing in the way). One definition, used by the RPC, the trigger and the reviewer's view.
create function app_review.approval_blockers(p_submission_id uuid, p_actor uuid) returns text[]
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

-- ---- append-only ----------------------------------------------------------------------------------------------------------------------
create function app_review.guard_append_only() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'record_immutable' using errcode = 'PT409';
end
$$;
create trigger assessments_append_only before update or delete on app.version_assessments for each row execute function app_review.guard_append_only();
create trigger rights_reviews_append_only before update or delete on app.rights_reviews for each row execute function app_review.guard_append_only();
create trigger decisions_append_only before update or delete on app.moderation_decisions for each row execute function app_review.guard_append_only();
create trigger assessments_no_truncate before truncate on app.version_assessments for each statement execute function app_content.guard_truncate();
create trigger rights_reviews_no_truncate before truncate on app.rights_reviews for each statement execute function app_content.guard_truncate();
create trigger decisions_no_truncate before truncate on app.moderation_decisions for each statement execute function app_content.guard_truncate();

-- ---- insert guards: lock the submission, assign the sequence numbers and bindings, repeat the rules -----------------------------------------
create function app_review.guard_assessment() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare s app.submissions;
begin
  s := app_review.lock_submission(new.submission_id);
  perform app_review.assert_reviewer_ok(s, new.assessed_by);
  new.seq := (select coalesce(pg_catalog.max(a.seq), 0) + 1 from app.version_assessments a where a.submission_id = new.submission_id);
  return new;
end
$$;
create trigger assessments_guard before insert on app.version_assessments for each row execute function app_review.guard_assessment();

create function app_review.guard_rights_review() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare s app.submissions;
begin
  s := app_review.lock_submission(new.submission_id);
  perform app_review.assert_reviewer_ok(s, new.reviewer_id);
  new.claim_hash := app_review.claim_hash(new.version_id, new.claim_no);
  if new.claim_hash is null then raise exception 'not_found' using errcode = 'PT404', detail = 'claim'; end if;
  new.seq := (select coalesce(pg_catalog.max(r.seq), 0) + 1 from app.rights_reviews r where r.submission_id = new.submission_id and r.claim_no = new.claim_no);
  return new;
end
$$;
create trigger rights_reviews_guard before insert on app.rights_reviews for each row execute function app_review.guard_rights_review();

create function app_review.guard_decision() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  s app.submissions;
  v_blockers text[];
begin
  s := app_review.lock_submission(new.submission_id);                     -- serializes all decisions of this submission
  perform app_review.assert_reviewer_ok(s, new.actor_id);
  if app_content.version_hash(new.version_id) is distinct from new.content_hash then
    raise exception 'hash_mismatch' using errcode = 'PT409';
  end if;
  new.seq := (select coalesce(pg_catalog.max(d.seq), 0) + 1 from app.moderation_decisions d where d.submission_id = new.submission_id);
  new.supersedes_id := (select d.id from app.moderation_decisions d where d.submission_id = new.submission_id order by d.seq desc limit 1);
  if new.decision = 'PUBLISH' then
    v_blockers := app_review.approval_blockers(new.submission_id, new.actor_id);
    if pg_catalog.cardinality(v_blockers) > 0 then
      raise exception 'approval_blocked' using errcode = 'PT409', detail = pg_catalog.array_to_string(v_blockers, ',');
    end if;
  end if;
  return new;
end
$$;
create trigger decisions_guard before insert on app.moderation_decisions for each row execute function app_review.guard_decision();

revoke all on function app_review.lock_submission(uuid), app_review.verify_binding(app.submissions, text), app_review.assert_reviewer_ok(app.submissions, uuid),
  app_review.claim_line(uuid, integer), app_review.claim_hash(uuid, integer), app_review.unresolved_references(uuid), app_review.approval_blockers(uuid, uuid),
  app_review.guard_append_only(), app_review.guard_assessment(), app_review.guard_rights_review(), app_review.guard_decision() from public;

reset role;
