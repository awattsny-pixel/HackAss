-- F2-B (2/4): HashCanon-1 in SQL. The specification is docs/db/hashcanon-1.md; the TypeScript twin is
-- src/modules/submissions/hashcanon.ts; both are checked against tests/fixtures/hashcanon-vectors.json.
--
-- ONE algorithm: app_content.canonical_text_json(doc) renders a content document; the table-backed canonical_text(version_id)
-- first rebuilds the same document from committed rows (version_doc) and calls it. The hash is SHA-256 over the UTF-8 bytes.

set local role hackass_owner;

-- NFC, and CR / CRLF -> LF. Idempotent.
create function app_content.canon_str(p text) returns text
  language sql immutable security definer set search_path = ''
as $$ select pg_catalog.normalize(pg_catalog.replace(pg_catalog.replace(p, E'\r\n', E'\n'), E'\r', E'\n'), 'NFC') $$;

-- "<byte_length>:<value>" or "-:" for an absent value. Byte length is the UTF-8 length.
create function app_content.fv(p text) returns text
  language sql immutable security definer set search_path = ''
as $$ select case when p is null then '-:' else pg_catalog.octet_length(p)::text || ':' || p end $$;

-- An optional string member of a JSON object: absent or JSON null -> NULL; a JSON string -> normalized text; anything else is an error.
create function app_content.j_text(p jsonb, p_key text) returns text
  language plpgsql immutable security definer set search_path = ''
as $$
begin
  if p -> p_key is null or pg_catalog.jsonb_typeof(p -> p_key) = 'null' then return null; end if;
  if pg_catalog.jsonb_typeof(p -> p_key) <> 'string' then
    raise exception 'invalid_content' using errcode = 'PT422', detail = p_key;
  end if;
  return app_content.canon_str(p ->> p_key);
end
$$;

-- An optional non-negative integer member (at most 15 digits, i.e. below 2^53) rendered as ASCII decimal without leading zeros;
-- anything with a fraction or exponent is an error.
create function app_content.j_int(p jsonb, p_key text) returns text
  language plpgsql immutable security definer set search_path = ''
as $$
begin
  if p -> p_key is null or pg_catalog.jsonb_typeof(p -> p_key) = 'null' then return null; end if;
  if pg_catalog.jsonb_typeof(p -> p_key) <> 'number' or (p ->> p_key) !~ '^(0|[1-9][0-9]{0,14})$' then
    raise exception 'invalid_content' using errcode = 'PT422', detail = p_key;
  end if;
  return p ->> p_key;
end
$$;

-- An optional identifier member that must ALREADY be in the documented form: a lowercase, hyphenated UUID (j_uuid) or 64 lowercase hex
-- characters (j_hex64). Uppercase, braces, a urn: prefix, missing or odd hyphens, short or non-hex digests are an error (PT422, detail = the key),
-- so the text that is hashed, the TypeScript implementation and the stored (uuid / bytea) value can never disagree about spelling.
create function app_content.j_uuid(p jsonb, p_key text) returns text
  language plpgsql immutable security definer set search_path = ''
as $$
declare v text := app_content.j_text(p, p_key);
begin
  if v is not null and v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_content' using errcode = 'PT422', detail = p_key;
  end if;
  return v;
end
$$;
create function app_content.j_hex64(p jsonb, p_key text) returns text
  language plpgsql immutable security definer set search_path = ''
as $$
declare v text := app_content.j_text(p, p_key);
begin
  if v is not null and v !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_content' using errcode = 'PT422', detail = p_key;
  end if;
  return v;
end
$$;

-- A JSON array member as a set of its elements, in array order, with 1-based position. Absent / null -> empty. Non-array -> error.
create function app_content.j_arr(p jsonb, p_key text) returns table (pos integer, item jsonb)
  language plpgsql immutable security definer set search_path = ''
as $$
begin
  if p -> p_key is null or pg_catalog.jsonb_typeof(p -> p_key) = 'null' then return; end if;
  if pg_catalog.jsonb_typeof(p -> p_key) <> 'array' then
    raise exception 'invalid_content' using errcode = 'PT422', detail = p_key;
  end if;
  return query select (e.ord)::integer, e.item from pg_catalog.jsonb_array_elements(p -> p_key) with ordinality as e(item, ord);
end
$$;

create function app_content.canonical_text_json(p jsonb) returns text
  language plpgsql immutable security definer set search_path = ''
as $$
declare
  v_out text := E'HACKASS-CANON-1\n';
  v_f   text;
  v_n   integer;
  r     record;
begin
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'invalid_content' using errcode = 'PT422', detail = '(root)';
  end if;
  -- scalar fields, fixed order
  foreach v_f in array array['category_slug', 'title', 'summary', 'outcome', 'difficulty'] loop
    v_out := v_out || v_f || ':' || app_content.fv(app_content.j_text(p, v_f)) || E'\n';
  end loop;
  foreach v_f in array array['time_min_minutes', 'time_max_minutes', 'cost_min_cents', 'cost_max_cents'] loop
    v_out := v_out || v_f || ':' || app_content.fv(app_content.j_int(p, v_f)) || E'\n';
  end loop;
  foreach v_f in array array['currency', 'estimate_basis', 'ai_requirement', 'limitations'] loop
    v_out := v_out || v_f || ':' || app_content.fv(app_content.j_text(p, v_f)) || E'\n';
  end loop;

  -- steps: array order, positions 1..n
  select pg_catalog.count(*) into v_n from app_content.j_arr(p, 'steps');
  v_out := v_out || 'steps:' || v_n || E'\n';
  for r in select a.pos, a.item from app_content.j_arr(p, 'steps') a order by a.pos loop
    if pg_catalog.jsonb_typeof(r.item) <> 'string' then raise exception 'invalid_content' using errcode = 'PT422', detail = 'steps'; end if;
    v_out := v_out || 'step;' || r.pos || ';' || app_content.fv(app_content.canon_str(r.item #>> '{}')) || E'\n';
  end loop;

  -- materials: array order
  select pg_catalog.count(*) into v_n from app_content.j_arr(p, 'materials');
  v_out := v_out || 'materials:' || v_n || E'\n';
  for r in select a.pos, a.item from app_content.j_arr(p, 'materials') a order by a.pos loop
    v_out := v_out || 'material;' || r.pos || ';' || app_content.fv(app_content.j_text(r.item, 'name')) || ';' || app_content.fv(app_content.j_text(r.item, 'detail')) || E'\n';
  end loop;

  -- requirements: sorted by (kind, name), compared as UTF-8 bytes
  select pg_catalog.count(*) into v_n from app_content.j_arr(p, 'requirements');
  v_out := v_out || 'requirements:' || v_n || E'\n';
  for r in select app_content.j_text(a.item, 'kind') as kind, app_content.j_text(a.item, 'name') as name, app_content.j_text(a.item, 'detail') as detail
             from app_content.j_arr(p, 'requirements') a
            order by pg_catalog.convert_to(app_content.j_text(a.item, 'kind'), 'UTF8'), pg_catalog.convert_to(app_content.j_text(a.item, 'name'), 'UTF8') loop
    v_out := v_out || 'requirement;' || app_content.fv(r.kind) || ';' || app_content.fv(r.name) || ';' || app_content.fv(r.detail) || E'\n';
  end loop;

  -- tags: sorted by slug (bytes)
  select pg_catalog.count(*) into v_n from app_content.j_arr(p, 'tags');
  v_out := v_out || 'tags:' || v_n || E'\n';
  if exists (select 1 from app_content.j_arr(p, 'tags') a where pg_catalog.jsonb_typeof(a.item) <> 'string') then raise exception 'invalid_content' using errcode = 'PT422', detail = 'tags'; end if;
  for r in select app_content.canon_str(a.item #>> '{}') as slug from app_content.j_arr(p, 'tags') a order by pg_catalog.convert_to(app_content.canon_str(a.item #>> '{}'), 'UTF8') loop
    v_out := v_out || 'tag;' || app_content.fv(r.slug) || E'\n';
  end loop;

  -- attributions: array order = attribution number
  select pg_catalog.count(*) into v_n from app_content.j_arr(p, 'attributions');
  v_out := v_out || 'attributions:' || v_n || E'\n';
  for r in select a.pos, a.item from app_content.j_arr(p, 'attributions') a order by a.pos loop
    v_out := v_out || 'attribution;' || r.pos || ';' || app_content.fv(app_content.j_text(r.item, 'role')) || ';' || app_content.fv(app_content.j_uuid(r.item, 'profile_id'))
                   || ';' || app_content.fv(app_content.j_text(r.item, 'external_name')) || ';' || app_content.fv(app_content.j_text(r.item, 'external_url')) || E'\n';
  end loop;

  -- source claims: array order = claim number
  select pg_catalog.count(*) into v_n from app_content.j_arr(p, 'source_claims');
  v_out := v_out || 'source_claims:' || v_n || E'\n';
  for r in select a.pos, a.item from app_content.j_arr(p, 'source_claims') a order by a.pos loop
    v_out := v_out || 'claim;' || r.pos || ';' || app_content.fv(app_content.j_text(r.item, 'kind')) || ';' || app_content.fv(app_content.j_text(r.item, 'canonical_url'))
                   || ';' || app_content.fv(app_content.j_text(r.item, 'source_author')) || ';' || app_content.fv(app_content.j_text(r.item, 'license_spdx'))
                   || ';' || app_content.fv(app_content.j_text(r.item, 'license_version')) || ';' || app_content.fv(app_content.j_text(r.item, 'permission_note'))
                   || ';' || app_content.fv(app_content.j_text(r.item, 'asset_rights_note')) || E'\n';
  end loop;

  -- assets: sorted by sha-256 hex (bytes of the lowercase hex text)
  select pg_catalog.count(*) into v_n from app_content.j_arr(p, 'assets');
  v_out := v_out || 'assets:' || v_n || E'\n';
  for r in select app_content.j_hex64(a.item, 'sha256') as sha, app_content.j_uuid(a.item, 'asset_id') as asset_id from app_content.j_arr(p, 'assets') a
            order by pg_catalog.convert_to(app_content.j_hex64(a.item, 'sha256'), 'UTF8') loop
    v_out := v_out || 'asset;' || app_content.fv(r.sha) || ';' || app_content.fv(r.asset_id) || E'\n';
  end loop;
  return v_out;
end
$$;

create function app_content.hash_text(p_canonical text) returns bytea
  language sql immutable security definer set search_path = ''
as $$ select pg_catalog.sha256(pg_catalog.convert_to(p_canonical, 'UTF8')) $$;

-- The document for a version, rebuilt from COMMITTED ROWS (the caller holds the appropriate lock).
create function app_content.version_doc(p_version_id uuid) returns jsonb
  language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'category_slug', (select c.slug from app.categories c where c.id = v.category_id),
      'title', v.title, 'summary', v.summary, 'outcome', v.outcome, 'difficulty', v.difficulty,
      'time_min_minutes', v.time_min_minutes, 'time_max_minutes', v.time_max_minutes,
      'cost_min_cents', v.cost_min_cents, 'cost_max_cents', v.cost_max_cents,
      'currency', v.currency, 'estimate_basis', v.estimate_basis, 'ai_requirement', v.ai_requirement, 'limitations', v.limitations))
    || pg_catalog.jsonb_build_object(
      'steps',         coalesce((select pg_catalog.jsonb_agg(s.body order by s.position) from app.hack_steps s where s.version_id = v.id), '[]'::jsonb),
      'materials',     coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('name', m.name, 'detail', m.detail)) order by m.position) from app.hack_materials m where m.version_id = v.id), '[]'::jsonb),
      'requirements',  coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('kind', r.kind, 'name', r.name, 'detail', r.detail))) from app.hack_requirements r where r.version_id = v.id), '[]'::jsonb),
      'tags',          coalesce((select pg_catalog.jsonb_agg(t.slug) from app.version_tags t where t.version_id = v.id), '[]'::jsonb),
      'attributions',  coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('role', a.role, 'profile_id', a.profile_id, 'external_name', a.external_name, 'external_url', a.external_url)) order by a.attribution_no) from app.version_attributions a where a.version_id = v.id), '[]'::jsonb),
      'source_claims', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('kind', c.kind, 'canonical_url', c.canonical_url, 'source_author', c.source_author, 'license_spdx', c.license_spdx, 'license_version', c.license_version, 'permission_note', c.permission_note, 'asset_rights_note', c.asset_rights_note)) order by c.claim_no) from app.source_claims c where c.version_id = v.id), '[]'::jsonb),
      'assets',        coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('asset_id', x.asset_id, 'sha256', pg_catalog.encode(x.sha256, 'hex'))) from app.version_assets x where x.version_id = v.id), '[]'::jsonb))
  from app.hack_versions v where v.id = p_version_id
$$;

create function app_content.canonical_text(p_version_id uuid) returns text
  language sql stable security definer set search_path = ''
as $$ select app_content.canonical_text_json(app_content.version_doc(p_version_id)) $$;

create function app_content.version_hash(p_version_id uuid) returns bytea
  language sql stable security definer set search_path = ''
as $$ select app_content.hash_text(app_content.canonical_text(p_version_id)) $$;

revoke all on function app_content.canon_str(text), app_content.fv(text), app_content.j_text(jsonb, text), app_content.j_int(jsonb, text),
  app_content.j_arr(jsonb, text), app_content.j_uuid(jsonb, text), app_content.j_hex64(jsonb, text), app_content.canonical_text_json(jsonb), app_content.hash_text(text), app_content.version_doc(uuid),
  app_content.canonical_text(uuid), app_content.version_hash(uuid) from public;

reset role;
