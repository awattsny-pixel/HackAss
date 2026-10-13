-- F2-A (3/3): the bridge, the guards, two exemplar RPCs, and the worker health function.
--
-- Conventions every function below follows (checked by supabase/tests/database/010_roles_and_grants.test.sql):
--   * SECURITY DEFINER, owner hackass_owner (the bridge is the one exception, owner postgres)
--   * SET search_path = '' and fully qualified references (pg_catalog.*, app.*, app_guard.*, app_bridge.*)
--   * EXECUTE revoked from PUBLIC and granted explicitly; nothing is executable by anon or service_role
--   * the first statement of every api function is a guard call, before any protected work
--
-- Claims: PostgREST puts the verified JWT claims in the request.jwt.claims setting. A signature proves only that the
-- token was issued, not that the session is still alive, so the guard also checks the session, the user and the account
-- inside the database.

-- ---------------------------------------------------------------------------------------------------------------------
-- app_bridge (owner postgres): minimal read of auth state. Returns one boolean; no auth data leaves it.
create function app_bridge.session_valid(p_session_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
      from auth.sessions s
      join auth.users u on u.id = s.user_id
     where s.id = p_session_id
       and s.user_id = p_user_id                                   -- the session must belong to the calling user
       and (s.not_after is null or s.not_after > pg_catalog.now())  -- and must not have expired
       and u.deleted_at is null                                    -- the user must exist and not be deleted
       and (u.banned_until is null or u.banned_until <= pg_catalog.now())
  )
$$;
revoke all on function app_bridge.session_valid(uuid, uuid) from public;
grant execute on function app_bridge.session_valid(uuid, uuid) to hackass_owner;

-- ---------------------------------------------------------------------------------------------------------------------
set local role hackass_owner;

create type app_guard.actor as (user_id uuid, session_id uuid, aal text, mfa_verified_at timestamptz);
create type app_guard.staff_actor as (user_id uuid, session_id uuid, aal text, mfa_verified_at timestamptz, roles text[]);

-- Member guard: a live, user-bound session of an active account. Raises 28000 (not authenticated) or 42501 (forbidden).
create function app_guard.require_member() returns app_guard.actor
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_claims jsonb;
  v_sub    uuid;
  v_sid    uuid;
  v_aal    text;
  v_mfa    timestamptz;
begin
  begin
    v_claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    v_claims := null;
  end;
  if v_claims is null or pg_catalog.jsonb_typeof(v_claims) <> 'object' or (v_claims ->> 'role') is distinct from 'authenticated' then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  begin
    v_sub := (v_claims ->> 'sub')::uuid;
    v_sid := (v_claims ->> 'session_id')::uuid;
  exception when others then
    raise exception 'not_authenticated' using errcode = '28000';
  end;
  if v_sub is null or v_sid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  -- the session must exist, belong to this user, be unexpired, and the user must not be banned or deleted
  if not app_bridge.session_valid(v_sid, v_sub) then
    raise exception 'session_invalid' using errcode = '28000';
  end if;
  if coalesce((v_claims ->> 'is_anonymous')::boolean, false) then
    raise exception 'anonymous_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from app.accounts a where a.user_id = v_sub and a.status = 'active') then
    raise exception 'account_inactive' using errcode = '42501';
  end if;
  v_aal := coalesce(v_claims ->> 'aal', 'aal1');
  if pg_catalog.jsonb_typeof(v_claims -> 'amr') = 'array' then
    select pg_catalog.to_timestamp(pg_catalog.max((e ->> 'timestamp')::double precision))
      into v_mfa
      from pg_catalog.jsonb_array_elements(v_claims -> 'amr') as e
     where pg_catalog.jsonb_typeof(e) = 'object' and e ->> 'method' = 'totp' and (e ->> 'timestamp') ~ '^[0-9]+(\.[0-9]+)?$';
  end if;
  return row(v_sub, v_sid, v_aal, v_mfa)::app_guard.actor;
end
$$;

-- Staff guard: member guard + an active database-held assignment of at least p_min_role + FRESH TOTP MFA. There is no way to
-- switch MFA off and no clock-skew allowance. Arguments fail closed: NULL, an unknown role name, or an MFA window that is not in
-- (0, 15 minutes] raises 22023 (invalid_argument) instead of selecting a weaker check. The cap is enforced HERE, not by callers.
create function app_guard.require_staff(
  p_min_role    text     default 'reviewer',
  p_max_mfa_age interval default interval '15 minutes'
) returns app_guard.staff_actor
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor app_guard.actor;
  v_roles text[];
begin
  v_actor := app_guard.require_member();
  if p_min_role is null or p_min_role not in ('reviewer', 'admin')
     or p_max_mfa_age is null or p_max_mfa_age <= interval '0' or p_max_mfa_age > interval '15 minutes' then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.array_agg(s.role order by s.role), array[]::text[])
    into v_roles
    from app.staff_assignments s
   where s.user_id = v_actor.user_id and s.revoked_at is null;
  if pg_catalog.cardinality(v_roles) = 0 or (p_min_role = 'admin' and not ('admin' = any (v_roles))) then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if v_actor.aal is distinct from 'aal2' or v_actor.mfa_verified_at is null then
    raise exception 'mfa_required' using errcode = '42501';
  end if;
  -- a verification time in the future is never valid, however small the difference
  if v_actor.mfa_verified_at > pg_catalog.now() or pg_catalog.now() - v_actor.mfa_verified_at > p_max_mfa_age then
    raise exception 'mfa_stale' using errcode = '42501';
  end if;
  return row(v_actor.user_id, v_actor.session_id, v_actor.aal, v_actor.mfa_verified_at, v_roles)::app_guard.staff_actor;
end
$$;

-- Exemplar RPC (member tier): proves the guard through a real, directly callable function.
create function api.whoami() returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor app_guard.actor;
begin
  v_actor := app_guard.require_member();
  return pg_catalog.jsonb_build_object('user_id', v_actor.user_id, 'session_id', v_actor.session_id, 'aal', v_actor.aal);
end
$$;

-- Exemplar RPC (staff tier): the caller may only SHORTEN the MFA window (never lengthen it beyond 15 minutes).
create function api.staff_probe(p_min_role text default 'reviewer', p_max_mfa_age_seconds integer default 900) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor app_guard.staff_actor;
begin
  v_actor := app_guard.require_staff(
    p_min_role,
    pg_catalog.make_interval(secs => least(greatest(coalesce(p_max_mfa_age_seconds, 900), 1), 900))
  );
  return pg_catalog.jsonb_build_object('user_id', v_actor.user_id, 'roles', v_actor.roles,
    'mfa_age_seconds', pg_catalog.floor(extract(epoch from (pg_catalog.now() - v_actor.mfa_verified_at))));
end
$$;

-- Worker health function. The caller check is the first statement: only the worker login may use it.
create function worker.healthcheck() returns text
  language plpgsql stable security definer set search_path = ''
as $$
begin
  if session_user <> 'hackass_worker' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return 'ok';
end
$$;

-- Explicit EXECUTE grants (the only ones in this design).
revoke all on function app_guard.require_member(), app_guard.require_staff(text, interval),
                       api.whoami(), api.staff_probe(text, integer), worker.healthcheck() from public;
grant execute on function api.whoami(), api.staff_probe(text, integer) to authenticated;
grant execute on function worker.healthcheck() to hackass_worker;
-- types: no usage for anyone but the owner
revoke all on type app_guard.actor, app_guard.staff_actor from public;

reset role;
