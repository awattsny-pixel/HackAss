-- PX-3a (4/4): erasure of a member's saved work when the Auth user is deleted.
-- app.accounts rows are KEPT (status = 'deleted'), so the foreign-key cascade alone does not fire; this trigger erases the content explicitly.
-- The grants follow the exact F2-A pattern: supabase_auth_admin fires the trigger; postgres (which may add triggers to auth.users) needs EXECUTE only while creating it.
set local role hackass_owner;

create function app_guard.on_auth_user_deleted_content() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  delete from app.saved_prompts where owner_id = old.id;       -- results go with them (cascade)
  return old;
end
$$;
revoke all on function app_guard.on_auth_user_deleted_content() from public;
grant execute on function app_guard.on_auth_user_deleted_content() to supabase_auth_admin;
grant execute on function app_guard.on_auth_user_deleted_content() to postgres;
grant usage on schema app_guard to postgres;
reset role;

create trigger hackass_work_content_deleted after delete on auth.users
  for each row execute function app_guard.on_auth_user_deleted_content();

set local role hackass_owner;
revoke execute on function app_guard.on_auth_user_deleted_content() from postgres;
revoke usage on schema app_guard from postgres;
reset role;
