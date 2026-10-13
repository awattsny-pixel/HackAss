-- F2-B (3/4): immutability enforced by the database, not by callers.
--
-- Rules
--   * hack_versions: once frozen_at is set, no UPDATE and no DELETE. The ONLY permitted UPDATE of an unfrozen row besides draft
--     edits is the one-time freeze, in which frozen_at/content_hash/canon_version go NULL -> set, nothing else changes, and the
--     stored hash must equal the hash recomputed from the committed rows at that moment (the trigger recomputes it).
--     Identity columns (id, hack_id, version_no, created_by, created_at) never change.
--   * every hashed child table: INSERT, UPDATE and DELETE are rejected when the parent version is frozen; an UPDATE that moves a
--     row to another version checks BOTH the old and the new parent.
--   * categories: the slug (hashed through category_slug) and id never change; names do.
--   * submissions: append-only.
-- Lock order (one rule everywhere): lock version rows in ascending id order. Draft RPCs and the freeze take FOR UPDATE on the
-- version row; child-row triggers take FOR SHARE on every parent they touch, in ascending id order. A child write and a freeze of
-- the same version therefore serialize on that row, and the trigger re-reads frozen_at AFTER the lock is held: either the child
-- write commits first (and the freeze then hashes it) or the freeze commits first (and the child write is rejected).
-- Error code PT409 (HTTP 409 through PostgREST), message version_frozen.

set local role hackass_owner;

create function app_content.guard_version() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.frozen_at is not null or new.content_hash is not null or new.canon_version is not null then
      raise exception 'version_frozen' using errcode = 'PT409', detail = 'a new version must be an unfrozen draft';
    end if;
    return new;
  end if;
  if old.frozen_at is not null then
    raise exception 'version_frozen' using errcode = 'PT409';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  -- UPDATE of an unfrozen row
  if (new.id, new.hack_id, new.version_no, new.created_by, new.created_at) is distinct from (old.id, old.hack_id, old.version_no, old.created_by, old.created_at) then
    raise exception 'identity_immutable' using errcode = 'PT409';
  end if;
  if new.frozen_at is null then
    if new.content_hash is not null or new.canon_version is not null then
      raise exception 'seal_incomplete' using errcode = 'PT409';
    end if;
    return new;
  end if;
  -- the one-time freeze
  if (pg_catalog.to_jsonb(new) - 'frozen_at' - 'content_hash' - 'canon_version') is distinct from (pg_catalog.to_jsonb(old) - 'frozen_at' - 'content_hash' - 'canon_version') then
    raise exception 'freeze_must_not_change_content' using errcode = 'PT409';
  end if;
  if new.canon_version is distinct from 1 or new.content_hash is distinct from app_content.version_hash(new.id) then
    raise exception 'hash_mismatch' using errcode = 'PT409', detail = 'the stored hash must equal the hash of the committed content';
  end if;
  return new;
end
$$;

create trigger hack_versions_guard before insert or update or delete on app.hack_versions
  for each row execute function app_content.guard_version();

-- One trigger function for all seven hashed child tables (each has a version_id column).
create function app_content.guard_child() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  v_old   uuid;
  v_new   uuid;
  v_ids   uuid[];
  v_found integer;
  v_frozen integer;
  v_cap   integer;
  v_count bigint;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := (pg_catalog.to_jsonb(old) ->> 'version_id')::uuid; end if;
  if tg_op in ('UPDATE', 'INSERT') then v_new := (pg_catalog.to_jsonb(new) ->> 'version_id')::uuid; end if;
  v_ids := array(select distinct x from pg_catalog.unnest(array[v_old, v_new]) as x where x is not null);
  -- lock every affected parent FOR SHARE, ascending id order, then judge frozen_at from the locked rows
  select pg_catalog.count(*), pg_catalog.count(*) filter (where p.frozen_at is not null)
    into v_found, v_frozen
    from (select v.id, v.frozen_at from app.hack_versions v where v.id = any (v_ids) order by v.id for share) p;
  if v_frozen > 0 then
    raise exception 'version_frozen' using errcode = 'PT409';
  end if;
  -- list-size backstop for the three lists that have no position column to bound them (the RPC checks first; this guards every other path)
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or v_new is distinct from v_old) then
    v_cap := case tg_table_name when 'hack_requirements' then 30 when 'version_tags' then 10 when 'version_assets' then 20 else null end;
    if v_cap is not null then
      execute pg_catalog.format('select pg_catalog.count(*) from app.%I where version_id = $1', tg_table_name) into v_count using v_new;
      if v_count >= v_cap then
        raise exception 'limit_exceeded' using errcode = 'PT422', detail = tg_table_name;
      end if;
    end if;
  end if;
  -- a missing parent is fine only for DELETE (the parent row is being deleted and this is the cascade); INSERT/UPDATE fail on the foreign key
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

-- The category slug is part of every hash that includes it, so it never changes (display names stay editable).
create function app_content.guard_category() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if new.slug is distinct from old.slug then
    raise exception 'category_slug_immutable' using errcode = 'PT409';
  end if;
  if new.id is distinct from old.id then
    raise exception 'category_id_immutable' using errcode = 'PT409';
  end if;
  return new;
end
$$;
create trigger categories_guard before update on app.categories for each row execute function app_content.guard_category();

create trigger hack_steps_guard         before insert or update or delete on app.hack_steps         for each row execute function app_content.guard_child();
create trigger hack_materials_guard     before insert or update or delete on app.hack_materials     for each row execute function app_content.guard_child();
create trigger hack_requirements_guard  before insert or update or delete on app.hack_requirements  for each row execute function app_content.guard_child();
create trigger version_tags_guard       before insert or update or delete on app.version_tags       for each row execute function app_content.guard_child();
create trigger version_attributions_guard before insert or update or delete on app.version_attributions for each row execute function app_content.guard_child();
create trigger source_claims_guard      before insert or update or delete on app.source_claims      for each row execute function app_content.guard_child();
create trigger version_assets_guard     before insert or update or delete on app.version_assets     for each row execute function app_content.guard_child();

create function app_content.guard_submission() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'submission_immutable' using errcode = 'PT409';
end
$$;
create trigger submissions_append_only before update or delete on app.submissions
  for each row execute function app_content.guard_submission();

-- TRUNCATE would bypass the row triggers: refuse it on every content table.
create function app_content.guard_truncate() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'truncate_forbidden' using errcode = 'PT409';
end
$$;
create trigger hack_versions_no_truncate        before truncate on app.hack_versions        for each statement execute function app_content.guard_truncate();
create trigger hack_steps_no_truncate           before truncate on app.hack_steps           for each statement execute function app_content.guard_truncate();
create trigger hack_materials_no_truncate       before truncate on app.hack_materials       for each statement execute function app_content.guard_truncate();
create trigger hack_requirements_no_truncate    before truncate on app.hack_requirements    for each statement execute function app_content.guard_truncate();
create trigger version_tags_no_truncate         before truncate on app.version_tags         for each statement execute function app_content.guard_truncate();
create trigger version_attributions_no_truncate before truncate on app.version_attributions for each statement execute function app_content.guard_truncate();
create trigger source_claims_no_truncate        before truncate on app.source_claims        for each statement execute function app_content.guard_truncate();
create trigger version_assets_no_truncate       before truncate on app.version_assets        for each statement execute function app_content.guard_truncate();
create trigger submissions_no_truncate          before truncate on app.submissions          for each statement execute function app_content.guard_truncate();
create trigger categories_no_truncate before truncate on app.categories for each statement execute function app_content.guard_truncate();

revoke all on function app_content.guard_version(), app_content.guard_child(), app_content.guard_submission(), app_content.guard_truncate(), app_content.guard_category() from public;

reset role;
