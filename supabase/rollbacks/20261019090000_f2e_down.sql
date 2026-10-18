-- Rollback for the two F2-E migrations (20261019090000, 090100). Apply BY HAND (psql as postgres); rehearsed inside a rolled-back transaction by the chain
-- checks R1..R5 and, COMMITTED and followed by supabase migration up, by scripts/local-f2e-checks.mjs (check R8). F2-D2 and earlier objects stay.
--
-- No table is touched and no row is lost: F2-E adds only functions. After this the public catalog read functions are gone (PostgREST answers 404 for them).
-- Hosted/linked project, afterwards:
--   supabase migration repair --status reverted 20261019090000 20261019090100
begin;

set local role hackass_owner;

drop function if exists api.list_public_hacks(integer, text, text, timestamptz, text);
drop function if exists api.get_public_hack(text);
drop function if exists app_review.public_hack_json(uuid, boolean);
drop function if exists app_review.public_blockers(uuid);

reset role;

delete from supabase_migrations.schema_migrations where version in ('20261019090000', '20261019090100');

commit;
