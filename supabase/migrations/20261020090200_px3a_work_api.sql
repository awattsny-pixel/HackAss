-- PX-3a (3/4): the api surface and grants
-- Private saving of a member's prompts and reflections. Same conventions as F2: owner hackass_owner, SECURITY DEFINER, empty search_path, guard first, EXECUTE to authenticated only.
-- Draft history: docs/px3/proposed/ (rehearsed before this migration existed).

set local role hackass_owner;

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
      -- an identical retry: answer with the ORIGINAL receipt (version 1 as first answered), never the row's current version. If the prompt has moved on since,
      -- say so explicitly: the caller must reconcile (a later update with the receipt's version is refused as a conflict) rather than assume its payload is current.
      return v_row.request_receipt || pg_catalog.jsonb_build_object('replay', true, 'superseded', v_row.version > (v_row.request_receipt ->> 'version')::integer);
    end if;
  end if;
  v_row := app_work.write_prompt(v_actor.user_id, p_request_id, v_hash, d, p_id, p_expected_version);
  return case when p_id is null then v_row.request_receipt else pg_catalog.jsonb_build_object('id', v_row.id, 'version', v_row.version, 'updated_at', v_row.updated_at) end;
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
  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) order by p.updated_at desc, p.id desc), pg_catalog.count(*) into v_items, v_n from (
    select s.id, s.title, s.origin_kind, s.origin_slug, s.origin_title, s.version, s.updated_at, pg_catalog.left(s.full_prompt, 160) as snippet
      from app.saved_prompts s
     where s.owner_id = v_actor.user_id                                                       -- the owner filter is ALWAYS applied, cursor or not
       and (p_after_updated_at is null or (s.updated_at, s.id) < (p_after_updated_at, p_after_id))
     order by s.updated_at desc, s.id desc
     limit v_limit + 1) p;
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
    return v_r.request_receipt || pg_catalog.jsonb_build_object('replay', true, 'superseded', v_r.version > 1);   -- an identical retry: the ORIGINAL receipt, flagged if the result was edited since
  end if;
  select * into v_p from app.saved_prompts s where s.id = p_prompt_id and s.owner_id = v_actor.user_id;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  if v_p.version <> p_expected_prompt_version then raise exception 'version_conflict' using errcode = 'PT409', detail = 'saved_prompts'; end if;
  v_r := app_work.write_result(v_actor.user_id, p_request_id, v_hash, v_p, d, false);
  return v_r.request_receipt;
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
    return v_r.request_receipt || pg_catalog.jsonb_build_object('replay', true,
      'superseded', v_r.version > 1 or coalesce((select s.version from app.saved_prompts s where s.id = v_r.prompt_id and s.owner_id = v_r.owner_id), 0) > (v_r.request_receipt -> 'prompt' ->> 'version')::integer);   -- the ORIGINAL receipt, flagged if anything moved on
  end if;
  v_p := app_work.write_prompt(v_actor.user_id, p_request_id, v_hash, pd, p_id, p_expected_version);
  v_r := app_work.write_result(v_actor.user_id, p_request_id, v_hash, v_p, rd, true);              -- any failure here rolls the prompt write back too
  return v_r.request_receipt;
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
  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc, x.id desc), pg_catalog.count(*) into v_items, v_n from (
    select r.id, r.outcome, r.created_at, r.version, r.prompt_id, r.prompt_title as title, r.origin_kind, r.origin_slug, r.origin_title, pg_catalog.left(r.reflection, 160) as snippet
      from app.saved_reflections r
     where r.owner_id = v_actor.user_id
       and (p_outcome is null or r.outcome = p_outcome)
       and (p_after_created_at is null or (r.created_at, r.id) < (p_after_created_at, p_after_id))
     order by r.created_at desc, r.id desc
     limit v_limit + 1) x;
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
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) order by p.id), pg_catalog.count(*) into v_items, v_n from (
      select s.id, s.title, s.goal, s.context, s.output_format, s.full_prompt, s.starting_prompt, s.origin_kind, s.origin_slug, s.origin_title, s.version, s.created_at, s.updated_at
        from app.saved_prompts s where s.owner_id = v_actor.user_id and (p_after_id is null or s.id > p_after_id) order by s.id limit v_limit + 1) p;
  else
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) order by p.id), pg_catalog.count(*) into v_items, v_n from (
      select r.id, r.prompt_id, r.outcome, r.reflection, r.next_change, r.attempted_prompt, r.starting_prompt, r.prompt_title, r.origin_kind, r.origin_slug, r.origin_title, r.prompt_version, r.version, r.created_at, r.updated_at
        from app.saved_reflections r where r.owner_id = v_actor.user_id and (p_after_id is null or r.id > p_after_id) order by r.id limit v_limit + 1) p;
  end if;
  if v_n > v_limit then v_items := v_items - v_limit; v_next := ((v_items -> (v_limit - 1)) ->> 'id')::uuid; end if;
  return pg_catalog.jsonb_build_object('kind', p_kind, 'items', coalesce(v_items, '[]'::jsonb), 'page_size', v_limit, 'next_after_id', v_next);
end
$$;


-- ---- grants (helpers are executable by the owner only; the api functions by `authenticated` only: NOT anon, NOT service_role) ------------------------------------------------------------------------------------------------------------------------
revoke all on function api.save_prompt(uuid, jsonb, uuid, integer), api.get_my_prompt(uuid), api.list_my_prompts(integer, timestamptz, uuid), api.delete_my_prompt(uuid, integer),
  api.save_reflection(uuid, uuid, integer, jsonb), api.save_prompt_and_result(uuid, jsonb, jsonb, uuid, integer), api.update_my_reflection(uuid, integer, jsonb),
  api.delete_my_reflection(uuid, integer), api.list_my_results(integer, text, timestamptz, uuid), api.get_my_result(uuid), api.export_my_data(text, uuid, integer),
  app_work.txt(jsonb, text, integer, integer, boolean), app_work.parse_prompt(jsonb), app_work.parse_result(jsonb), app_work.fingerprint(text), app_work.lock_member(uuid),
  app_work.write_prompt(uuid, uuid, text, app_work.prompt_doc, uuid, integer), app_work.write_result(uuid, uuid, text, app.saved_prompts, app_work.result_doc, boolean) from public;
grant execute on function api.save_prompt(uuid, jsonb, uuid, integer), api.get_my_prompt(uuid), api.list_my_prompts(integer, timestamptz, uuid), api.delete_my_prompt(uuid, integer),
  api.save_reflection(uuid, uuid, integer, jsonb), api.save_prompt_and_result(uuid, jsonb, jsonb, uuid, integer), api.update_my_reflection(uuid, integer, jsonb),
  api.delete_my_reflection(uuid, integer), api.list_my_results(integer, text, timestamptz, uuid), api.get_my_result(uuid), api.export_my_data(text, uuid, integer) to authenticated;   -- NOT anon, NOT service_role
reset role;
