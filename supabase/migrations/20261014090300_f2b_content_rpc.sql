-- F2-B (4/4): validation, the draft/submit operations, and the exposed RPC surface.
--
-- Every api function: SECURITY DEFINER, owner hackass_owner, search_path = '', first statement = guard call. The caller's identity
-- comes ONLY from app_guard.require_member() (verified session, live account); a client never supplies a user id. Ownership is
-- checked inside each function, and a version the caller does not own is reported as not_found (PT404), indistinguishable from
-- one that does not exist. Error codes: PT404 not_found, PT409 version_frozen / hash_mismatch / open_draft_exists,
-- PT422 invalid_content (detail = field or constraint name, never a submitted value), PT429 too_many_drafts.

set local role hackass_owner;

-- ---- validation and storage of a content document -----------------------------------------------------------------------------
create function app_content.assert_keys(p jsonb, p_allowed text[], p_path text) returns void
  language plpgsql immutable security definer set search_path = ''
as $$
declare v_k text;
begin
  if pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'invalid_content' using errcode = 'PT422', detail = p_path;
  end if;
  select k into v_k from pg_catalog.jsonb_object_keys(p) as k where k <> all (p_allowed) limit 1;
  if v_k is not null then
    raise exception 'invalid_content' using errcode = 'PT422', detail = p_path || '.' || v_k;
  end if;
end
$$;

-- Size limits, checked FIRST (before anything is updated or deleted): the document may not exceed 131072 bytes of JSON text, and each list has a
-- maximum length. The same caps back the position/uniqueness constraints in the tables and the child guard trigger.
create function app_content.assert_limits(p jsonb) returns void
  language plpgsql immutable security definer set search_path = ''
as $$
declare
  v_key text;
  v_cap integer;
begin
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'invalid_content' using errcode = 'PT422', detail = '(root)';
  end if;
  if pg_catalog.octet_length(p::text) > 131072 then
    raise exception 'limit_exceeded' using errcode = 'PT422', detail = 'document';
  end if;
  for v_key, v_cap in select * from (values ('steps', 50), ('materials', 50), ('requirements', 30), ('tags', 10), ('attributions', 10), ('source_claims', 10), ('assets', 20)) t(k, c) loop
    if pg_catalog.jsonb_typeof(p -> v_key) = 'array' and pg_catalog.jsonb_array_length(p -> v_key) > v_cap then
      raise exception 'limit_exceeded' using errcode = 'PT422', detail = v_key;
    end if;
  end loop;
end
$$;

-- Replace the whole content of an UNFROZEN draft with the document. The caller holds the version row lock.
-- Unknown keys are rejected at every level, so nothing privileged (risk class, status, seal columns, owner ids) can be smuggled in.
create function app_content.write_doc(p_version_id uuid, p_doc jsonb) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  v_cat uuid;
  v_slug text;
  r record;
begin
  perform app_content.assert_limits(p_doc);   -- before anything is touched
  perform app_content.assert_keys(p_doc, array['category_slug', 'title', 'summary', 'outcome', 'difficulty', 'time_min_minutes', 'time_max_minutes',
    'cost_min_cents', 'cost_max_cents', 'currency', 'estimate_basis', 'ai_requirement', 'limitations',
    'steps', 'materials', 'requirements', 'tags', 'attributions', 'source_claims', 'assets'], '(root)');
  v_slug := app_content.j_text(p_doc, 'category_slug');
  if v_slug is not null then
    select c.id into v_cat from app.categories c where c.slug = v_slug;
    if v_cat is null then raise exception 'invalid_content' using errcode = 'PT422', detail = 'category_slug'; end if;
  end if;
  update app.hack_versions v set
    category_id = v_cat,
    title = app_content.j_text(p_doc, 'title'), summary = app_content.j_text(p_doc, 'summary'), outcome = app_content.j_text(p_doc, 'outcome'),
    difficulty = app_content.j_text(p_doc, 'difficulty'),
    time_min_minutes = app_content.j_int(p_doc, 'time_min_minutes')::integer, time_max_minutes = app_content.j_int(p_doc, 'time_max_minutes')::integer,
    cost_min_cents = app_content.j_int(p_doc, 'cost_min_cents')::bigint, cost_max_cents = app_content.j_int(p_doc, 'cost_max_cents')::bigint,
    currency = app_content.j_text(p_doc, 'currency'), estimate_basis = app_content.j_text(p_doc, 'estimate_basis'),
    ai_requirement = app_content.j_text(p_doc, 'ai_requirement'), limitations = app_content.j_text(p_doc, 'limitations')
  where v.id = p_version_id;

  delete from app.hack_steps where version_id = p_version_id;
  delete from app.hack_materials where version_id = p_version_id;
  delete from app.hack_requirements where version_id = p_version_id;
  delete from app.version_tags where version_id = p_version_id;
  delete from app.version_attributions where version_id = p_version_id;
  delete from app.source_claims where version_id = p_version_id;
  delete from app.version_assets where version_id = p_version_id;

  for r in select a.pos, a.item from app_content.j_arr(p_doc, 'steps') a loop
    if pg_catalog.jsonb_typeof(r.item) <> 'string' then raise exception 'invalid_content' using errcode = 'PT422', detail = 'steps'; end if;
    insert into app.hack_steps (version_id, position, body) values (p_version_id, r.pos, app_content.canon_str(r.item #>> '{}'));
  end loop;
  for r in select a.pos, a.item from app_content.j_arr(p_doc, 'materials') a loop
    perform app_content.assert_keys(r.item, array['name', 'detail'], 'materials');
    insert into app.hack_materials (version_id, position, name, detail) values (p_version_id, r.pos, app_content.j_text(r.item, 'name'), app_content.j_text(r.item, 'detail'));
  end loop;
  for r in select a.pos, a.item from app_content.j_arr(p_doc, 'requirements') a loop
    perform app_content.assert_keys(r.item, array['kind', 'name', 'detail'], 'requirements');
    insert into app.hack_requirements (version_id, kind, name, detail) values (p_version_id, app_content.j_text(r.item, 'kind'), app_content.j_text(r.item, 'name'), app_content.j_text(r.item, 'detail'));
  end loop;
  for r in select a.pos, a.item from app_content.j_arr(p_doc, 'tags') a loop
    if pg_catalog.jsonb_typeof(r.item) <> 'string' then raise exception 'invalid_content' using errcode = 'PT422', detail = 'tags'; end if;
    insert into app.version_tags (version_id, slug) values (p_version_id, app_content.canon_str(r.item #>> '{}'));
  end loop;
  for r in select a.pos, a.item from app_content.j_arr(p_doc, 'attributions') a loop
    perform app_content.assert_keys(r.item, array['role', 'profile_id', 'external_name', 'external_url'], 'attributions');
    insert into app.version_attributions (version_id, attribution_no, role, profile_id, external_name, external_url)
      values (p_version_id, r.pos, app_content.j_text(r.item, 'role'), app_content.j_uuid(r.item, 'profile_id')::uuid, app_content.j_text(r.item, 'external_name'), app_content.j_text(r.item, 'external_url'));
  end loop;
  for r in select a.pos, a.item from app_content.j_arr(p_doc, 'source_claims') a loop
    perform app_content.assert_keys(r.item, array['kind', 'canonical_url', 'source_author', 'license_spdx', 'license_version', 'permission_note', 'asset_rights_note'], 'source_claims');
    insert into app.source_claims (version_id, claim_no, kind, canonical_url, source_author, license_spdx, license_version, permission_note, asset_rights_note)
      values (p_version_id, r.pos, app_content.j_text(r.item, 'kind'), app_content.j_text(r.item, 'canonical_url'), app_content.j_text(r.item, 'source_author'),
              app_content.j_text(r.item, 'license_spdx'), app_content.j_text(r.item, 'license_version'), app_content.j_text(r.item, 'permission_note'), app_content.j_text(r.item, 'asset_rights_note'));
  end loop;
  for r in select a.pos, a.item from app_content.j_arr(p_doc, 'assets') a loop
    perform app_content.assert_keys(r.item, array['asset_id', 'sha256'], 'assets');
    if app_content.j_hex64(r.item, 'sha256') is null then raise exception 'invalid_content' using errcode = 'PT422', detail = 'sha256'; end if;
    insert into app.version_assets (version_id, sha256, asset_id)
      values (p_version_id, pg_catalog.decode(app_content.j_hex64(r.item, 'sha256'), 'hex'), app_content.j_uuid(r.item, 'asset_id')::uuid);
  end loop;
end
$$;

-- What a submitted version must contain. Reads COMMITTED rows; the caller holds the version row lock.
create function app_content.assert_submittable(p_version_id uuid) returns void
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v app.hack_versions;
  v_field text;
begin
  select * into v from app.hack_versions where id = p_version_id;
  v_field := case
    when v.category_id is null then 'category_slug'
    when v.title is null then 'title'
    when v.summary is null then 'summary'
    when v.outcome is null then 'outcome'
    when v.difficulty is null then 'difficulty'
    when (v.cost_min_cents is not null or v.cost_max_cents is not null) and v.currency is null then 'currency'
    when not exists (select 1 from app.hack_steps s where s.version_id = v.id) then 'steps'
    when not exists (select 1 from app.source_claims c where c.version_id = v.id) then 'source_claims'
    when exists (select 1 from app.source_claims c where c.version_id = v.id and c.kind in ('third_party_reuse', 'licensed', 'permission_granted') and c.canonical_url is null) then 'source_claims.canonical_url'
    else null end;
  if v_field is not null then
    raise exception 'incomplete_content' using errcode = 'PT422', detail = v_field;
  end if;
end
$$;

-- Lock, verify, hash and freeze atomically. p_actor must already be authorized by the caller.
create function app_content.freeze_version(p_version_id uuid, p_actor uuid, p_expected bytea) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v app.hack_versions;
  v_hash bytea;
  v_submission uuid;
begin
  select * into v from app.hack_versions where id = p_version_id for update;   -- (1) the version row: serializes with draft writes and child writers
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  if v.frozen_at is not null then raise exception 'version_frozen' using errcode = 'PT409'; end if;
  perform app_content.assert_submittable(p_version_id);
  v_hash := app_content.version_hash(p_version_id);                               -- (2) hash of the COMMITTED content, after the lock
  if p_expected is distinct from v_hash then
    raise exception 'hash_mismatch' using errcode = 'PT409', detail = 'the content changed since the expected hash was computed';
  end if;
  update app.hack_versions set frozen_at = pg_catalog.now(), content_hash = v_hash, canon_version = 1 where id = p_version_id;  -- guard_version re-verifies the hash
  update app.version_lifecycle set state = 'submitted', state_changed_at = pg_catalog.now() where version_id = p_version_id;
  insert into app.submissions (hack_id, version_id, submitter_id, content_hash, canon_version)
    values (v.hack_id, p_version_id, p_actor, v_hash, 1) returning id into v_submission;
  return pg_catalog.jsonb_build_object('version_id', p_version_id, 'submission_id', v_submission, 'content_hash', pg_catalog.encode(v_hash, 'hex'));
end
$$;

-- ---- the exposed RPC surface --------------------------------------------------------------------------------------------------
create function api.create_draft(p_hack_id uuid default null) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app_guard.actor;
  v_hack uuid;
  v_no integer;
  v_version uuid;
begin
  v_actor := app_guard.require_member();
  -- The quota check and the insert must be one atomic step per member: serialize on the member's account row (a lock mode that does not
  -- conflict with the foreign-key checks of other statements). Lock order everywhere: account row -> hack row -> version row.
  perform 1 from app.accounts a where a.user_id = v_actor.user_id for no key update;
  if (select pg_catalog.count(*) from app.hack_versions v where v.created_by = v_actor.user_id and v.frozen_at is null) >= 20 then
    raise exception 'too_many_drafts' using errcode = 'PT429';
  end if;
  if p_hack_id is null then
    insert into app.hacks (created_by) values (v_actor.user_id) returning id into v_hack;
    v_no := 1;
  else
    select h.id into v_hack from app.hacks h where h.id = p_hack_id and h.created_by = v_actor.user_id for update;   -- the hack row serializes revisions
    if v_hack is null then raise exception 'not_found' using errcode = 'PT404'; end if;
    if exists (select 1 from app.hack_versions v where v.hack_id = v_hack and v.frozen_at is null) then
      raise exception 'open_draft_exists' using errcode = 'PT409';
    end if;
    select coalesce(pg_catalog.max(v.version_no), 0) + 1 into v_no from app.hack_versions v where v.hack_id = v_hack;
  end if;
  insert into app.hack_versions (hack_id, version_no, created_by) values (v_hack, v_no, v_actor.user_id) returning id into v_version;
  insert into app.version_lifecycle (version_id, state) values (v_version, 'draft');
  return pg_catalog.jsonb_build_object('hack_id', v_hack, 'version_id', v_version, 'version_no', v_no);
end
$$;

create function api.save_draft(p_version_id uuid, p_content jsonb) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app_guard.actor;
  v_owner uuid;
  v_frozen timestamptz;
  v_c text;
  v_col text;
begin
  v_actor := app_guard.require_member();
  select v.created_by into v_owner from app.hack_versions v where v.id = p_version_id;          -- ownership first, without locking someone else's row
  if v_owner is distinct from v_actor.user_id then raise exception 'not_found' using errcode = 'PT404'; end if;
  select v.frozen_at into v_frozen from app.hack_versions v where v.id = p_version_id for update;  -- then serialize with submit and child writers
  if v_frozen is not null then raise exception 'version_frozen' using errcode = 'PT409'; end if;
  if p_content is null then raise exception 'invalid_content' using errcode = 'PT422', detail = '(root)'; end if;
  begin
    perform app_content.write_doc(p_version_id, p_content);
  exception
    when check_violation or unique_violation or not_null_violation or invalid_text_representation or string_data_right_truncation or numeric_value_out_of_range or foreign_key_violation then
      get stacked diagnostics v_c = constraint_name, v_col = column_name;
      raise exception 'invalid_content' using errcode = 'PT422', detail = coalesce(v_c, v_col, 'content');
  end;
  return pg_catalog.jsonb_build_object('version_id', p_version_id, 'content_hash', pg_catalog.encode(app_content.version_hash(p_version_id), 'hex'));
end
$$;

create function api.get_version(p_version_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor app_guard.actor;
  v app.hack_versions;
begin
  v_actor := app_guard.require_member();
  select * into v from app.hack_versions x where x.id = p_version_id and x.created_by = v_actor.user_id;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  return pg_catalog.jsonb_build_object(
    'version_id', v.id, 'hack_id', v.hack_id, 'version_no', v.version_no,
    'state', (select l.state from app.version_lifecycle l where l.version_id = v.id),
    'frozen_at', v.frozen_at,
    'content_hash', pg_catalog.encode(v.content_hash, 'hex'),
    'computed_hash', pg_catalog.encode(app_content.version_hash(v.id), 'hex'),
    'content', app_content.version_doc(v.id));
end
$$;

create function api.list_my_versions() returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor app_guard.actor;
begin
  v_actor := app_guard.require_member();
  return coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('version_id', t.id, 'hack_id', t.hack_id, 'version_no', t.version_no, 'state', t.state, 'frozen', t.frozen_at is not null) order by t.created_at desc)
                     from (select v.id, v.hack_id, v.version_no, v.created_at, v.frozen_at, l.state
                             from app.hack_versions v join app.version_lifecycle l on l.version_id = v.id
                            where v.created_by = v_actor.user_id order by v.created_at desc limit 100) t), '[]'::jsonb);
end
$$;

create function api.submit_version(p_version_id uuid, p_expected_hash text) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app_guard.actor;
  v_owner uuid;
begin
  v_actor := app_guard.require_member();
  if p_expected_hash is null or p_expected_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_content' using errcode = 'PT422', detail = 'expected_hash'; end if;
  select v.created_by into v_owner from app.hack_versions v where v.id = p_version_id;
  if v_owner is distinct from v_actor.user_id then raise exception 'not_found' using errcode = 'PT404'; end if;
  return app_content.freeze_version(p_version_id, v_actor.user_id, pg_catalog.decode(p_expected_hash, 'hex'));
end
$$;

create function api.delete_draft(p_version_id uuid) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app_guard.actor;
  v_owner uuid;
  v_hack uuid;
  v_frozen timestamptz;
begin
  v_actor := app_guard.require_member();
  select v.created_by, v.hack_id into v_owner, v_hack from app.hack_versions v where v.id = p_version_id;
  if v_owner is distinct from v_actor.user_id then raise exception 'not_found' using errcode = 'PT404'; end if;
  perform 1 from app.accounts a where a.user_id = v_actor.user_id for no key update;   -- same account-first order as create_draft, so the quota sees committed deletions
  select v.frozen_at into v_frozen from app.hack_versions v where v.id = p_version_id for update;
  if v_frozen is not null then raise exception 'version_frozen' using errcode = 'PT409'; end if;
  delete from app.hack_versions where id = p_version_id;
  if not exists (select 1 from app.hack_versions v where v.hack_id = v_hack) then
    delete from app.hacks where id = v_hack;
  end if;
  return pg_catalog.jsonb_build_object('deleted', true);
end
$$;

-- ---- grants: the complete list for F2-B ---------------------------------------------------------------------------------------
revoke all on function app_content.assert_keys(jsonb, text[], text), app_content.assert_limits(jsonb), app_content.write_doc(uuid, jsonb), app_content.assert_submittable(uuid),
  app_content.freeze_version(uuid, uuid, bytea), api.create_draft(uuid), api.save_draft(uuid, jsonb), api.get_version(uuid), api.list_my_versions(),
  api.submit_version(uuid, text), api.delete_draft(uuid) from public;
grant execute on function api.create_draft(uuid), api.save_draft(uuid, jsonb), api.get_version(uuid), api.list_my_versions(),
  api.submit_version(uuid, text), api.delete_draft(uuid) to authenticated;

reset role;
