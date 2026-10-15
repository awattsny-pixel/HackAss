-- F2-E (1/2): the public catalog's internals. Owner-only functions in app_review; nothing here is granted to any other role, and nothing here writes.
-- The contract and the eligibility matrix are docs/db/f2e-public-catalog.md.

set local role hackass_owner;

-- ONE definition of "publicly readable", evaluated at read time from current state: {} = readable. It is the ONGOING half of the publication rules
-- (app_review.publication_blockers: latest decision, assessment, per-claim rights not expired on the UTC day, references, hash) plus the structural checks of the
-- matrix. First-publication-only checks (an unused decision, the caller naming a hash, a free slug) are deliberately absent. Cheap checks run first and
-- short-circuit; the content hash and the snapshot are recomputed only for rows that pass them.
create function app_review.public_blockers(p_publication_id uuid) returns text[]
  language plpgsql stable security definer set search_path = ''
as $$
declare
  p app.publications;
  h app.hacks;
  v_state text;
  v_rights uuid[];
  b text[] := array[]::text[];
begin
  select * into p from app.publications x where x.id = p_publication_id;
  if not found then return array['publication_missing']; end if;
  select * into h from app.hacks x where x.id = p.hack_id;
  if h.current_publication_id is null or h.current_publication_id <> p.id then b := pg_catalog.array_append(b, 'not_current'); end if;
  if h.slug is null then b := pg_catalog.array_append(b, 'no_slug'); end if;
  if exists (select 1 from app.publication_withdrawals w where w.publication_id = p.id) then b := pg_catalog.array_append(b, 'withdrawn'); end if;
  select l.state into v_state from app.version_lifecycle l where l.version_id = p.version_id;
  if v_state is distinct from 'approved' then b := pg_catalog.array_append(b, 'lifecycle_not_approved'); end if;
  if pg_catalog.cardinality(b) > 0 then return b; end if;
  if p.canon_version <> 1 or app_content.version_hash(p.version_id) is distinct from (p.content_hash) then b := pg_catalog.array_append(b, 'content_hash_mismatch'); end if;
  select coalesce(pg_catalog.array_agg(pr.rights_review_id order by pr.claim_no), array[]::uuid[]) into v_rights from app.publication_rights pr where pr.publication_id = p.id;
  if p.snapshot_text <> app_review.snapshot_text(p.hack_id, p.version_id, p.submission_id, p.content_hash, p.canon_version, p.decision_id, p.assessment_id, p.published_by, p.publisher_role, v_rights)
     or p.snapshot_hash <> app_content.hash_text(p.snapshot_text) then
    b := pg_catalog.array_append(b, 'snapshot_mismatch');
  end if;
  return b || app_review.publication_blockers(p.submission_id, p.published_by);
end
$$;

-- The public response, built field by field from the published version (never whole rows, never a join to staff, account, review or accounting data).
-- p_detail = false gives the list item, true the full detail. Reads the version the PUBLICATION names, so a response can never mix two versions.
create function app_review.public_hack_json(p_publication_id uuid, p_detail boolean) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  p app.publications;
  h app.hacks;
  v app.hack_versions;
  c app.categories;
  j jsonb;
begin
  select * into p from app.publications x where x.id = p_publication_id;
  select * into h from app.hacks x where x.id = p.hack_id;
  select * into v from app.hack_versions x where x.id = p.version_id;
  select * into c from app.categories x where x.id = v.category_id;
  j := pg_catalog.jsonb_build_object(
    'slug', h.slug, 'version_id', v.id, 'published_at', p.published_at,
    'category', pg_catalog.jsonb_build_object('slug', c.slug, 'name', c.name),
    'title', v.title, 'summary', v.summary, 'difficulty', v.difficulty,
    'time_minutes', pg_catalog.jsonb_build_object('min', v.time_min_minutes, 'max', v.time_max_minutes),
    'cost', pg_catalog.jsonb_build_object('min_cents', v.cost_min_cents, 'max_cents', v.cost_max_cents, 'currency', v.currency),
    'ai_requirement', v.ai_requirement);
  if not p_detail then return j; end if;
  return j || pg_catalog.jsonb_build_object(
    'outcome', v.outcome, 'estimate_basis', v.estimate_basis, 'limitations', v.limitations,
    'steps', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('position', s.position, 'body', s.body) order by s.position) from app.hack_steps s where s.version_id = v.id), '[]'::jsonb),
    'materials', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('position', m.position, 'name', m.name, 'detail', m.detail) order by m.position) from app.hack_materials m where m.version_id = v.id), '[]'::jsonb),
    'requirements', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', r.kind, 'name', r.name, 'detail', r.detail) order by r.kind, r.name) from app.hack_requirements r where r.version_id = v.id), '[]'::jsonb),
    'tags', coalesce((select pg_catalog.jsonb_agg(t.slug order by t.slug) from app.version_tags t where t.version_id = v.id), '[]'::jsonb),
    'attributions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role', a.role, 'name', a.external_name, 'url', a.external_url) order by a.attribution_no)
                                from app.version_attributions a where a.version_id = v.id and a.profile_id is null), '[]'::jsonb),
    'sources', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', k.kind, 'url', k.canonical_url, 'author', k.source_author, 'license', k.license_spdx, 'license_version', k.license_version) order by k.claim_no)
                           from app.source_claims k where k.version_id = v.id), '[]'::jsonb));
end
$$;

revoke all on function app_review.public_blockers(uuid), app_review.public_hack_json(uuid, boolean) from public;

reset role;
