-- F2-A: authorization through the database guards, exercised as the real Supabase roles (anon, authenticated, service_role)
-- calling the exposed functions the way PostgREST does: the verified claims arrive in request.jwt.claims. Fixture rows are
-- real rows in auth.users / auth.sessions; time-dependent MFA timestamps are set in the claims because a real token cannot
-- be made 20 minutes old inside a test. Real signed-JWT calls through PostgREST are in scripts/local-f2a-checks.mjs.
begin;
select no_plan();

-- ---- helpers (session-local) ------------------------------------------------------------------------------------------
create function pg_temp.act(p_role text, p_sub uuid, p_sid uuid, p_aal text default 'aal1', p_amr jsonb default null, p_anon boolean default false) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_sub, 'session_id', p_sid, 'aal', p_aal, 'amr', p_amr, 'is_anonymous', p_anon))::text, true);
  perform set_config('role', p_role, true);
end $$;
-- Run a statement as hackass_owner (which has no access to the pgTAP schema) and report its result or SQLSTATE.
create function pg_temp.owner_val(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('role', 'hackass_owner', true);
  begin
    execute p_sql into v;
  exception when others then
    perform set_config('role', 'none', true);
    return 'ERR:' || sqlstate;
  end;
  perform set_config('role', 'none', true);
  return coalesce(v, 'NULL');
end $$;
create function pg_temp.amr(p_age interval) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', floor(extract(epoch from now() - p_age))::bigint),
                           jsonb_build_object('method', 'password', 'timestamp', floor(extract(epoch from now() - p_age))::bigint))
$$;
create function pg_temp.fresh() returns jsonb language sql as $$ select pg_temp.amr(interval '30 seconds') $$;

-- ---- fixtures -----------------------------------------------------------------------------------------------------------
-- u1 member, u2 member, u3 reviewer, u4 admin, u5 anonymous Auth user
insert into auth.users (id, aud, role, email, is_anonymous) values
  ('00000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'u1@example.test', false),
  ('00000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'u2@example.test', false),
  ('00000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'u3@example.test', false),
  ('00000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'u4@example.test', false),
  ('00000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', null, true);
insert into auth.sessions (id, user_id) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000004'),
  ('10000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000005');
set local role hackass_owner;
insert into app.staff_assignments (user_id, role, granted_by) values
  ('00000000-0000-4000-8000-000000000003', 'reviewer', 'test fixture'),
  ('00000000-0000-4000-8000-000000000004', 'admin', 'test fixture');
reset role;

-- ---- account lifecycle triggers -----------------------------------------------------------------------------------------
select is((select string_agg(user_id::text || ':' || status, ',' order by user_id::text) from app.accounts where user_id::text like '00000000-0000-4000-8000-00000000000%'),
  '00000000-0000-4000-8000-000000000001:active,00000000-0000-4000-8000-000000000002:active,00000000-0000-4000-8000-000000000003:active,00000000-0000-4000-8000-000000000004:active',
  'inserting Auth users created active accounts, and none for the anonymous user');

-- ---- member guard: the happy path and each way to fail -----------------------------------------------------------------------
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select is(api.whoami(), jsonb_build_object('user_id', '00000000-0000-4000-8000-000000000001', 'session_id', '10000000-0000-4000-8000-000000000001', 'aal', 'aal1'), 'a live session of an active account passes the member guard');
reset role;

select set_config('request.jwt.claims', '', true); set local role authenticated;
select throws_ok($$select api.whoami()$$, '28000', 'not_authenticated', 'no claims at all: not authenticated');
reset role;
select set_config('request.jwt.claims', '{}', true); set local role authenticated;
select throws_ok($$select api.whoami()$$, '28000', 'not_authenticated', 'empty claims: not authenticated');
reset role;
select set_config('request.jwt.claims', 'not json', true); set local role authenticated;
select throws_ok($$select api.whoami()$$, '28000', 'not_authenticated', 'unparseable claims: not authenticated');
reset role;
select pg_temp.act('anon', null, null); set local role anon;
select throws_ok($$select api.whoami()$$, '42501', null, 'the anon role has no EXECUTE on the exposed function (permission denied before any guard runs)');
reset role;
select pg_temp.act('service_role', null, null); set local role service_role;
select throws_ok($$select api.whoami()$$, '42501', null, 'the service_role has no EXECUTE either: the service key cannot call application functions');
reset role;

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"not-a-uuid","session_id":"10000000-0000-4000-8000-000000000001"}', true); set local role authenticated;
select throws_ok($$select api.whoami()$$, '28000', 'not_authenticated', 'malformed subject: not authenticated');
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001"}', true); set local role authenticated;
select throws_ok($$select api.whoami()$$, '28000', 'not_authenticated', 'a token without session_id cannot pass');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000ff');
select throws_ok($$select api.whoami()$$, '28000', 'session_invalid', 'a session id that does not exist (signed out / removed) is rejected even though the token is well-formed');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002');
select throws_ok($$select api.whoami()$$, '28000', 'session_invalid', 'user/session mismatch: user 1 presenting user 2''s live session is rejected');
reset role;

update auth.sessions set not_after = now() - interval '1 minute' where id = '10000000-0000-4000-8000-000000000001';
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select throws_ok($$select api.whoami()$$, '28000', 'session_invalid', 'an expired session is rejected');
reset role;
update auth.sessions set not_after = now() + interval '1 hour' where id = '10000000-0000-4000-8000-000000000001';
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select lives_ok($$select api.whoami()$$, 'a session with a future not_after is accepted');
reset role;

update auth.users set banned_until = now() + interval '1 day' where id = '00000000-0000-4000-8000-000000000001';
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select throws_ok($$select api.whoami()$$, '28000', 'session_invalid', 'a banned user is rejected while the session row and token are still valid');
reset role;
update auth.users set banned_until = now() - interval '1 day' where id = '00000000-0000-4000-8000-000000000001';
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select lives_ok($$select api.whoami()$$, 'an expired ban no longer blocks');
reset role;
update auth.users set deleted_at = now() where id = '00000000-0000-4000-8000-000000000001';
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select throws_ok($$select api.whoami()$$, '28000', 'session_invalid', 'a soft-deleted Auth user is rejected');
reset role;
update auth.users set deleted_at = null where id = '00000000-0000-4000-8000-000000000001';

-- account status (app.accounts is changed only through the owner role)
set local role hackass_owner; update app.accounts set status = 'disabled' where user_id = '00000000-0000-4000-8000-000000000001'; reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select throws_ok($$select api.whoami()$$, '42501', 'account_inactive', 'a disabled account is rejected although its session and token are valid');
reset role;
set local role hackass_owner; update app.accounts set status = 'deleted' where user_id = '00000000-0000-4000-8000-000000000001'; reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select throws_ok($$select api.whoami()$$, '42501', 'account_inactive', 'a deleted account is rejected');
reset role;
set local role hackass_owner; delete from app.accounts where user_id = '00000000-0000-4000-8000-000000000001'; reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select throws_ok($$select api.whoami()$$, '42501', 'account_inactive', 'a user with no account row is rejected');
reset role;
set local role hackass_owner; insert into app.accounts (user_id) values ('00000000-0000-4000-8000-000000000001'); reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select lives_ok($$select api.whoami()$$, 'reactivating the account restores access immediately');
reset role;

select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005', 'aal1', null, true);
select throws_ok($$select api.whoami()$$, '42501', 'anonymous_forbidden', 'an anonymous Auth user cannot pass the member guard');
reset role;

-- ---- direct access to everything behind the exposed functions ---------------------------------------------------------------
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select throws_ok($$select * from app.accounts$$, '42501', null, 'authenticated cannot read app.accounts');
select throws_ok($$select * from app.staff_assignments$$, '42501', null, 'authenticated cannot read staff assignments');
select throws_ok($$insert into app.staff_assignments (user_id, role, granted_by) values ('00000000-0000-4000-8000-000000000001', 'admin', 'self')$$, '42501', null, 'a member cannot grant themselves staff authority');
select throws_ok($$update app.accounts set status = 'active'$$, '42501', null, 'authenticated cannot change account status');
select throws_ok($$select app_guard.require_member()$$, '42501', null, 'the guards themselves are not callable by authenticated');
select throws_ok($$select app_bridge.session_valid('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001')$$, '42501', null, 'the bridge is not callable by authenticated');
select throws_ok($$select worker.healthcheck()$$, '42501', null, 'the worker function is not callable by authenticated');
select throws_ok($$select * from auth.sessions$$, '42501', null, 'authenticated cannot read auth.sessions');
reset role;

-- a hostile search_path cannot redirect the guards (they use only qualified names)
create schema zz_evil;
create table zz_evil.accounts (user_id uuid, status text);
insert into zz_evil.accounts values ('00000000-0000-4000-8000-000000000002', 'active');
set local role hackass_owner; update app.accounts set status = 'disabled' where user_id = '00000000-0000-4000-8000-000000000002'; reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002');
set local search_path = zz_evil, public, extensions;
select throws_ok($$select api.whoami()$$, '42501', 'account_inactive', 'a caller-controlled search_path cannot substitute a lookalike table');
reset role;
reset search_path;
set local role hackass_owner; update app.accounts set status = 'active' where user_id = '00000000-0000-4000-8000-000000000002'; reset role;

-- ---- staff guard -----------------------------------------------------------------------------------------------------------
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', pg_temp.fresh());
select is((api.staff_probe())->'roles', '["reviewer"]'::jsonb, 'a reviewer with aal2 and fresh MFA passes the reviewer tier');
select throws_ok($$select api.staff_probe('admin')$$, '42501', 'not_staff', 'a reviewer does not satisfy the admin tier');
select throws_ok($$select api.staff_probe('owner')$$, '22023', 'invalid_argument', 'an unknown role name is rejected');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 'aal2', pg_temp.fresh());
select is((api.staff_probe('admin'))->'roles', '["admin"]'::jsonb, 'an admin passes the admin tier');
select lives_ok($$select api.staff_probe('reviewer')$$, 'an admin also satisfies the reviewer tier');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'aal2', pg_temp.fresh());
select throws_ok($$select api.staff_probe()$$, '42501', 'not_staff', 'a member with no assignment is not staff, even with aal2');
reset role;

-- MFA strength and freshness
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal1', pg_temp.fresh());
select throws_ok($$select api.staff_probe()$$, '42501', 'mfa_required', 'staff with an aal1 session is refused (insufficient MFA)');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', null);
select throws_ok($$select api.staff_probe()$$, '42501', 'mfa_required', 'aal2 claimed but no amr entries: refused');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now())::bigint)));
select throws_ok($$select api.staff_probe()$$, '42501', 'mfa_required', 'aal2 with only a password entry in amr (no TOTP verification): refused');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', pg_temp.amr(interval '14 minutes'));
select lives_ok($$select api.staff_probe()$$, 'MFA 14 minutes old is inside the 15-minute window');
select throws_ok($$select api.staff_probe('reviewer', 60)$$, '42501', 'mfa_stale', 'the caller may shorten the window: 14 minutes old fails a 60-second window');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', pg_temp.amr(interval '16 minutes'));
select throws_ok($$select api.staff_probe()$$, '42501', 'mfa_stale', 'MFA 16 minutes old is stale');
select throws_ok($$select api.staff_probe('reviewer', 100000)$$, '42501', 'mfa_stale', 'the caller cannot lengthen the window beyond 15 minutes');
select throws_ok($$select api.staff_probe('reviewer', null)$$, '42501', 'mfa_stale', 'a null window falls back to the default, not to unlimited');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', pg_temp.amr(interval '-10 minutes'));
select throws_ok($$select api.staff_probe()$$, '42501', 'mfa_stale', 'an MFA timestamp 10 minutes in the future is refused');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', pg_temp.amr(interval '-1 second'));
select throws_ok($$select api.staff_probe()$$, '42501', 'mfa_stale', 'an MFA timestamp 1 second in the future is refused (no clock-skew allowance)');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', pg_temp.amr(interval '-30 seconds'));
select throws_ok($$select api.staff_probe()$$, '42501', 'mfa_stale', 'an MFA timestamp 30 seconds in the future is refused');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', pg_temp.amr(interval '0 seconds'));
select lives_ok($$select api.staff_probe()$$, 'an MFA timestamp of this very second (never ahead of the database clock) is accepted');
reset role;

-- ---- guard argument validation: fail closed on NULL and out-of-range arguments ---------------------------------------------
-- The guard is called directly as hackass_owner (the only role that can execute it) under valid reviewer claims.
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', pg_temp.fresh());
reset role;
select is(pg_temp.owner_val($$select app_guard.require_staff(null, interval '15 minutes')$$), 'ERR:22023', 'require_staff: a NULL role name is rejected (it used to bypass the role check)');
select is(pg_temp.owner_val($$select app_guard.require_staff('owner', interval '15 minutes')$$), 'ERR:22023', 'require_staff: an unknown role name is rejected');
select is(pg_temp.owner_val($$select app_guard.require_staff('reviewer', null)$$), 'ERR:22023', 'require_staff: a NULL MFA window is rejected (it used to disable the stale-age check)');
select is(pg_temp.owner_val($$select app_guard.require_staff('reviewer', interval '0')$$), 'ERR:22023', 'require_staff: a zero MFA window is rejected');
select is(pg_temp.owner_val($$select app_guard.require_staff('reviewer', interval '-1 minute')$$), 'ERR:22023', 'require_staff: a negative MFA window is rejected');
select is(pg_temp.owner_val($$select app_guard.require_staff('reviewer', interval '15 minutes 1 second')$$), 'ERR:22023', 'require_staff: a window longer than 15 minutes is rejected (the cap is enforced inside the guard)');
select is(pg_temp.owner_val($$select app_guard.require_staff('reviewer', interval '1 day')$$), 'ERR:22023', 'require_staff: a one-day window is rejected');
select ok(pg_temp.owner_val($$select app_guard.require_staff('reviewer', interval '15 minutes')$$) like '(%', 'require_staff: a window of exactly 15 minutes is accepted');
select is(pg_temp.owner_val($$select app_guard.require_staff('reviewer', interval '1 second')$$), 'ERR:42501', 'require_staff: a valid short window still rejects 30-second-old MFA');
select is(pg_temp.owner_val($$select app_guard.require_staff('admin', interval '15 minutes')$$), 'ERR:42501', 'require_staff: valid arguments but an insufficient role are refused as not_staff');
select ok(pg_temp.owner_val($$select app_guard.require_staff()$$) like '(%', 'require_staff: the defaults (reviewer, 15 minutes) work');
select is(pg_temp.owner_val($$select app_guard.require_staff('reviewer', true, interval '15 minutes')$$), 'ERR:42883', 'require_staff: the old optional MFA bypass argument no longer exists');
select is(pg_temp.owner_val($$select app_guard.require_staff('reviewer', false, interval '15 minutes')$$), 'ERR:42883', 'require_staff: MFA cannot be switched off');
select is(
  (select pg_get_function_identity_arguments(p.oid) from pg_proc p where p.proname = 'require_staff' and p.pronamespace = 'app_guard'::regnamespace),
  'p_min_role text, p_max_mfa_age interval', 'require_staff takes exactly (role, MFA window); there is no boolean parameter');

-- the exposed probe passes arguments through the guard: NULL never selects a weaker check
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', pg_temp.fresh());
select throws_ok($$select api.staff_probe(null)$$, '22023', 'invalid_argument', 'api.staff_probe: an explicit NULL role is rejected');
select throws_ok($$select api.staff_probe(null, null)$$, '22023', 'invalid_argument', 'api.staff_probe: NULL role and NULL window are rejected');
select lives_ok($$select api.staff_probe('reviewer', null)$$, 'api.staff_probe: a NULL window means the 15-minute default, never "no limit"');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', pg_temp.amr(interval '16 minutes'));
select throws_ok($$select api.staff_probe('reviewer', null)$$, '42501', 'mfa_stale', 'api.staff_probe: a NULL window does not accept 16-minute-old MFA');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', pg_temp.amr(interval '16 minutes'));
reset role;
select is(pg_temp.owner_val($$select app_guard.require_staff('reviewer', interval '15 minutes')$$), 'ERR:42501', 'require_staff: 16-minute-old MFA is stale at the guard even with the maximum window');

-- staff permission removal and the other prerequisites apply at once
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', pg_temp.fresh());
select lives_ok($$select api.staff_probe()$$, 'before removal the reviewer passes');
reset role;
set local role hackass_owner; update app.staff_assignments set revoked_at = now(), revoked_by = 'test' where user_id = '00000000-0000-4000-8000-000000000003' and revoked_at is null; reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'aal2', pg_temp.fresh());
select throws_ok($$select api.staff_probe()$$, '42501', 'not_staff', 'after the assignment is revoked the same token and session are refused immediately');
reset role;
set local role hackass_owner; update app.accounts set status = 'disabled' where user_id = '00000000-0000-4000-8000-000000000004'; reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 'aal2', pg_temp.fresh());
select throws_ok($$select api.staff_probe()$$, '42501', 'account_inactive', 'an admin whose account is disabled is refused');
reset role;
set local role hackass_owner; update app.accounts set status = 'active' where user_id = '00000000-0000-4000-8000-000000000004'; reset role;
delete from auth.sessions where id = '10000000-0000-4000-8000-000000000004';
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 'aal2', pg_temp.fresh());
select throws_ok($$select api.staff_probe()$$, '28000', 'session_invalid', 'an admin whose session was removed is refused, whatever the token says');
reset role;

-- ---- the bridge as hackass_owner, and table constraints ------------------------------------------------------------------------
select is(pg_temp.owner_val($$select app_bridge.session_valid('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003')$$), 'true', 'hackass_owner can ask the bridge: valid session for its user');
select is(pg_temp.owner_val($$select app_bridge.session_valid('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001')$$), 'false', 'hackass_owner via the bridge: a session paired with another user is not valid');
select is(pg_temp.owner_val($$select app_bridge.session_valid('10000000-0000-4000-8000-0000000000ee', '00000000-0000-4000-8000-000000000003')$$), 'false', 'hackass_owner via the bridge: an unknown session is not valid');
select is(pg_temp.owner_val($$select app_bridge.session_valid(null, null)$$), 'false', 'hackass_owner via the bridge: null arguments are not valid');
select is(pg_temp.owner_val($$select count(*)::text from auth.sessions$$), 'ERR:42501', 'hackass_owner still cannot read auth.sessions directly');
select is(pg_temp.owner_val($$insert into app.staff_assignments (user_id, role, granted_by) values ('00000000-0000-4000-8000-000000000004', 'admin', 'dup')$$), 'ERR:23505', 'at most one active assignment per user and role');
select is(pg_temp.owner_val($$insert into app.staff_assignments (user_id, role, granted_by) values ('00000000-0000-4000-8000-000000000002', 'superuser', 'x')$$), 'ERR:23514', 'only reviewer or admin roles exist');
select is(pg_temp.owner_val($$insert into app.staff_assignments (user_id, role, granted_by, revoked_at) values ('00000000-0000-4000-8000-000000000002', 'reviewer', 'x', now())$$), 'ERR:23514', 'a revocation must record who revoked');
select is(pg_temp.owner_val($$insert into app.staff_assignments (user_id, role, granted_by) values ('00000000-0000-4000-8000-0000000000dd', 'reviewer', 'x')$$), 'ERR:23503', 'staff must be existing accounts');
select is(pg_temp.owner_val($$update app.accounts set status = 'banned' where user_id = '00000000-0000-4000-8000-000000000002'$$), 'ERR:23514', 'account statuses are limited to active, disabled, deleted');

-- ---- deleting an Auth user marks the account deleted and revokes staff authority -------------------------------------------
delete from auth.users where id = '00000000-0000-4000-8000-000000000004';
select is((select status from app.accounts where user_id = '00000000-0000-4000-8000-000000000004'), 'deleted', 'deleting the Auth user marks the account deleted');
select is((select count(*)::int from app.staff_assignments where user_id = '00000000-0000-4000-8000-000000000004' and revoked_at is null), 0, 'and revokes the user''s active staff assignments');

select * from finish();
rollback;
