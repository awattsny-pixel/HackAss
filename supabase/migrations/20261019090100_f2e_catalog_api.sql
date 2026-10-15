-- F2-E (2/2): the two public read functions. The ONLY grants of this slice are EXECUTE on these two functions, to anon and authenticated (the same content for
-- both; no caller identity is read). Both are STABLE, so PostgreSQL itself refuses any write from them and gives everything inside one call a single snapshot.
-- Errors: PT404 not_found (missing, malformed and ineligible slugs alike); PT422 invalid_content (detail = the argument).

set local role hackass_owner;

create function api.list_public_hacks(
  p_limit integer default null, p_category text default null, p_difficulty text default null, p_after_published_at timestamptz default null, p_after_slug text default null
) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_limit integer;
  v_items jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_more boolean := false;
  v_last_at timestamptz;
  v_last_slug text;
  r record;
begin
  if p_limit is not null and p_limit < 1 then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_limit'; end if;
  v_limit := least(coalesce(p_limit, 25), 100);
  if p_category is not null and (p_category !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or pg_catalog.char_length(p_category) > 40) then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_category'; end if;
  if p_difficulty is not null and p_difficulty not in ('easy', 'moderate', 'hard') then raise exception 'invalid_content' using errcode = 'PT422', detail = 'p_difficulty'; end if;
  if (p_after_published_at is null) <> (p_after_slug is null)
     or (p_after_slug is not null and (p_after_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or pg_catalog.char_length(p_after_slug) > 80)) then
    raise exception 'invalid_content' using errcode = 'PT422', detail = 'cursor';
  end if;
  -- newest publication first; ties by slug (unique) descending: a total order. Candidates are examined in that order and judged by the one eligibility definition.
  for r in
    select h.slug, p.id, p.published_at
      from app.hacks h
      join app.publications p on p.id = h.current_publication_id
      join app.hack_versions v on v.id = p.version_id
      join app.categories c on c.id = v.category_id
     where (p_category is null or c.slug = p_category)
       and (p_difficulty is null or v.difficulty = p_difficulty)
       and (p_after_published_at is null or (p.published_at, h.slug) < (p_after_published_at, p_after_slug))
     order by p.published_at desc, h.slug desc
  loop
    if pg_catalog.cardinality(app_review.public_blockers(r.id)) > 0 then continue; end if;
    if v_count = v_limit then v_more := true; exit; end if;
    v_items := v_items || pg_catalog.jsonb_build_array(app_review.public_hack_json(r.id, false));
    v_count := v_count + 1;
    v_last_at := r.published_at; v_last_slug := r.slug;
  end loop;
  return pg_catalog.jsonb_build_object('items', v_items, 'page_size', v_limit,
    'next_cursor', case when v_more then pg_catalog.jsonb_build_object('published_at', v_last_at, 'slug', v_last_slug) else 'null'::jsonb end);
end
$$;

create function api.get_public_hack(p_slug text) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_pub uuid;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or pg_catalog.char_length(p_slug) > 80 then raise exception 'not_found' using errcode = 'PT404'; end if;
  select h.current_publication_id into v_pub from app.hacks h where h.slug = p_slug;
  if v_pub is null or pg_catalog.cardinality(app_review.public_blockers(v_pub)) > 0 then raise exception 'not_found' using errcode = 'PT404'; end if;
  return app_review.public_hack_json(v_pub, true);
end
$$;

revoke all on function api.list_public_hacks(integer, text, text, timestamptz, text), api.get_public_hack(text) from public;
grant execute on function api.list_public_hacks(integer, text, text, timestamptz, text), api.get_public_hack(text) to anon, authenticated;

reset role;
