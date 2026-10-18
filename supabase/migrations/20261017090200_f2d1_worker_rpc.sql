-- F2-D1 (3/3): the five functions the restricted worker may execute (besides worker.healthcheck). Each one starts by checking that the LOGIN is hackass_worker
-- (session_user, which a SECURITY DEFINER function cannot change), then calls the owner-only logic. They take a job id and a lease epoch: never a target, a
-- type (except claim's type filter), a lease length or free text. hackass_worker holds no table privilege; EXECUTE on these is its only extra privilege.
-- Errors: PT409 lease_lost (wrong, replaced, expired or finished lease; the same error for all of them); PT422 invalid_content; 42501 not_worker.

set local role hackass_owner;

create function worker.claim_job(p_job_type text) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
begin
  if session_user <> 'hackass_worker' then raise exception 'not_worker' using errcode = '42501'; end if;
  return app_review.job_claim(p_job_type);
end
$$;
create function worker.heartbeat_job(p_job_id uuid, p_lease_epoch bigint) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
begin
  if session_user <> 'hackass_worker' then raise exception 'not_worker' using errcode = '42501'; end if;
  return app_review.job_heartbeat(p_job_id, p_lease_epoch);
end
$$;
create function worker.get_job_subject(p_job_id uuid, p_lease_epoch bigint) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
begin
  if session_user <> 'hackass_worker' then raise exception 'not_worker' using errcode = '42501'; end if;
  return app_review.job_subject(p_job_id, p_lease_epoch);
end
$$;
create function worker.complete_job(p_job_id uuid, p_lease_epoch bigint) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
begin
  if session_user <> 'hackass_worker' then raise exception 'not_worker' using errcode = '42501'; end if;
  return app_review.job_complete(p_job_id, p_lease_epoch);
end
$$;
create function worker.fail_job(p_job_id uuid, p_lease_epoch bigint, p_error_code text) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
begin
  if session_user <> 'hackass_worker' then raise exception 'not_worker' using errcode = '42501'; end if;
  return app_review.job_fail(p_job_id, p_lease_epoch, p_error_code);
end
$$;

revoke all on function worker.claim_job(text), worker.heartbeat_job(uuid, bigint), worker.get_job_subject(uuid, bigint), worker.complete_job(uuid, bigint), worker.fail_job(uuid, bigint, text) from public;
grant execute on function worker.claim_job(text), worker.heartbeat_job(uuid, bigint), worker.get_job_subject(uuid, bigint), worker.complete_job(uuid, bigint), worker.fail_job(uuid, bigint, text) to hackass_worker;

reset role;
