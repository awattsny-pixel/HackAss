-- F2-D1 (2/3): the job rules, as owner-only functions and triggers. The worker functions of the third migration are thin wrappers over these.
--
-- LOCK PROTOCOL (extends F2-C2's): submission row FOR UPDATE -> hack row FOR NO KEY UPDATE -> version_lifecycle row(s) FOR UPDATE -> job row FOR UPDATE.
-- The job row is LAST. claim / heartbeat / fail touch only the job row (a leaf). complete reads the job WITHOUT a lock to find its target (a job's type and
-- target never change), then takes the protocol's locks for that target, then locks the job row and re-validates the lease; the effect runs only after that.
-- Scheduling (a trigger inside publish / review writes) already holds steps 1-3 when it touches a job row. So a worker and a review writer or publisher
-- can never wait for each other in a cycle.

set local role hackass_owner;

-- ---- job table guard -------------------------------------------------------------------------------------------------------------------
create function app_review.guard_job() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then raise exception 'record_immutable' using errcode = 'PT409'; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'queued' or new.lease_epoch <> 0 or new.retry_count <> 0 or new.outcome is not null then
      raise exception 'invalid_state' using errcode = 'PT409', detail = 'a new job is queued, epoch 0';
    end if;
    return new;
  end if;
  if old.status in ('succeeded', 'failed') then raise exception 'record_immutable' using errcode = 'PT409', detail = 'terminal job'; end if;
  if (new.id, new.job_type, new.target_publication_id, new.created_at, new.max_attempts) is distinct from (old.id, old.job_type, old.target_publication_id, old.created_at, old.max_attempts) then
    raise exception 'identity_immutable' using errcode = 'PT409';
  end if;
  -- the epoch only grows, by exactly one, and only when a lease is taken
  if new.lease_epoch < old.lease_epoch or new.lease_epoch > old.lease_epoch + 1
     or (new.lease_epoch = old.lease_epoch + 1 and new.status <> 'leased') then
    raise exception 'epoch_monotonic' using errcode = 'PT409';
  end if;
  if new.retry_count < old.retry_count then raise exception 'epoch_monotonic' using errcode = 'PT409', detail = 'retry_count'; end if;
  if old.status = 'queued' and new.status not in ('queued', 'leased') then raise exception 'invalid_state' using errcode = 'PT409', detail = 'queued -> ' || new.status; end if;
  return new;
end
$$;
create trigger jobs_guard before insert or update or delete on app.jobs for each row execute function app_review.guard_job();
create trigger jobs_no_truncate before truncate on app.jobs for each statement execute function app_content.guard_truncate();

-- ---- the lease check, one definition ----------------------------------------------------------------------------------------------------
-- THE CLOCK: every deadline in this file is judged with clock_timestamp() (the wall clock at the moment of use), never now(): now() is frozen at the START of
-- the transaction, so a transaction that began before an expiry and then waited (for a lock, say) would otherwise still pass. Callers check the lease after
-- they hold their locks.
-- A lease is good only if the job is leased, at exactly this epoch, and not expired. Anything else is the same error, with no detail about which.
create function app_review.job_assert_lease(p_job app.jobs, p_epoch bigint) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  if p_job.id is null or p_epoch is null or p_job.status <> 'leased' or p_job.lease_epoch <> p_epoch or p_job.lease_expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'lease_lost' using errcode = 'PT409';
  end if;
end
$$;

-- The rights-expiry boundary is the UTC calendar day (scheduling already uses UTC midnight). current_date follows the SESSION time zone, so no eligibility
-- check uses it: they all use this.
create function app_review.utc_today() returns date
  language sql security definer set search_path = ''
as $$ select (pg_catalog.clock_timestamp() at time zone 'UTC')::date $$;

-- ---- scheduling ---------------------------------------------------------------------------------------------------------------------------
-- Make sure a recheck is queued for the first moment the publication's EFFECTIVE rights can lapse (the day after the earliest expires_on). No expiry, no job.
-- An active job that would run too late is pulled earlier; one that is leased is left alone (its completion reschedules from fresh data).
-- Callers hold the submission and hack locks.
create function app_review.job_ensure_recheck(p_pub app.publications) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  e date;
  t timestamptz;
  j app.jobs;
begin
  select pg_catalog.min(rr.expires_on) into e from app.rights_reviews rr where rr.id = any (app_review.effective_rights(p_pub.submission_id)) and rr.expires_on is not null;
  if e is null then return; end if;
  t := (e + 1)::timestamp at time zone 'UTC';
  select * into j from app.jobs x where x.job_type = 'publication_recheck' and x.target_publication_id = p_pub.id and x.status in ('queued', 'leased') for update;
  if not found then
    insert into app.jobs (job_type, target_publication_id, available_at) values ('publication_recheck', p_pub.id, t);
  elsif j.status = 'queued' and j.available_at > t then
    update app.jobs set available_at = t, updated_at = pg_catalog.clock_timestamp() where id = j.id;
  end if;
end
$$;

create function app_review.job_after_publication() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  perform app_review.job_ensure_recheck(new);
  return null;
end
$$;
create trigger publications_schedule_recheck after insert on app.publications for each row execute function app_review.job_after_publication();

-- after_review_write (F2-C2) additionally reschedules the recheck when a rights review changes what is effective and the publication stays eligible
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
  if pg_catalog.cardinality(v_blockers) = 0 then
    if tg_table_name = 'rights_reviews' then perform app_review.job_ensure_recheck(p); end if;
    return null;
  end if;
  v_by := coalesce((pg_catalog.to_jsonb(new) ->> 'actor_id'), (pg_catalog.to_jsonb(new) ->> 'assessed_by'), (pg_catalog.to_jsonb(new) ->> 'reviewer_id'))::uuid;
  perform app_review.withdraw_locked(p, 'review_change', null, null, v_blockers, tg_table_name, new.id, v_by, 'under_review');
  return null;
end
$$;

-- ---- the evidence-note-hash backstop (F2-C2 review follow-up) ----------------------------------------------------------------------------
-- check_publication_children additionally compares each stored publication_rights.evidence_note_hash with the hash of the referenced review's actual note.
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
     or exists (select 1 from app.rights_reviews rr where rr.id = any (v_rights) and (rr.status <> 'clear' or (rr.expires_on is not null and rr.expires_on < app_review.utc_today())))
     or exists (select 1 from app.publication_rights pr join app.rights_reviews rr on rr.id = pr.rights_review_id
                 where pr.publication_id = new.id and pr.evidence_note_hash is distinct from app_content.hash_text(rr.evidence_note)) then
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

-- ---- the worker operations (logic; the worker functions wrap these) --------------------------------------------------------------------
-- Lease length is fixed here (5 minutes); a worker cannot choose it.
create function app_review.job_claim(p_type text) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  j app.jobs;
  v_retry integer;
begin
  if p_type is distinct from 'publication_recheck' then raise exception 'invalid_content' using errcode = 'PT422', detail = 'job_type'; end if;
  loop
    select * into j from app.jobs x
     where x.job_type = p_type and ((x.status = 'queued' and x.available_at <= pg_catalog.clock_timestamp()) or (x.status = 'leased' and x.lease_expires_at <= pg_catalog.clock_timestamp()))
     order by coalesce(x.lease_expires_at, x.available_at), x.id
     limit 1 for update skip locked;
    if not found then return null; end if;
    v_retry := j.retry_count;
    if j.status = 'leased' then                          -- the previous lease expired unanswered: that was an attempt
      v_retry := v_retry + 1;
      if v_retry >= j.max_attempts then
        update app.jobs set status = 'failed', lease_expires_at = null, retry_count = v_retry, last_error_code = 'lease_expired', completed_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp() where id = j.id;
        continue;
      end if;
    end if;
    update app.jobs set status = 'leased', lease_epoch = lease_epoch + 1, lease_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes', retry_count = v_retry, updated_at = pg_catalog.clock_timestamp()
     where id = j.id returning * into j;
    return pg_catalog.jsonb_build_object('job_id', j.id, 'job_type', j.job_type, 'lease_epoch', j.lease_epoch, 'lease_expires_at', j.lease_expires_at, 'attempt', j.retry_count + 1);
  end loop;
end
$$;

create function app_review.job_heartbeat(p_job_id uuid, p_epoch bigint) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare j app.jobs;
begin
  select * into j from app.jobs where id = p_job_id for update;
  perform app_review.job_assert_lease(j, p_epoch);
  update app.jobs set lease_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes', updated_at = pg_catalog.clock_timestamp() where id = j.id returning * into j;
  return pg_catalog.jsonb_build_object('job_id', j.id, 'lease_epoch', j.lease_epoch, 'lease_expires_at', j.lease_expires_at);
end
$$;

-- The subject a worker may see, explicitly allowlisted PER JOB TYPE: ids, a flag and a date. Never content, notes, rationales, names or hashes of notes.
create function app_review.job_subject(p_job_id uuid, p_epoch bigint) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  j app.jobs;
  p app.publications;
begin
  select * into j from app.jobs where id = p_job_id;
  perform app_review.job_assert_lease(j, p_epoch);
  if j.job_type = 'publication_recheck' then
    select * into p from app.publications where id = j.target_publication_id;
    return pg_catalog.jsonb_build_object(
      'job_id', j.id, 'job_type', j.job_type, 'lease_epoch', j.lease_epoch,
      'publication_id', p.id, 'hack_id', p.hack_id, 'version_id', p.version_id,
      'is_current', exists (select 1 from app.hacks h where h.id = p.hack_id and h.current_publication_id = p.id),
      'next_rights_expiry', (select pg_catalog.min(rr.expires_on) from app.rights_reviews rr where rr.id = any (app_review.effective_rights(p.submission_id)) and rr.expires_on is not null));
  end if;
  raise exception 'invalid_state' using errcode = 'PT409', detail = 'job_type';
end
$$;

create function app_review.job_fail(p_job_id uuid, p_epoch bigint, p_error_code text) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  j app.jobs;
  v_retry integer;
begin
  if p_error_code is null or p_error_code not in ('transient', 'internal') then raise exception 'invalid_content' using errcode = 'PT422', detail = 'error_code'; end if;
  select * into j from app.jobs where id = p_job_id for update;
  perform app_review.job_assert_lease(j, p_epoch);
  v_retry := j.retry_count + 1;
  if v_retry >= j.max_attempts then
    update app.jobs set status = 'failed', lease_expires_at = null, retry_count = v_retry, last_error_code = p_error_code, completed_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp() where id = j.id returning * into j;
  else
    update app.jobs set status = 'queued', lease_expires_at = null, retry_count = v_retry, last_error_code = p_error_code,
           available_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => least(30 * pg_catalog.power(2, j.retry_count), 3600)), updated_at = pg_catalog.clock_timestamp()
     where id = j.id returning * into j;
  end if;
  return pg_catalog.jsonb_build_object('job_id', j.id, 'status', j.status, 'retry_count', j.retry_count);
end
$$;

-- The effect of 'publication_recheck': if the target publication is still the current one and anything now blocks it (rights expired, authority lost, ...),
-- withdraw it (cause 'recheck', history kept, pointer cleared, version back to under_review). It can only END a publication: it never sets a pointer.
-- Caller holds the protocol's locks for the target.
create function app_review.job_effect_publication_recheck(p_job app.jobs) returns text
  language plpgsql security definer set search_path = ''
as $$
declare
  p app.publications;
  v_blockers text[];
begin
  select * into p from app.publications where id = p_job.target_publication_id;
  if not exists (select 1 from app.hacks h where h.id = p.hack_id and h.current_publication_id = p.id) then return 'not_current'; end if;
  v_blockers := app_review.publication_blockers(p.submission_id, p.published_by);
  if pg_catalog.cardinality(v_blockers) = 0 then return 'still_eligible'; end if;
  perform app_review.withdraw_locked(p, 'recheck', null, null, v_blockers, 'jobs', p_job.id, null, 'under_review');
  return 'withdrawn';
end
$$;

-- complete = run the effect for THIS job's type and target, then mark it succeeded, in one transaction. The worker names only (job, epoch).
create function app_review.job_complete(p_job_id uuid, p_epoch bigint) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  j app.jobs;
  p app.publications;
  v_outcome text;
begin
  select * into j from app.jobs where id = p_job_id;                      -- unlocked: type and target never change
  if not found or j.status <> 'leased' or j.lease_epoch is distinct from p_epoch then raise exception 'lease_lost' using errcode = 'PT409'; end if;
  select * into p from app.publications where id = j.target_publication_id;
  perform app_review.lock_submission(p.submission_id);                    -- submission row, then hack row
  perform 1 from app.version_lifecycle l where l.version_id = p.version_id for update;
  select * into j from app.jobs where id = p_job_id for update;           -- the job row is last; re-validate the lease under all the locks
  perform app_review.job_assert_lease(j, p_epoch);
  if j.job_type = 'publication_recheck' then
    v_outcome := app_review.job_effect_publication_recheck(j);
  else
    raise exception 'invalid_state' using errcode = 'PT409', detail = 'job_type';
  end if;
  update app.jobs set status = 'succeeded', outcome = v_outcome, lease_expires_at = null, completed_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp() where id = j.id returning * into j;
  if v_outcome = 'still_eligible' then perform app_review.job_ensure_recheck(p); end if;
  return pg_catalog.jsonb_build_object('job_id', j.id, 'status', j.status, 'outcome', v_outcome);
end
$$;

revoke all on function app_review.guard_job(), app_review.job_assert_lease(app.jobs, bigint), app_review.job_ensure_recheck(app.publications), app_review.job_after_publication(), app_review.utc_today(),
  app_review.job_claim(text), app_review.job_heartbeat(uuid, bigint), app_review.job_subject(uuid, bigint), app_review.job_fail(uuid, bigint, text),
  app_review.job_effect_publication_recheck(app.jobs), app_review.job_complete(uuid, bigint) from public;

reset role;
