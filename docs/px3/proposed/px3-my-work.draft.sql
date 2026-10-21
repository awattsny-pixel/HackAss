-- PX-3 DRAFT, REVISION 1 (NOT a migration; not in supabase/migrations; not applied anywhere). For review only.
-- Private saving of a member's prompts and reflections, "My results", and a bounded self-service export.
--
-- Conventions followed (F2-A / F2-B / F2-E): tables in `app` owned by hackass_owner, RLS enabled with NO policies and NO grants; helpers in a private schema;
-- every exposed function is in `api`, SECURITY DEFINER, owner hackass_owner, SET search_path = '', fully qualified, EXECUTE revoked from PUBLIC and granted to
-- `authenticated` only, and its FIRST statement is app_guard.require_member(). Identity comes ONLY from the guard; a client never supplies an owner id.
-- Errors: PT404 not_found (missing OR not yours), PT409 version_conflict / request_reuse, PT422 invalid_content (detail = field name, never a value), PT429 quota_exceeded.
--
-- Revision 1 (review of 2026-10-20):
--  1. A reflection records exactly what was tried: save_reflection REQUIRES the expected prompt version (mismatch = PT409), and the result row carries its own
--     snapshot of the prompt text, the starting prompt, the title and the origin; reads of a result never consult the mutable parent for those.
--  2. api.save_prompt_and_result is ONE database operation (one transaction): either both the prompt write and the result are stored, or neither.
--  3. (application) the editor revision handling is specified in the plan; nothing in SQL.
--  4. Create retries are bound to their original payload: an identical retry returns the stored row; the same request id with different content, or a different
--     parent prompt / expected version, is rejected (PT409 request_reuse) instead of silently returning a row that does not contain what was submitted.

-- schemas are created by postgres (hackass_owner has no CREATE on the database), exactly as in F2-A; everything else runs as the owner
create schema app_work authorization hackass_owner;

set local role hackass_owner;
revoke all on schema app_work from public;
comment on schema app_work is 'PX-3: validation, hashing and write helpers for member work. Owner-only.';

-- ---- tables ---------------------------------------------------------------------------------------------------------------------
create table app.saved_prompts (
  id              uuid        primary key default pg_catalog.gen_random_uuid(),
  owner_id        uuid        not null references app.accounts (user_id) on delete cascade,
  request_id      uuid        not null,                                   -- idempotency key for creates
  request_hash    text        not null check (request_hash ~ '^[0-9a-f]{64}$'),   -- sha256 of the CREATING payload: a retry must match it
  title           text        not null check (pg_catalog.char_length(title) between 1 and 120),
  goal            text        not null default '' check (pg_catalog.char_length(goal) <= 2000),
  context         text        not null default '' check (pg_catalog.char_length(context) <= 4000),
  output_format   text        not null check (pg_catalog.char_length(output_format) between 1 and 60),   -- the allowlist lives in the module
  full_prompt     text        not null check (pg_catalog.char_length(full_prompt) <= 20000),
  starting_prompt text        not null default '' check (pg_catalog.char_length(starting_prompt) <= 20000),
  origin_kind     text        not null check (origin_kind in ('scratch', 'catalog', 'demo')),
  origin_slug     text        check (origin_slug is null or (origin_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and pg_catalog.char_length(origin_slug) <= 80)),
  origin_title    text        check (origin_title is null or pg_catalog.char_length(origin_title) <= 200),
  version         integer     not null default 1 check (version >= 1),
  created_at      timestamptz not null default pg_catalog.now(),
  updated_at      timestamptz not null default pg_catalog.now(),
  constraint saved_prompts_origin_slug_iff_catalog check ((origin_kind = 'catalog') = (origin_slug is not null)),
  constraint saved_prompts_request_unique unique (owner_id, request_id),
  constraint saved_prompts_id_owner unique (id, owner_id)
);
create index saved_prompts_by_owner_updated on app.saved_prompts (owner_id, updated_at desc, id desc);

create table app.saved_reflections (
  id               uuid        primary key default pg_catalog.gen_random_uuid(),
  owner_id         uuid        not null references app.accounts (user_id) on delete cascade,
  prompt_id        uuid        not null,
  request_id       uuid        not null,
  request_hash     text        not null check (request_hash ~ '^[0-9a-f]{64}$'),
  outcome          text        not null check (outcome in ('yes', 'partial', 'no', 'notyet')),
  reflection       text        not null default '' check (pg_catalog.char_length(reflection) <= 4000),
  next_change      text        not null default '' check (pg_catalog.char_length(next_change) <= 500),
  -- WHAT WAS ACTUALLY TRIED: copied by the database from the prompt row at save time and never updated afterwards
  attempted_prompt text        not null check (pg_catalog.char_length(attempted_prompt) <= 20000),
  starting_prompt  text        not null default '' check (pg_catalog.char_length(starting_prompt) <= 20000),
  prompt_title     text        not null check (pg_catalog.char_length(prompt_title) between 1 and 120),
  origin_kind      text        not null check (origin_kind in ('scratch', 'catalog', 'demo')),
  origin_slug      text        check (origin_slug is null or (origin_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and pg_catalog.char_length(origin_slug) <= 80)),
  origin_title     text        check (origin_title is null or pg_catalog.char_length(origin_title) <= 200),
  prompt_version   integer     not null check (prompt_version >= 1),
  version          integer     not null default 1 check (version >= 1),
  created_at       timestamptz not null default pg_catalog.now(),
  updated_at       timestamptz not null default pg_catalog.now(),
  constraint saved_reflections_request_unique unique (owner_id, request_id),
  constraint saved_reflections_prompt_same_owner foreign key (prompt_id, owner_id) references app.saved_prompts (id, owner_id) on delete cascade
);
create index saved_reflections_by_owner_created on app.saved_reflections (owner_id, created_at desc, id desc);
create index saved_reflections_by_prompt on app.saved_reflections (prompt_id);

alter table app.saved_prompts     enable row level security;
alter table app.saved_reflections enable row level security;
revoke all on app.saved_prompts, app.saved_reflections from public;

-- ---- helpers --------------------------------------------------------------------------------------------------------------------
create type app_work.prompt_doc as (title text, goal text, context text, output_format text, full_prompt text, starting_prompt text, origin_kind text, origin_slug text, origin_title text);
create type app_work.result_doc as (outcome text, reflection text, next_change text);

-- A text field: a JSON string within bounds (or absent). Never echoes the value.
create function app_work.txt(p jsonb, p_key text, p_min integer, p_max integer, p_required boolean) returns text
  language plpgsql immutable security definer set search_path = ''
as $$
declare v jsonb := p -> p_key;
begin
  if v is null or pg_catalog.jsonb_typeof(v) = 'null' then
    if p_required then raise exception 'invalid_content' using errcode = 'PT422', detail = p_key; end if;
    return null;
  end if;
  if pg_catalog.jsonb_typeof(v) <> 'string' then raise exception 'invalid_content' using errcode = 'PT422', detail = p_key; end if;
  if pg_catalog.char_length(v #>> '{}') < p_min or pg_catalog.char_length(v #>> '{}') > p_max then raise exception 'invalid_content' using errcode = 'PT422', detail = p_key; end if;
  return v #>> '{}';
end
$$;

create function app_work.parse_prompt(p jsonb) returns app_work.prompt_doc
  language plpgsql immutable security definer set search_path = ''
as $$
declare d app_work.prompt_doc;
begin
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' or pg_catalog.octet_length(p::text) > 131072 then raise exception 'invalid_content' using errcode = 'PT422', detail = 'prompt'; end if;
  perform app_content.assert_keys(p, array['title', 'goal', 'context', 'output_format', 'full_prompt', 'starting_prompt', 'origin_kind', 'origin_slug', 'origin_title'], '(root)');
  d.title := app_work.txt(p, 'title', 1, 120, true);  d.goal := coalesce(app_work.txt(p, 'goal', 0, 2000, false), '');  d.context := coalesce(app_work.txt(p, 'context', 0, 4000, false), '');
  d.output_format := app_work.txt(p, 'output_format', 1, 60, true);  d.full_prompt := app_work.txt(p, 'full_prompt', 0, 20000, true);  d.starting_prompt := coalesce(app_work.txt(p, 'starting_prompt', 0, 20000, false), '');
  d.origin_kind := app_work.txt(p, 'origin_kind', 1, 10, true);  d.origin_slug := app_work.txt(p, 'origin_slug', 1, 80, false);  d.origin_title := app_work.txt(p, 'origin_title', 1, 200, false);
  if d.origin_kind not in ('scratch', 'catalog', 'demo') or (d.origin_kind = 'catalog') <> (d.origin_slug is not null) or (d.origin_slug is not null and d.origin_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$') then
    raise exception 'invalid_content' using errcode = 'PT422', detail = 'origin_kind';
  end if;
  return d;
end
$$;

create function app_work.parse_result(p jsonb) returns app_work.result_doc
  language plpgsql immutable security definer set search_path = ''
as $$
declare d app_work.result_doc;
begin
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' or pg_catalog.octet_length(p::text) > 16384 then raise exception 'invalid_content' using errcode = 'PT422', detail = 'result'; end if;
  perform app_content.assert_keys(p, array['outcome', 'reflection', 'next_change'], '(root)');
  d.outcome := app_work.txt(p, 'outcome', 1, 10, true);  d.reflection := coalesce(app_work.txt(p, 'reflection', 0, 4000, false), '');  d.next_change := coalesce(app_work.txt(p, 'next_change', 0, 500, false), '');
  if d.outcome not in ('yes', 'partial', 'no', 'notyet') then raise exception 'invalid_content' using errcode = 'PT422', detail = 'outcome'; end if;
  return d;
end
$$;

-- The payload fingerprint a create is bound to. jsonb text output has a canonical key order, so equal payloads give equal text.
create function app_work.fingerprint(p_text text) returns text
  language sql immutable security definer set search_path = ''
as $$ select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_text, 'UTF8')), 'hex') $$;

-- Serialises one member's writes (quota counts and the retry lookups are race-free) without blocking anyone else.
create function app_work.lock_member(p_user uuid) returns void
  language sql volatile security definer set search_path = ''
as $$ select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app_work:' || p_user::text, 0)) $$;

-- Writes the prompt half of an operation (create or versioned update). Caller holds the member lock and has validated everything.
create function app_work.write_prompt(p_owner uuid, p_request_id uuid, p_hash text, d app_work.prompt_doc, p_id uuid, p_expected integer) returns app.saved_prompts
  language plpgsql volatile security definer set search_path = ''
as $$
declare v_row app.saved_prompts%rowtype;
begin
  if p_id is null then
    if exists (select 1 from app.saved_prompts s where s.owner_id = p_owner and s.request_id = p_request_id) then
      raise exception 'request_reuse' using errcode = 'PT409', detail = 'p_request_id';
    end if;
    if (select pg_catalog.count(*) from app.saved_prompts s where s.owner_id = p_owner) >= 100 then raise exception 'quota_exceeded' using errcode = 'PT429', detail = 'saved_prompts'; end if;
    insert into app.saved_prompts (owner_id, request_id, request_hash, title, goal, context, output_format, full_prompt, starting_prompt, origin_kind, origin_slug, origin_title)
    values (p_owner, p_request_id, p_hash, d.title, d.goal, d.context, d.output_format, d.full_prompt, d.starting_prompt, d.origin_kind, d.origin_slug, d.origin_title)
    returning * into v_row;
  else
    if p_expected is null then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_expected_version'; end if;
    update app.saved_prompts s
       set title = d.title, goal = d.goal, context = d.context, output_format = d.output_format, full_prompt = d.full_prompt, starting_prompt = d.starting_prompt,
           origin_kind = d.origin_kind, origin_slug = d.origin_slug, origin_title = d.origin_title, version = s.version + 1, updated_at = pg_catalog.now()
     where s.id = p_id and s.owner_id = p_owner and s.version = p_expected        -- ownership AND version in the same statement
     returning s.* into v_row;
    if not found then
      if exists (select 1 from app.saved_prompts s where s.id = p_id and s.owner_id = p_owner) then raise exception 'version_conflict' using errcode = 'PT409', detail = 'saved_prompts'; end if;
      raise exception 'not_found' using errcode = 'PT404';
    end if;
  end if;
  return v_row;
end
$$;

-- Writes the result half: the quota checks and the snapshot of what the prompt row says RIGHT NOW (same transaction as the caller's checks).
create function app_work.write_result(p_owner uuid, p_request_id uuid, p_hash text, p app.saved_prompts, d app_work.result_doc) returns app.saved_reflections
  language plpgsql volatile security definer set search_path = ''
as $$
declare v_row app.saved_reflections%rowtype;
begin
  if exists (select 1 from app.saved_reflections r where r.owner_id = p_owner and r.request_id = p_request_id) then
    raise exception 'request_reuse' using errcode = 'PT409', detail = 'p_request_id';
  end if;
  if (select pg_catalog.count(*) from app.saved_reflections r where r.prompt_id = p.id) >= 50
     or (select pg_catalog.count(*) from app.saved_reflections r where r.owner_id = p_owner) >= 500 then
    raise exception 'quota_exceeded' using errcode = 'PT429', detail = 'saved_reflections';
  end if;
  insert into app.saved_reflections (owner_id, prompt_id, request_id, request_hash, outcome, reflection, next_change,
                                     attempted_prompt, starting_prompt, prompt_title, origin_kind, origin_slug, origin_title, prompt_version)
  values (p_owner, p.id, p_request_id, p_hash, d.outcome, d.reflection, d.next_change,
          p.full_prompt, p.starting_prompt, p.title, p.origin_kind, p.origin_slug, p.origin_title, p.version)      -- taken here, never supplied by the client
  returning * into v_row;
  return v_row;
end
$$;

-- ---- api: prompts ---------------------------------------------------------------------------------------------------------------
create function api.save_prompt(p_request_id uuid, p_doc jsonb, p_id uuid default null, p_expected_version integer default null) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare v_actor app_guard.actor; d app_work.prompt_doc; v_hash text; v_row app.saved_prompts%rowtype;
begin
  v_actor := app_guard.require_member();                                    -- FIRST: who is calling, and is the session alive
  if p_request_id is null then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_request_id'; end if;
  d := app_work.parse_prompt(p_doc);
  v_hash := app_work.fingerprint('prompt|' || p_doc::text);
  perform app_work.lock_member(v_actor.user_id);
  if p_id is null then
    select * into v_row from app.saved_prompts s where s.owner_id = v_actor.user_id and s.request_id = p_request_id;
    if found then
      if v_row.request_hash <> v_hash then raise exception 'request_reuse' using errcode = 'PT409', detail = 'p_request_id'; end if;   -- same id, different content: refused
      return pg_catalog.jsonb_build_object('id', v_row.id, 'version', v_row.version, 'updated_at', v_row.updated_at);                  -- an identical retry
    end if;
  end if;
  v_row := app_work.write_prompt(v_actor.user_id, p_request_id, v_hash, d, p_id, p_expected_version);
  return pg_catalog.jsonb_build_object('id', v_row.id, 'version', v_row.version, 'updated_at', v_row.updated_at);
end
$$;

create function api.get_my_prompt(p_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare v_actor app_guard.actor; v app.saved_prompts%rowtype;
begin
  v_actor := app_guard.require_member();
  select * into v from app.saved_prompts s where s.id = p_id and s.owner_id = v_actor.user_id;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  return pg_catalog.jsonb_build_object('id', v.id, 'version', v.version, 'title', v.title, 'goal', v.goal, 'context', v.context, 'output_format', v.output_format,
    'full_prompt', v.full_prompt, 'starting_prompt', v.starting_prompt, 'origin_kind', v.origin_kind, 'origin_slug', v.origin_slug, 'origin_title', v.origin_title,
    'created_at', v.created_at, 'updated_at', v.updated_at,
    'result_count', (select pg_catalog.count(*) from app.saved_reflections r where r.prompt_id = v.id and r.owner_id = v.owner_id));   -- so the delete warning can say how many
end
$$;

create function api.list_my_prompts(p_limit integer default 25, p_after_updated_at timestamptz default null, p_after_id uuid default null) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare v_actor app_guard.actor; v_limit integer := coalesce(p_limit, 25); v_items jsonb; v_n integer; v_next jsonb := null;
begin
  v_actor := app_guard.require_member();
  if v_limit < 1 or v_limit > 100 then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_limit'; end if;
  if (p_after_updated_at is null) <> (p_after_id is null) then raise exception 'invalid_content' using errcode = 'PT422', detail = 'cursor'; end if;
  with page as (
    select s.id, s.title, s.origin_kind, s.origin_slug, s.origin_title, s.version, s.updated_at, pg_catalog.left(s.full_prompt, 160) as snippet
      from app.saved_prompts s
     where s.owner_id = v_actor.user_id                                                       -- the owner filter is ALWAYS applied, cursor or not
       and (p_after_updated_at is null or (s.updated_at, s.id) < (p_after_updated_at, p_after_id))
     order by s.updated_at desc, s.id desc
     limit v_limit + 1)
  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) order by p.updated_at desc, p.id desc), pg_catalog.count(*) into v_items, v_n from page p;
  if v_n > v_limit then
    v_items := v_items - v_limit;
    v_next := pg_catalog.jsonb_build_object('updated_at', (v_items -> (v_limit - 1)) ->> 'updated_at', 'id', (v_items -> (v_limit - 1)) ->> 'id');
  end if;
  return pg_catalog.jsonb_build_object('items', coalesce(v_items, '[]'::jsonb), 'page_size', v_limit, 'next_cursor', v_next);
end
$$;

create function api.delete_my_prompt(p_id uuid, p_expected_version integer) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare v_actor app_guard.actor; v_ok integer; v_results integer;
begin
  v_actor := app_guard.require_member();
  if p_expected_version is null then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_expected_version'; end if;
  perform app_work.lock_member(v_actor.user_id);
  select pg_catalog.count(*) into v_results from app.saved_reflections r where r.prompt_id = p_id and r.owner_id = v_actor.user_id;
  delete from app.saved_prompts s where s.id = p_id and s.owner_id = v_actor.user_id and s.version = p_expected_version;   -- its results go with it (cascade)
  get diagnostics v_ok = row_count;
  if v_ok = 0 then
    if exists (select 1 from app.saved_prompts s where s.id = p_id and s.owner_id = v_actor.user_id) then raise exception 'version_conflict' using errcode = 'PT409', detail = 'saved_prompts'; end if;
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  return pg_catalog.jsonb_build_object('deleted', true, 'results_deleted', v_results);
end
$$;

-- ---- api: results ---------------------------------------------------------------------------------------------------------------
-- Save a result against an EXISTING prompt. The caller states which prompt version it tried; a different current version is refused (PT409): the
-- result must describe what was actually tried, not whatever the prompt has become since.
create function api.save_reflection(p_request_id uuid, p_prompt_id uuid, p_expected_prompt_version integer, p_doc jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare v_actor app_guard.actor; d app_work.result_doc; v_hash text; v_r app.saved_reflections%rowtype; v_p app.saved_prompts%rowtype;
begin
  v_actor := app_guard.require_member();
  if p_request_id is null then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_request_id'; end if;
  if p_prompt_id is null or p_expected_prompt_version is null then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_expected_prompt_version'; end if;
  d := app_work.parse_result(p_doc);
  v_hash := app_work.fingerprint('result|' || p_prompt_id::text || '|' || p_expected_prompt_version::text || '|' || p_doc::text);   -- binds the payload AND the parent AND the version
  perform app_work.lock_member(v_actor.user_id);
  select * into v_r from app.saved_reflections r where r.owner_id = v_actor.user_id and r.request_id = p_request_id;
  if found then
    if v_r.request_hash <> v_hash then raise exception 'request_reuse' using errcode = 'PT409', detail = 'p_request_id'; end if;
    return pg_catalog.jsonb_build_object('id', v_r.id, 'version', v_r.version, 'created_at', v_r.created_at, 'prompt_version', v_r.prompt_version);   -- an identical retry
  end if;
  select * into v_p from app.saved_prompts s where s.id = p_prompt_id and s.owner_id = v_actor.user_id;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  if v_p.version <> p_expected_prompt_version then raise exception 'version_conflict' using errcode = 'PT409', detail = 'saved_prompts'; end if;
  v_r := app_work.write_result(v_actor.user_id, p_request_id, v_hash, v_p, d);
  return pg_catalog.jsonb_build_object('id', v_r.id, 'version', v_r.version, 'created_at', v_r.created_at, 'prompt_version', v_r.prompt_version);
end
$$;

-- "Save prompt and result": ONE operation, ONE transaction. Either the prompt (created, or updated at the expected version) AND the result are stored, or nothing is.
-- One request id binds the whole operation; an identical retry (even after the prompt has moved on) returns what was stored; any change in content, parent or version is refused.
create function api.save_prompt_and_result(p_request_id uuid, p_prompt_doc jsonb, p_result_doc jsonb, p_id uuid default null, p_expected_version integer default null) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare v_actor app_guard.actor; pd app_work.prompt_doc; rd app_work.result_doc; v_hash text; v_p app.saved_prompts%rowtype; v_r app.saved_reflections%rowtype;
begin
  v_actor := app_guard.require_member();
  if p_request_id is null then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_request_id'; end if;
  pd := app_work.parse_prompt(p_prompt_doc);  rd := app_work.parse_result(p_result_doc);          -- everything is validated BEFORE anything is written
  v_hash := app_work.fingerprint('both|' || coalesce(p_id::text, '') || '|' || coalesce(p_expected_version::text, '') || '|' || p_prompt_doc::text || '|' || p_result_doc::text);
  perform app_work.lock_member(v_actor.user_id);
  select * into v_r from app.saved_reflections r where r.owner_id = v_actor.user_id and r.request_id = p_request_id;
  if found then
    if v_r.request_hash <> v_hash then raise exception 'request_reuse' using errcode = 'PT409', detail = 'p_request_id'; end if;
    return pg_catalog.jsonb_build_object('prompt', pg_catalog.jsonb_build_object('id', v_r.prompt_id, 'version', v_r.prompt_version), 'result', pg_catalog.jsonb_build_object('id', v_r.id, 'version', v_r.version, 'created_at', v_r.created_at));
  end if;
  v_p := app_work.write_prompt(v_actor.user_id, p_request_id, v_hash, pd, p_id, p_expected_version);
  v_r := app_work.write_result(v_actor.user_id, p_request_id, v_hash, v_p, rd);                    -- any failure here rolls the prompt write back too
  return pg_catalog.jsonb_build_object('prompt', pg_catalog.jsonb_build_object('id', v_p.id, 'version', v_p.version, 'updated_at', v_p.updated_at),
                                       'result', pg_catalog.jsonb_build_object('id', v_r.id, 'version', v_r.version, 'created_at', v_r.created_at));
end
$$;

-- Edit the member's own words about a result. The snapshot columns are never touched.
create function api.update_my_reflection(p_id uuid, p_expected_version integer, p_doc jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare v_actor app_guard.actor; d app_work.result_doc; v_r app.saved_reflections%rowtype;
begin
  v_actor := app_guard.require_member();
  if p_expected_version is null then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_expected_version'; end if;
  d := app_work.parse_result(p_doc);
  perform app_work.lock_member(v_actor.user_id);
  update app.saved_reflections r set outcome = d.outcome, reflection = d.reflection, next_change = d.next_change, version = r.version + 1, updated_at = pg_catalog.now()
   where r.id = p_id and r.owner_id = v_actor.user_id and r.version = p_expected_version
   returning r.* into v_r;
  if not found then
    if exists (select 1 from app.saved_reflections r where r.id = p_id and r.owner_id = v_actor.user_id) then raise exception 'version_conflict' using errcode = 'PT409', detail = 'saved_reflections'; end if;
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  return pg_catalog.jsonb_build_object('id', v_r.id, 'version', v_r.version, 'updated_at', v_r.updated_at);
end
$$;

create function api.delete_my_reflection(p_id uuid, p_expected_version integer) returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare v_actor app_guard.actor; v_ok integer;
begin
  v_actor := app_guard.require_member();
  if p_expected_version is null then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_expected_version'; end if;
  perform app_work.lock_member(v_actor.user_id);
  delete from app.saved_reflections r where r.id = p_id and r.owner_id = v_actor.user_id and r.version = p_expected_version;
  get diagnostics v_ok = row_count;
  if v_ok = 0 then
    if exists (select 1 from app.saved_reflections r where r.id = p_id and r.owner_id = v_actor.user_id) then raise exception 'version_conflict' using errcode = 'PT409', detail = 'saved_reflections'; end if;
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  return pg_catalog.jsonb_build_object('deleted', true);
end
$$;

-- "My results": reads ONLY the result's own snapshot columns (title, origin, tried prompt), never the mutable parent.
create function api.list_my_results(p_limit integer default 25, p_outcome text default null, p_after_created_at timestamptz default null, p_after_id uuid default null) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare v_actor app_guard.actor; v_limit integer := coalesce(p_limit, 25); v_items jsonb; v_n integer; v_next jsonb := null;
begin
  v_actor := app_guard.require_member();
  if v_limit < 1 or v_limit > 100 then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_limit'; end if;
  if p_outcome is not null and p_outcome not in ('yes', 'partial', 'no', 'notyet') then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_outcome'; end if;
  if (p_after_created_at is null) <> (p_after_id is null) then raise exception 'invalid_content' using errcode = 'PT422', detail = 'cursor'; end if;
  with page as (
    select r.id, r.outcome, r.created_at, r.version, r.prompt_id, r.prompt_title as title, r.origin_kind, r.origin_slug, r.origin_title, pg_catalog.left(r.reflection, 160) as snippet
      from app.saved_reflections r
     where r.owner_id = v_actor.user_id
       and (p_outcome is null or r.outcome = p_outcome)
       and (p_after_created_at is null or (r.created_at, r.id) < (p_after_created_at, p_after_id))
     order by r.created_at desc, r.id desc
     limit v_limit + 1)
  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc, x.id desc), pg_catalog.count(*) into v_items, v_n from page x;
  if v_n > v_limit then
    v_items := v_items - v_limit;
    v_next := pg_catalog.jsonb_build_object('created_at', (v_items -> (v_limit - 1)) ->> 'created_at', 'id', (v_items -> (v_limit - 1)) ->> 'id');
  end if;
  return pg_catalog.jsonb_build_object('items', coalesce(v_items, '[]'::jsonb), 'page_size', v_limit, 'next_cursor', v_next);
end
$$;

create function api.get_my_result(p_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare v_actor app_guard.actor; r app.saved_reflections%rowtype;
begin
  v_actor := app_guard.require_member();
  select * into r from app.saved_reflections x where x.id = p_id and x.owner_id = v_actor.user_id;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  return pg_catalog.jsonb_build_object('id', r.id, 'version', r.version, 'outcome', r.outcome, 'reflection', r.reflection, 'next_change', r.next_change,
    'attempted_prompt', r.attempted_prompt, 'starting_prompt', r.starting_prompt, 'title', r.prompt_title, 'prompt_version', r.prompt_version,
    'origin_kind', r.origin_kind, 'origin_slug', r.origin_slug, 'origin_title', r.origin_title, 'prompt_id', r.prompt_id, 'created_at', r.created_at, 'updated_at', r.updated_at);
end
$$;

-- ---- api: bounded self-service export --------------------------------------------------------------------------------------------
-- Pages of at most 50 rows (default 25), keyset by id, so no single response is unbounded (quota-bounded totals, but a full result row can be ~45 KB).
-- Kinds: 'summary' (counts), 'prompts', 'results'. Only the member's own rows; the same field allowlists as the reads (no owner_id, no request_hash).
create function api.export_my_data(p_kind text, p_after_id uuid default null, p_limit integer default 25) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare v_actor app_guard.actor; v_limit integer := coalesce(p_limit, 25); v_items jsonb; v_n integer; v_next uuid := null;
begin
  v_actor := app_guard.require_member();
  if p_kind is null or p_kind not in ('summary', 'prompts', 'results') then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_kind'; end if;
  if p_kind = 'summary' then
    return pg_catalog.jsonb_build_object('kind', 'summary', 'exported_at', pg_catalog.now(),
      'prompts', (select pg_catalog.count(*) from app.saved_prompts s where s.owner_id = v_actor.user_id),
      'results', (select pg_catalog.count(*) from app.saved_reflections r where r.owner_id = v_actor.user_id));
  end if;
  if v_limit < 1 or v_limit > 50 then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_limit'; end if;
  if p_kind = 'prompts' then
    with page as (select s.id, s.title, s.goal, s.context, s.output_format, s.full_prompt, s.starting_prompt, s.origin_kind, s.origin_slug, s.origin_title, s.version, s.created_at, s.updated_at
                    from app.saved_prompts s where s.owner_id = v_actor.user_id and (p_after_id is null or s.id > p_after_id) order by s.id limit v_limit + 1)
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) order by p.id), pg_catalog.count(*) into v_items, v_n from page p;
  else
    with page as (select r.id, r.prompt_id, r.outcome, r.reflection, r.next_change, r.attempted_prompt, r.starting_prompt, r.prompt_title, r.origin_kind, r.origin_slug, r.origin_title, r.prompt_version, r.version, r.created_at, r.updated_at
                    from app.saved_reflections r where r.owner_id = v_actor.user_id and (p_after_id is null or r.id > p_after_id) order by r.id limit v_limit + 1)
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) order by p.id), pg_catalog.count(*) into v_items, v_n from page p;
  end if;
  if v_n > v_limit then v_items := v_items - v_limit; v_next := ((v_items -> (v_limit - 1)) ->> 'id')::uuid; end if;
  return pg_catalog.jsonb_build_object('kind', p_kind, 'items', coalesce(v_items, '[]'::jsonb), 'page_size', v_limit, 'next_after_id', v_next);
end
$$;

-- ---- erasure when the Auth user is deleted ---------------------------------------------------------------------------------------
-- app.accounts rows are KEPT (status = 'deleted'), so the foreign-key cascade does not fire; this trigger erases the member's content explicitly.
create function app_guard.on_auth_user_deleted_content() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  delete from app.saved_prompts where owner_id = old.id;       -- results go with them (cascade)
  return old;
end
$$;
-- (the grants and the trigger creation on auth.users follow the exact F2-A pattern: supabase_auth_admin EXECUTE; trigger created as postgres)

-- ---- grants ------------------------------------------------------------------------------------------------------------------------
revoke all on function api.save_prompt(uuid, jsonb, uuid, integer), api.get_my_prompt(uuid), api.list_my_prompts(integer, timestamptz, uuid), api.delete_my_prompt(uuid, integer),
  api.save_reflection(uuid, uuid, integer, jsonb), api.save_prompt_and_result(uuid, jsonb, jsonb, uuid, integer), api.update_my_reflection(uuid, integer, jsonb),
  api.delete_my_reflection(uuid, integer), api.list_my_results(integer, text, timestamptz, uuid), api.get_my_result(uuid), api.export_my_data(text, uuid, integer),
  app_work.txt(jsonb, text, integer, integer, boolean), app_work.parse_prompt(jsonb), app_work.parse_result(jsonb), app_work.fingerprint(text), app_work.lock_member(uuid),
  app_work.write_prompt(uuid, uuid, text, app_work.prompt_doc, uuid, integer), app_work.write_result(uuid, uuid, text, app.saved_prompts, app_work.result_doc),
  app_guard.on_auth_user_deleted_content() from public;
grant execute on function api.save_prompt(uuid, jsonb, uuid, integer), api.get_my_prompt(uuid), api.list_my_prompts(integer, timestamptz, uuid), api.delete_my_prompt(uuid, integer),
  api.save_reflection(uuid, uuid, integer, jsonb), api.save_prompt_and_result(uuid, jsonb, jsonb, uuid, integer), api.update_my_reflection(uuid, integer, jsonb),
  api.delete_my_reflection(uuid, integer), api.list_my_results(integer, text, timestamptz, uuid), api.get_my_result(uuid), api.export_my_data(text, uuid, integer) to authenticated;   -- NOT anon, NOT service_role
reset role;
