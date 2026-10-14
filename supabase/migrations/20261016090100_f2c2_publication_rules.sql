-- F2-C2 (2/3): the publication rules, as owner-only functions and triggers. The api functions of the third migration call them, and the triggers
-- repeat the important ones, so no future caller of these tables can skip them.
--
-- ONE LOCK PROTOCOL for everything that can change whether a version is publishable or published (publish, withdraw, and every review write):
--   1. the submission row           FOR UPDATE         \  both taken by app_review.lock_submission(), which every review write already calls first
--   2. the hack row                 FOR NO KEY UPDATE  /  (this migration adds the hack lock there; the hack row is the pointer's owner)
--   3. version_lifecycle row(s)     FOR UPDATE, in ascending version_id order when two are needed (publish that supersedes another version)
-- Nothing takes a lock earlier in this list while holding a later one. Freeze (F2-B) holds hack -> version rows and only INSERTS the new submission
-- row, which nobody can lock yet, so it never waits on step 1. Consequences: (a) two publishes of one hack serialize on the hack row; (b) a publish
-- and any review write of the same submission serialize on the submission row, so a publish sees either all or none of a concurrent rejection, rights
-- revocation or prohibited assessment, and a review write sees a committed publication and withdraws it in the same transaction (after_review_write);
-- (c) publish and withdraw of one publication serialize on the same submission row.

set local role hackass_owner;

-- ---- the hack lock joins lock_submission (same signature; F2-C1 version is restored by the rollback) ----------------------------------------
create or replace function app_review.lock_submission(p_submission_id uuid) returns app.submissions
  language plpgsql security definer set search_path = ''
as $$
declare s app.submissions;
begin
  select * into s from app.submissions where id = p_submission_id for update;               -- step 1
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  perform 1 from app.hacks h where h.id = s.hack_id for no key update;                      -- step 2
  return s;
end
$$;

-- ---- snapshot --------------------------------------------------------------------------------------------------------------------------
-- HACKASS-PUB-1 canonical text (docs/db/f2c2-publication.md). Field encoding is HashCanon-1's fv(): "<utf8 byte length>:<value>" or "-:" for NULL.
-- Everything it needs is read from immutable rows by id, so the text can be recomputed at any time and must equal the stored snapshot_text.
create function app_review.snapshot_text(
  p_hack uuid, p_version uuid, p_submission uuid, p_hash bytea, p_canon smallint, p_decision uuid, p_assessment uuid, p_publisher uuid, p_role text, p_rights uuid[]
) returns text
  language plpgsql stable security definer set search_path = ''
as $$
declare
  d app.moderation_decisions;
  a app.version_assessments;
  t text;
  r record;
begin
  select * into d from app.moderation_decisions x where x.id = p_decision;
  select * into a from app.version_assessments x where x.id = p_assessment;
  t := 'HACKASS-PUB-1' || E'\n'
    || 'target;' || app_content.fv(p_hack::text) || ';' || app_content.fv(p_version::text) || ';' || app_content.fv(p_submission::text) || ';'
    || app_content.fv(pg_catalog.encode(p_hash, 'hex')) || ';' || app_content.fv(p_canon::text) || E'\n'
    || 'decision;' || app_content.fv(d.id::text) || ';' || app_content.fv(d.seq::text) || ';' || app_content.fv(d.decision) || ';' || app_content.fv(d.actor_id::text) || E'\n'
    || 'assessment;' || app_content.fv(a.id::text) || ';' || app_content.fv(a.seq::text) || ';' || app_content.fv(a.risk_class) || E'\n'
    || 'publisher;' || app_content.fv(p_publisher::text) || ';' || app_content.fv(p_role) || E'\n';
  for r in select rr.* from app.rights_reviews rr where rr.id = any (p_rights) order by rr.claim_no loop
    t := t || 'rights;' || r.claim_no::text || ';' || app_content.fv(r.id::text) || ';' || app_content.fv(r.seq::text) || ';'
      || app_content.fv(pg_catalog.encode(r.claim_hash, 'hex')) || ';' || app_content.fv(r.status) || ';' || app_content.fv(r.basis_code) || ';'
      || app_content.fv(pg_catalog.to_char(r.expires_on, 'YYYY-MM-DD')) || ';'
      || app_content.fv(pg_catalog.encode(app_content.hash_text(r.evidence_note), 'hex')) || E'\n';
  end loop;
  return t;
end
$$;

-- The effective (highest seq) rights review of every claim of the submission's version, by claim number.
create function app_review.effective_rights(p_submission_id uuid) returns uuid[]
  language sql stable security definer set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(rr.id order by rr.claim_no), array[]::uuid[])
    from app.rights_reviews rr
   where rr.submission_id = p_submission_id
     and rr.seq = (select pg_catalog.max(x.seq) from app.rights_reviews x where x.submission_id = rr.submission_id and x.claim_no = rr.claim_no)
$$;

-- ---- eligibility -----------------------------------------------------------------------------------------------------------------------
-- Why this submission cannot be (or stay) published for this publisher ({} = nothing in the way). It is the C1 approval check (self review, current
-- assessment, prohibited / high risk needs admin, per-claim rights clear and unexpired against the claim hash, unresolved references) plus: the latest
-- decision must be a PUBLISH by someone other than the submitter or a named author, and the stored content must still hash to the frozen hash.
create function app_review.publication_blockers(p_submission_id uuid, p_actor uuid) returns text[]
  language plpgsql stable security definer set search_path = ''
as $$
declare
  s app.submissions;
  b text[];
  d app.moderation_decisions;
begin
  b := app_review.approval_blockers(p_submission_id, p_actor);
  select * into s from app.submissions x where x.id = p_submission_id;
  if not found then return b; end if;
  select * into d from app.moderation_decisions x where x.submission_id = s.id order by x.seq desc limit 1;
  if d.decision is distinct from 'PUBLISH' then b := pg_catalog.array_append(b, 'decision_not_publish'); end if;
  -- the approving reviewer must not have been the submitter or a named member author either (checked again here, not only when the decision was made)
  if d.id is not null and (d.actor_id = s.submitter_id
       or exists (select 1 from app.version_attributions a where a.version_id = s.version_id and a.profile_id = d.actor_id)) then
    b := pg_catalog.array_append(b, 'decision_self_review');
  end if;
  if s.content_hash is distinct from app_content.version_hash(s.version_id) then b := pg_catalog.array_append(b, 'hash_mismatch'); end if;
  return b;
end
$$;

-- ---- ending a publication (caller holds the locks of the protocol) -----------------------------------------------------------------------
-- Order matters to the triggers: the withdrawal row first, then the pointer, then the lifecycle.
create function app_review.withdraw_locked(
  p_pub app.publications, p_cause text, p_reason text, p_note text, p_blockers text[], p_trigger_table text, p_trigger_id uuid, p_by uuid, p_next_state text
) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  insert into app.publication_withdrawals (publication_id, cause, reason_code, note, blockers, trigger_table, trigger_id, withdrawn_by)
    values (p_pub.id, p_cause, p_reason, p_note, coalesce(p_blockers, array[]::text[]), p_trigger_table, p_trigger_id, p_by);
  update app.hacks set current_publication_id = null where id = p_pub.hack_id and current_publication_id = p_pub.id;
  update app.version_lifecycle set state = p_next_state, state_changed_at = pg_catalog.now() where version_id = p_pub.version_id;
end
$$;

-- ---- append-only ------------------------------------------------------------------------------------------------------------------------
create trigger publications_append_only before update or delete on app.publications for each row execute function app_review.guard_append_only();
create trigger publication_rights_append_only before update or delete on app.publication_rights for each row execute function app_review.guard_append_only();
create trigger publication_withdrawals_append_only before update or delete on app.publication_withdrawals for each row execute function app_review.guard_append_only();
create trigger publications_no_truncate before truncate on app.publications for each statement execute function app_content.guard_truncate();
create trigger publication_rights_no_truncate before truncate on app.publication_rights for each statement execute function app_content.guard_truncate();
create trigger publication_withdrawals_no_truncate before truncate on app.publication_withdrawals for each statement execute function app_content.guard_truncate();

-- ---- insert guards ---------------------------------------------------------------------------------------------------------------------
-- A publication is inserted only under the protocol's locks and only if everything is eligible RIGHT NOW: lifecycle approved, the named decision is the
-- latest decision and a PUBLISH, the named assessment is the latest, no blockers for this publisher, the recorded role is the publisher's actual role,
-- and the stored snapshot is exactly the canonical text of the effective rights reviews.
create function app_review.guard_publication() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  s app.submissions;
  v_state text;
  v_latest uuid;
  v_latest_a uuid;
  v_blockers text[];
  v_role text;
begin
  s := app_review.lock_submission(new.submission_id);
  perform app_review.assert_reviewer_ok(s, new.published_by);
  select l.state into v_state from app.version_lifecycle l where l.version_id = s.version_id;
  if v_state is distinct from 'approved' then raise exception 'invalid_state' using errcode = 'PT409', detail = coalesce(v_state, 'none'); end if;
  select d.id into v_latest from app.moderation_decisions d where d.submission_id = s.id order by d.seq desc limit 1;
  if v_latest is distinct from new.decision_id then raise exception 'decision_conflict' using errcode = 'PT409', detail = coalesce(v_latest::text, 'none'); end if;
  select a.id into v_latest_a from app.version_assessments a where a.submission_id = s.id order by a.seq desc limit 1;
  if v_latest_a is distinct from new.assessment_id then raise exception 'approval_blocked' using errcode = 'PT409', detail = 'assessment_stale'; end if;
  v_blockers := app_review.publication_blockers(s.id, new.published_by);
  if pg_catalog.cardinality(v_blockers) > 0 then
    raise exception 'approval_blocked' using errcode = 'PT409', detail = pg_catalog.array_to_string(v_blockers, ',');
  end if;
  v_role := case when exists (select 1 from app.staff_assignments st where st.user_id = new.published_by and st.role = 'admin' and st.revoked_at is null)
                 then 'admin' else 'reviewer' end;
  if new.publisher_role is distinct from v_role then raise exception 'not_staff' using errcode = '42501', detail = 'publisher_role'; end if;
  if new.snapshot_text is distinct from app_review.snapshot_text(new.hack_id, new.version_id, new.submission_id, new.content_hash, new.canon_version,
       new.decision_id, new.assessment_id, new.published_by, new.publisher_role, app_review.effective_rights(new.submission_id))
     or new.snapshot_hash is distinct from app_content.hash_text(new.snapshot_text) then
    raise exception 'snapshot_mismatch' using errcode = 'PT409';
  end if;
  return new;
end
$$;
create trigger publications_guard before insert on app.publications for each row execute function app_review.guard_publication();

-- At commit: the child rows must be exactly the effective, clear, unexpired rights reviews of every claim, and recomputing the snapshot from them
-- must give the stored text and hash. (A publication without its rights rows, or with the wrong ones, cannot commit.)
create function app_review.check_publication_children() returns trigger
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
create constraint trigger publications_children_check after insert on app.publications deferrable initially deferred
  for each row execute function app_review.check_publication_children();

-- A withdrawal must leave nothing current: at commit its publication is no hack's pointer.
create function app_review.check_withdrawal_cleared() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from app.hacks h where h.current_publication_id = new.publication_id) then
    raise exception 'withdrawal_incomplete' using errcode = 'PT409';
  end if;
  return null;
end
$$;
create constraint trigger withdrawals_cleared_check after insert on app.publication_withdrawals deferrable initially deferred
  for each row execute function app_review.check_withdrawal_cleared();

-- The hack row: identity and slug are write-once, and the pointer moves only the two lawful ways: NULL -> a publication that has not been withdrawn,
-- or a publication -> NULL after its withdrawal row exists. (Pointing at another hack's publication is already impossible: composite foreign key.)
create function app_review.guard_hack() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if (new.id, new.created_by, new.created_at) is distinct from (old.id, old.created_by, old.created_at) then
    raise exception 'identity_immutable' using errcode = 'PT409';
  end if;
  if old.slug is not null and new.slug is distinct from old.slug then
    raise exception 'slug_immutable' using errcode = 'PT409';
  end if;
  if new.current_publication_id is distinct from old.current_publication_id then
    if new.current_publication_id is not null then
      if old.current_publication_id is not null then raise exception 'pointer_must_be_cleared' using errcode = 'PT409'; end if;
      if exists (select 1 from app.publication_withdrawals w where w.publication_id = new.current_publication_id) then
        raise exception 'publication_withdrawn' using errcode = 'PT409';
      end if;
    elsif not exists (select 1 from app.publication_withdrawals w where w.publication_id = old.current_publication_id) then
      raise exception 'withdrawal_required' using errcode = 'PT409';
    end if;
  end if;
  return new;
end
$$;
create trigger hacks_guard before update on app.hacks for each row execute function app_review.guard_hack();

-- ---- later review writes withdraw a publication that they make ineligible, in the same transaction ----------------------------------------
-- Runs after the C1 insert guards (which have already taken the submission and hack locks). The publisher is the actor for the eligibility check.
-- A withdrawal caused by review work returns the version to review (the C1 RPC then sets rejected / under_review as its decision dictates).
create function app_review.after_review_write() returns trigger
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
create trigger decisions_after_write after insert on app.moderation_decisions for each row execute function app_review.after_review_write();
create trigger assessments_after_write after insert on app.version_assessments for each row execute function app_review.after_review_write();
create trigger rights_reviews_after_write after insert on app.rights_reviews for each row execute function app_review.after_review_write();

revoke all on function app_review.snapshot_text(uuid, uuid, uuid, bytea, smallint, uuid, uuid, uuid, text, uuid[]), app_review.effective_rights(uuid),
  app_review.publication_blockers(uuid, uuid), app_review.withdraw_locked(app.publications, text, text, text, text[], text, uuid, uuid, text),
  app_review.guard_publication(), app_review.check_publication_children(), app_review.check_withdrawal_cleared(), app_review.guard_hack(),
  app_review.after_review_write() from public;

reset role;
