-- F1 platform sanity for the real local Supabase stack. This applies no application schema (that is F2). It proves the
-- stack the later database tests depend on is the real thing: the Supabase roles, the Auth schema and its session table,
-- and the extensions the design uses.
begin;
select plan(9);

select has_role('anon', 'role anon exists');
select has_role('authenticated', 'role authenticated exists');
select has_role('service_role', 'role service_role exists (break-glass only; the application runtime never holds it)');
select has_schema('auth', 'Auth schema exists');
select has_table('auth', 'users', 'auth.users exists');
select has_table('auth', 'sessions', 'auth.sessions exists (the in-database revocation check in the foundation design reads it)');
select has_extension('pgcrypto', 'pgcrypto is available');
select ok(exists (select 1 from pg_available_extensions where name = 'citext'), 'citext is available');
select ok(exists (select 1 from pg_available_extensions where name = 'pg_trgm'), 'pg_trgm is available');

select * from finish();
rollback;
