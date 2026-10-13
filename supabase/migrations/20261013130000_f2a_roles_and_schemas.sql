-- F2-A (1/3): database roles and schemas. Deny by default; every grant below is explicit.
--
-- hackass_owner   NOLOGIN. Owns every application object. Nobody connects as it; SECURITY DEFINER functions run as it.
--                 It holds NO privilege on the Supabase `auth` schema (see app_bridge below).
-- hackass_worker  LOGIN, created WITHOUT a password. A password is set out of band by the operator (never in a migration).
--                 It may execute the functions in schema `worker` and nothing else.
-- postgres        break-glass only. It may SET ROLE hackass_owner (for operations and tests) but does not inherit its rights.
--
-- Schemas
--   app         tables (accounts, staff_assignments): owner-only, no grants to anyone
--   app_guard   authorization guards and trigger functions: owner-only (plus two trigger grants to supabase_auth_admin)
--   api         the RPC surface exposed through PostgREST (supabase/config.toml [api].schemas)
--   worker      the only functions the worker role may execute
--   app_bridge  owned by postgres: the platform does not let postgres delegate USAGE on schema `auth`, so a minimal
--               postgres-owned function answers "is this session valid for this user" for hackass_owner. These are the
--               only objects in this design that postgres owns.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'hackass_owner') then
    create role hackass_owner nologin;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'hackass_worker') then
    create role hackass_worker login;
  end if;
end
$$;

-- Enforce the attributes whether or not the roles pre-existed. (SUPERUSER / REPLICATION / BYPASSRLS cannot be named here by a
-- non-superuser, so they are asserted below instead: the migration fails if any of them is set.)
alter role hackass_owner  with nologin nocreatedb nocreaterole noinherit connection limit 0;
alter role hackass_worker with login   nocreatedb nocreaterole noinherit connection limit 10;

do $$
declare
  v_bad text;
begin
  select pg_catalog.string_agg(rolname, ', ') into v_bad
    from pg_catalog.pg_roles
   where rolname in ('hackass_owner', 'hackass_worker')
     and (rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls or rolinherit);
  if v_bad is not null then
    raise exception 'unexpected privileged attributes on: %', v_bad;
  end if;
end
$$;

-- Session DEFAULTS for the worker (a login can override them with SET; the real limits are its connection limit and its grants):
-- a statement timeout, an idle-transaction timeout, and an empty search_path so it cannot resolve unqualified names by accident.
alter role hackass_worker set statement_timeout = '30s';
alter role hackass_worker set idle_in_transaction_session_timeout = '30s';
alter role hackass_worker set search_path = '';

-- postgres may become hackass_owner (SET) to run operations, but does not inherit its privileges.
grant hackass_owner to postgres with inherit false, set true;

-- Objects created by hackass_owner never get implicit PUBLIC execute / usage.
-- (Run as hackass_owner itself: postgres may SET the role but does not inherit it, so it cannot alter its default privileges.)
set local role hackass_owner;
alter default privileges revoke all on functions from public;
alter default privileges revoke all on tables from public;
alter default privileges revoke all on sequences from public;
alter default privileges revoke all on types from public;
reset role;

create schema app        authorization hackass_owner;
create schema app_guard  authorization hackass_owner;
create schema api        authorization hackass_owner;
create schema worker     authorization hackass_owner;
create schema app_bridge authorization postgres;

-- Grants on the owner's schemas are issued BY the owner (postgres does not inherit its rights).
set local role hackass_owner;
revoke all on schema app, app_guard, api, worker from public;
grant usage on schema api    to anon, authenticated;   -- reaching a function still needs its own EXECUTE grant
grant usage on schema worker to hackass_worker;
comment on schema app       is 'F2-A: application tables. Owner-only; no grants.';
comment on schema app_guard is 'F2-A: authorization guards. Owner-only.';
comment on schema api       is 'F2-A: RPC surface exposed through PostgREST. Every function starts with a guard call.';
comment on schema worker    is 'F2-A: functions the hackass_worker role may execute. No table access exists for that role.';
reset role;

-- app_bridge is postgres-owned.
revoke all on schema app_bridge from public;
grant usage on schema app_bridge to hackass_owner;
comment on schema app_bridge is 'F2-A: postgres-owned minimal read of auth state for hackass_owner.';
