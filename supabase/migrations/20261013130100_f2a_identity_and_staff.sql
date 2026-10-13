-- F2-A (2/3): the minimum identity and staff records the authorization guards need.
-- Staff authority is database-controlled: no application role has any privilege on these tables, and no exposed function
-- changes them. Assignments are changed by operations (SET ROLE hackass_owner) or by later, separately guarded functions.

set local role hackass_owner;

create table app.accounts (
  user_id           uuid        primary key,
  status            text        not null default 'active' check (status in ('active', 'disabled', 'deleted')),
  status_changed_at timestamptz not null default pg_catalog.now(),
  created_at        timestamptz not null default pg_catalog.now()
);
comment on table app.accounts is 'One row per non-anonymous Auth user. Guards require status = active. user_id is NOT a foreign key: the platform does not let the owner reference auth.users; the triggers below keep it in step.';

create table app.staff_assignments (
  id         uuid        primary key default pg_catalog.gen_random_uuid(),
  user_id    uuid        not null references app.accounts (user_id) on delete restrict,
  role       text        not null check (role in ('reviewer', 'admin')),
  granted_at timestamptz not null default pg_catalog.now(),
  granted_by text        not null check (pg_catalog.length(granted_by) between 1 and 200),
  revoked_at timestamptz,
  revoked_by text,
  constraint staff_revocation_complete check ((revoked_at is null) = (revoked_by is null))
);
create unique index staff_assignments_one_active on app.staff_assignments (user_id, role) where revoked_at is null;
create index staff_assignments_user_active on app.staff_assignments (user_id) where revoked_at is null;
comment on table app.staff_assignments is 'Staff authority. Active = revoked_at is null. Changed only through the database owner role.';

-- Defence in depth: RLS on with no policies denies even a role that was later granted table access by mistake.
alter table app.accounts           enable row level security;
alter table app.staff_assignments  enable row level security;
revoke all on app.accounts, app.staff_assignments from public;

-- Keep accounts in step with Auth users. Anonymous users get no account (so they can never pass a guard).
create function app_guard.on_auth_user_created() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if not coalesce(new.is_anonymous, false) then
    insert into app.accounts (user_id) values (new.id) on conflict (user_id) do nothing;
  end if;
  return new;
end
$$;

create function app_guard.on_auth_user_deleted() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  update app.staff_assignments
     set revoked_at = pg_catalog.now(), revoked_by = 'auth-user-deleted'
   where user_id = old.id and revoked_at is null;
  update app.accounts
     set status = 'deleted', status_changed_at = pg_catalog.now()
   where user_id = old.id;
  return old;
end
$$;

revoke all on function app_guard.on_auth_user_created(), app_guard.on_auth_user_deleted() from public;

-- The Auth service fires the triggers, so it alone gets EXECUTE on the two trigger functions (and USAGE on their schema).
grant usage on schema app_guard to supabase_auth_admin;
grant execute on function app_guard.on_auth_user_created(), app_guard.on_auth_user_deleted() to supabase_auth_admin;
-- postgres (which owns the right to add triggers to auth.users) needs EXECUTE only while creating them; revoked again below.
grant execute on function app_guard.on_auth_user_created(), app_guard.on_auth_user_deleted() to postgres;
grant usage on schema app_guard to postgres;

reset role;

create trigger hackass_account_created after insert on auth.users
  for each row execute function app_guard.on_auth_user_created();
create trigger hackass_account_deleted after delete on auth.users
  for each row execute function app_guard.on_auth_user_deleted();

set local role hackass_owner;
revoke execute on function app_guard.on_auth_user_created(), app_guard.on_auth_user_deleted() from postgres;
revoke usage on schema app_guard from postgres;
reset role;
