-- PX-3a (2/4): helper functions
-- Private saving of a member's prompts and reflections. Same conventions as F2: owner hackass_owner, SECURITY DEFINER, empty search_path, guard first, EXECUTE to authenticated only.
-- Draft history: docs/px3/proposed/ (rehearsed before this migration existed).

set local role hackass_owner;

-- ---- helpers --------------------------------------------------------------------------------------------------------------------
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
-- A create stores the receipt it answers with (id, version 1, timestamp): a retried create returns THAT, never the row's later state.
create function app_work.write_prompt(p_owner uuid, p_request_id uuid, p_hash text, d app_work.prompt_doc, p_id uuid, p_expected integer) returns app.saved_prompts
  language plpgsql volatile security definer set search_path = ''
as $$
declare v_row app.saved_prompts%rowtype; v_id uuid; v_now timestamptz;
begin
  if p_id is null then
    if exists (select 1 from app.saved_prompts s where s.owner_id = p_owner and s.request_id = p_request_id) then
      raise exception 'request_reuse' using errcode = 'PT409', detail = 'p_request_id';
    end if;
    if (select pg_catalog.count(*) from app.saved_prompts s where s.owner_id = p_owner) >= 100 then raise exception 'quota_exceeded' using errcode = 'PT429', detail = 'saved_prompts'; end if;
    v_id := pg_catalog.gen_random_uuid(); v_now := pg_catalog.now();
    insert into app.saved_prompts (id, owner_id, request_id, request_hash, request_receipt, title, goal, context, output_format, full_prompt, starting_prompt, origin_kind, origin_slug, origin_title, created_at, updated_at)
    values (v_id, p_owner, p_request_id, p_hash, pg_catalog.jsonb_build_object('id', v_id, 'version', 1, 'updated_at', v_now),
            d.title, d.goal, d.context, d.output_format, d.full_prompt, d.starting_prompt, d.origin_kind, d.origin_slug, d.origin_title, v_now, v_now)
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

-- Writes the result half: the quota checks and the snapshot of what the prompt row says RIGHT NOW (same transaction as the caller's checks), and the receipt.
-- p_combined = true for save_prompt_and_result, whose receipt also records the prompt's id, version and time AT THAT MOMENT.
create function app_work.write_result(p_owner uuid, p_request_id uuid, p_hash text, p app.saved_prompts, d app_work.result_doc, p_combined boolean) returns app.saved_reflections
  language plpgsql volatile security definer set search_path = ''
as $$
declare v_row app.saved_reflections%rowtype; v_id uuid; v_now timestamptz; v_receipt jsonb;
begin
  if exists (select 1 from app.saved_reflections r where r.owner_id = p_owner and r.request_id = p_request_id) then
    raise exception 'request_reuse' using errcode = 'PT409', detail = 'p_request_id';
  end if;
  if (select pg_catalog.count(*) from app.saved_reflections r where r.prompt_id = p.id) >= 50
     or (select pg_catalog.count(*) from app.saved_reflections r where r.owner_id = p_owner) >= 500 then
    raise exception 'quota_exceeded' using errcode = 'PT429', detail = 'saved_reflections';
  end if;
  v_id := pg_catalog.gen_random_uuid(); v_now := pg_catalog.now();
  v_receipt := case when p_combined
    then pg_catalog.jsonb_build_object('prompt', pg_catalog.jsonb_build_object('id', p.id, 'version', p.version, 'updated_at', p.updated_at),
                                       'result', pg_catalog.jsonb_build_object('id', v_id, 'version', 1, 'created_at', v_now))
    else pg_catalog.jsonb_build_object('id', v_id, 'version', 1, 'created_at', v_now, 'prompt_version', p.version) end;
  insert into app.saved_reflections (id, owner_id, prompt_id, request_id, request_hash, request_receipt, outcome, reflection, next_change,
                                     attempted_prompt, starting_prompt, prompt_title, origin_kind, origin_slug, origin_title, prompt_version, created_at, updated_at)
  values (v_id, p_owner, p.id, p_request_id, p_hash, v_receipt, d.outcome, d.reflection, d.next_change,
          p.full_prompt, p.starting_prompt, p.title, p.origin_kind, p.origin_slug, p.origin_title, p.version, v_now, v_now)      -- taken here, never supplied by the client
  returning * into v_row;
  return v_row;
end
$$;


reset role;
