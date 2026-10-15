-- F2-E: the public catalog read boundary. Eligibility is judged at read time from current state; every hidden case below is built WITHOUT running any job.
-- Real PostgREST callers (anon key, member and staff tokens), races and the committed rollback are in scripts/local-f2e-checks.mjs.
begin;
select no_plan();

-- ---- helpers (same conventions as 050) -----------------------------------------------------------------------------------------------------
create function pg_temp.set_claims(p_role text, p_sub uuid, p_sid uuid, p_aal text, p_amr jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_sub, 'session_id', p_sid, 'aal', p_aal, 'amr', p_amr))::text, true);
end $$;
create function pg_temp.amr(p_age interval) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', floor(extract(epoch from now() - p_age))::bigint), jsonb_build_object('method', 'password', 'timestamp', floor(extract(epoch from now() - p_age))::bigint)) $$;
create function pg_temp.u(n integer) returns uuid language sql as $$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.s(n integer) returns uuid language sql as $$ select ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.as_member(n integer) returns void language plpgsql as $$
begin perform pg_temp.set_claims('authenticated', pg_temp.u(n), pg_temp.s(n), 'aal1', null); end $$;
create function pg_temp.as_staff(n integer, p_age interval default interval '30 seconds') returns void language plpgsql as $$
begin perform pg_temp.set_claims('authenticated', pg_temp.u(n), pg_temp.s(n), 'aal2', pg_temp.amr(p_age)); end $$;
create function pg_temp.err(p_role text, p_sql text) returns text language plpgsql as $$
declare v text; m text; d text; c text;
begin
  perform set_config('role', p_role, true);
  begin execute p_sql into v;
  exception when others then
    get stacked diagnostics m = message_text, d = pg_exception_detail, c = returned_sqlstate;
    perform set_config('role', 'none', true);
    return c || '|' || m || '|' || coalesce(d, '');
  end;
  perform set_config('role', 'none', true);
  return 'OK:' || coalesce(v, '');
end $$;
create function pg_temp.owner_do(p_sql text) returns text language plpgsql as $$
begin
  perform set_config('role', 'hackass_owner', true);
  begin execute p_sql;
  exception when others then perform set_config('role', 'none', true); return sqlstate || '|' || sqlerrm; end;
  perform set_config('role', 'none', true);
  return 'ok';
end $$;
create function pg_temp.owner_run(p_sql text) returns void language plpgsql as $$
declare r text; begin r := pg_temp.owner_do(p_sql); if r <> 'ok' then raise exception 'fixture failed: % (%)', r, left(p_sql, 90); end if; end $$;
create function pg_temp.owner_val(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('role', 'hackass_owner', true);
  begin execute p_sql into v; exception when others then perform set_config('role', 'none', true); return 'ERR:' || sqlstate || ':' || sqlerrm; end;
  perform set_config('role', 'none', true); return coalesce(v, 'NULL');
end $$;
create function pg_temp.lk(p_have text, p_pattern text, p_desc text) returns text language sql as $$ select ok(p_have like p_pattern, p_desc) || case when p_have like p_pattern then '' else E'\n# have: ' || coalesce(p_have, 'NULL') || E'\n# want like: ' || p_pattern end $$;
-- plain read (the test runs as postgres, which can read the app tables)
create function pg_temp.q(p_sql text) returns text language plpgsql as $$ declare v text; begin execute p_sql into v; return coalesce(v, 'NULL'); end $$;

-- ---- fixtures: u1 author, u2 other member, u3 reviewer, u4 admin, u5 second reviewer, u6 staff who also submits ------------------------------------
insert into auth.users (id, aud, role, email) select pg_temp.u(i), 'authenticated', 'authenticated', 'u' || i || '@example.test' from generate_series(1, 8) i;
insert into auth.sessions (id, user_id) select pg_temp.s(i), pg_temp.u(i) from generate_series(1, 8) i;
select pg_temp.owner_run($$insert into app.categories (slug, name) values ('kitchen', 'Kitchen')$$);
select pg_temp.owner_run(format($$insert into app.staff_assignments (user_id, role, granted_by) values (%L, 'reviewer', 'fixture'), (%L, 'admin', 'fixture'), (%L, 'reviewer', 'fixture'), (%L, 'reviewer', 'fixture')$$, pg_temp.u(3), pg_temp.u(4), pg_temp.u(5), pg_temp.u(6)));

create function pg_temp.doc(p_title text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('category_slug', 'kitchen', 'title', p_title, 'summary', 'A summary.', 'outcome', 'An outcome.', 'difficulty', 'easy',
    'steps', jsonb_build_array('Do the thing.'), 'attributions', jsonb_build_array(jsonb_build_object('role', 'author', 'external_name', 'A. Cook')),
    'source_claims', jsonb_build_array(jsonb_build_object('kind', 'original_work'))) || p_extra $$;
create function pg_temp.submit_as(n integer, p_doc jsonb, p_hack uuid default null) returns jsonb language plpgsql as $$
declare c jsonb; v uuid; h text; r jsonb;
begin
  perform pg_temp.as_member(n);
  c := api.create_draft(p_hack); v := (c ->> 'version_id')::uuid;
  perform api.save_draft(v, p_doc);
  h := api.get_version(v) ->> 'computed_hash';
  r := api.submit_version(v, h);
  return jsonb_build_object('submission_id', r ->> 'submission_id', 'version_id', v, 'hash', h, 'hack_id', c ->> 'hack_id');
end $$;
create temp table t_s (k text primary key, r jsonb);
grant all on t_s to public;

-- ---- fixtures ------------------------------------------------------------------------------------------------------------------------------
select pg_temp.owner_run($$insert into app.categories (slug, name) values ('garden', 'Garden')$$);
create function pg_temp.fdoc(p_title text, p_cat text default 'kitchen', p_diff text default 'easy', p_extra jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.doc(p_title) || jsonb_build_object('category_slug', p_cat, 'difficulty', p_diff) || p_extra $$;
create function pg_temp.rich(p_title text) returns jsonb language sql as $$
  select pg_temp.fdoc(p_title, 'kitchen', 'easy', jsonb_build_object(
    'summary', 'A public summary.', 'outcome', 'A public outcome.', 'time_min_minutes', 5, 'time_max_minutes', 15, 'cost_min_cents', 0, 'cost_max_cents', 500, 'currency', 'USD',
    'estimate_basis', 'Measured once.', 'ai_requirement', 'helpful', 'limitations', 'Not for glass.',
    'steps', jsonb_build_array('Step one body.', 'Step two body.'),
    'materials', jsonb_build_array(jsonb_build_object('name', 'Jar', 'detail', 'Wide mouth'), jsonb_build_object('name', 'Water')),
    'requirements', jsonb_build_array(jsonb_build_object('kind', 'tool', 'name', 'Scissors', 'detail', 'Any'), jsonb_build_object('kind', 'skill', 'name', 'Patience')),
    'tags', jsonb_build_array('herbs', 'fridge'),
    'attributions', jsonb_build_array(jsonb_build_object('role', 'author', 'external_name', 'A. Cook', 'external_url', 'https://example.test/cook')),
    'source_claims', jsonb_build_array(jsonb_build_object('kind', 'licensed', 'canonical_url', 'https://example.test/src', 'source_author', 'S. Writer', 'license_spdx', 'CC-BY-4.0', 'license_version', '4.0',
        'permission_note', 'PRIVATE PERMISSION NOTE', 'asset_rights_note', 'PRIVATE ASSET NOTE')))) $$;
-- the keys, grouped by what happens to them
insert into t_s values
  ('p1', pg_temp.submit_as(1, pg_temp.rich('Public One'))),
  ('p2', pg_temp.submit_as(1, pg_temp.fdoc('Public Two', 'garden', 'moderate'))),
  ('p3', pg_temp.submit_as(1, pg_temp.fdoc('Public Three', 'kitchen', 'hard'))),
  ('subm', pg_temp.submit_as(1, pg_temp.fdoc('Only submitted'))),
  ('apprv', pg_temp.submit_as(1, pg_temp.fdoc('Approved not published'))),
  ('rej0', pg_temp.submit_as(1, pg_temp.fdoc('Rejected before publication'))),
  ('wdr', pg_temp.submit_as(1, pg_temp.fdoc('Withdrawn later'))),
  ('sv1', pg_temp.submit_as(1, pg_temp.fdoc('Replacement V1'))),
  ('revt', pg_temp.submit_as(1, pg_temp.fdoc('Revoked via review write'))),
  ('holdt', pg_temp.submit_as(1, pg_temp.fdoc('Held via review write'))),
  ('prot', pg_temp.submit_as(1, pg_temp.fdoc('Prohibited via review write'))),
  ('expc', pg_temp.submit_as(1, pg_temp.fdoc('Expires by the calendar'))),
  ('tr', pg_temp.submit_as(1, pg_temp.fdoc('Tamper revoked'))),
  ('th', pg_temp.submit_as(1, pg_temp.fdoc('Tamper hold'))),
  ('tp', pg_temp.submit_as(1, pg_temp.fdoc('Tamper prohibited'))),
  ('thi', pg_temp.submit_as(1, pg_temp.fdoc('Tamper high risk'))),
  ('tc', pg_temp.submit_as(1, pg_temp.fdoc('Tamper content'))),
  ('ts', pg_temp.submit_as(1, pg_temp.fdoc('Tamper snapshot'))),
  ('tl', pg_temp.submit_as(1, pg_temp.fdoc('Tamper lifecycle'))),
  ('tu', pg_temp.submit_as(1, pg_temp.fdoc('Tamper unresolved asset'))),
  ('tw', pg_temp.submit_as(1, pg_temp.fdoc('Tamper withdrawal row'))),
  ('tzt', pg_temp.submit_as(1, pg_temp.fdoc('Expires today UTC'))),
  ('tzy', pg_temp.submit_as(1, pg_temp.fdoc('Expired yesterday UTC')));
create function pg_temp.sid(k text) returns text language sql as $$ select r ->> 'submission_id' from t_s where t_s.k = $1 $$;
create function pg_temp.vid(k text) returns text language sql as $$ select r ->> 'version_id' from t_s where t_s.k = $1 $$;
create function pg_temp.hid(k text) returns text language sql as $$ select r ->> 'hack_id' from t_s where t_s.k = $1 $$;
create function pg_temp.hash(k text) returns text language sql as $$ select r ->> 'hash' from t_s where t_s.k = $1 $$;
-- a draft that is never submitted
select pg_temp.as_member(1);
create temp table t_draft as select api.create_draft() as r;
grant all on t_draft to public;

-- review a submission to "ready to publish" as staff n (assessment, every claim cleared, PUBLISH decision); returns the decision id
create function pg_temp.ready(n integer, k text, p_risk text default 'low', p_expires date default null) returns text language plpgsql as $$
declare sid uuid := pg_temp.sid(k)::uuid; h text := pg_temp.hash(k); c integer; i integer; d jsonb;
begin
  perform pg_temp.as_staff(n);
  perform api.start_review(sid, h);
  perform api.record_risk_assessment(sid, h, p_risk, 'Rationale that is long enough.');
  select count(*) into c from app.source_claims where version_id = pg_temp.vid(k)::uuid;
  for i in 1..c loop
    perform api.record_rights_review(sid, h, i, 'clear', 'source_page_checked', 'Evidence that is long enough.', p_expires);
  end loop;
  d := api.record_decision(sid, h, 'PUBLISH', null, null, null);
  return d ->> 'decision_id';
end $$;
create temp table t_dec (k text primary key, d text);
grant all on t_dec to public;
create temp table t_pub (k text primary key, r jsonb);
grant all on t_pub to public;
create function pg_temp.pubsql(k text, p_dec text, p_slug text, p_hash text default null) returns text language sql as $$
  select format('select api.publish_version(%L, %L, %L, %L)::text', pg_temp.sid(k), coalesce(p_hash, pg_temp.hash(k)), p_dec, p_slug) $$;
create function pg_temp.publish(n integer, k text, p_slug text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform pg_temp.as_staff(n);
  r := api.publish_version(pg_temp.sid(k)::uuid, pg_temp.hash(k), (select d from t_dec where t_dec.k = $2)::uuid, p_slug);
  insert into t_pub values (k, r);
  return r;
end $$;
create function pg_temp.pid(k text) returns text language sql as $$ select r ->> 'publication_id' from t_pub where t_pub.k = $1 $$;
create function pg_temp.cur(k text) returns text language sql as $$ select pg_temp.q(format('select coalesce(current_publication_id::text, ''none'') from app.hacks where id = %L', pg_temp.hid(k))) $$;
create function pg_temp.state(k text) returns text language sql as $$ select pg_temp.q(format('select state from app.version_lifecycle where version_id = %L', pg_temp.vid(k))) $$;


-- ---- helpers for the read side ---------------------------------------------------------------------------------------------------------------
create function pg_temp.pj(p_role text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('role', p_role, true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  return v;
end $$;
create function pg_temp.lst(p_role text, p_args text default '') returns jsonb language sql as $$ select pg_temp.pj(p_role, 'select api.list_public_hacks(' || p_args || ')') $$;
create function pg_temp.det(p_role text, p_slug text) returns jsonb language sql as $$ select pg_temp.pj(p_role, format('select api.get_public_hack(%L)', p_slug)) $$;
create function pg_temp.slugs(p_list jsonb) returns text language sql as $$
  select coalesce(string_agg(e ->> 'slug', ',' order by o), '') from jsonb_array_elements(p_list -> 'items') with ordinality t(e, o) $$;
create function pg_temp.keys(p_obj jsonb) returns text language sql as $$ select string_agg(k, ',' order by k) from jsonb_object_keys(p_obj) k $$;
-- the whole list, page by page, as one role
create function pg_temp.walk(p_role text, p_size integer, p_extra text default '') returns text language plpgsql as $$
declare r jsonb; acc text := ''; args text; at timestamptz; sl text; n integer := 0;
begin
  loop
    args := 'p_limit => ' || p_size || p_extra || case when sl is null then '' else format(', p_after_published_at => %L, p_after_slug => %L', at, sl) end;
    r := pg_temp.lst(p_role, args);
    acc := acc || case when acc = '' then '' else ',' end || pg_temp.slugs(r);
    exit when r -> 'next_cursor' = 'null'::jsonb;
    at := (r -> 'next_cursor' ->> 'published_at')::timestamptz; sl := r -> 'next_cursor' ->> 'slug';
    n := n + 1; exit when n > 50;
  end loop;
  return trim(both ',' from acc);
end $$;
create function pg_temp.pb(k text) returns text language sql as $$
  select pg_temp.owner_val(format('select array_to_string(app_review.public_blockers(%L), '','')', pg_temp.pid(k))) $$;
-- Time cannot be moved in a test, so "the calendar passed the expiry" is built by changing the review's expires_on. That date is also an input of the publication's
-- snapshot, so the snapshot is refreshed to match: afterwards ONLY the rights expiry blocks, exactly as when real time passes (no row changes then).
create function pg_temp.lapse_to(k text, p_days integer) returns void language sql as $$
  select pg_temp.owner_run(format($q$alter table app.rights_reviews disable trigger rights_reviews_append_only;
    update app.rights_reviews set expires_on = (clock_timestamp() at time zone 'UTC')::date + %s where id = any (app_review.effective_rights(%L));
    alter table app.rights_reviews enable trigger rights_reviews_append_only;
    alter table app.publications disable trigger publications_append_only;
    update app.publications p set snapshot_text = app_review.snapshot_text(p.hack_id, p.version_id, p.submission_id, p.content_hash, p.canon_version, p.decision_id, p.assessment_id, p.published_by, p.publisher_role,
        (select array_agg(pr.rights_review_id order by pr.claim_no) from app.publication_rights pr where pr.publication_id = p.id)) where p.submission_id = %L;
    update app.publications set snapshot_hash = app_content.hash_text(snapshot_text) where submission_id = %L;
    alter table app.publications enable trigger publications_append_only$q$, p_days, pg_temp.sid(k), pg_temp.sid(k), pg_temp.sid(k))) $$;

-- ===================================================================================================================
-- A. what the public can reach: exactly two functions, nothing underneath
-- ===================================================================================================================
select is((select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace in ('api'::regnamespace, 'app_review'::regnamespace) and (has_function_privilege('anon', p.oid, 'execute'))),
  'api.get_public_hack(text), api.list_public_hacks(integer,text,text,timestamp with time zone,text)', 'anon can execute exactly the two public functions, nothing else in api or app_review');
select is((select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace = 'api'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute') and has_function_privilege('anon', p.oid, 'execute')),
  'api.get_public_hack(text), api.list_public_hacks(integer,text,text,timestamp with time zone,text)', 'they are the only api functions anon shares with authenticated');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'api'::regnamespace and p.proname in ('get_public_hack', 'list_public_hacks') and (has_function_privilege('service_role', p.oid, 'execute') or has_function_privilege('hackass_worker', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))), 0, 'and neither service_role, the worker nor PUBLIC holds EXECUTE on them');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'api'::regnamespace and p.proname in ('get_public_hack', 'list_public_hacks') and (p.provolatile <> 's' or not p.prosecdef or p.proowner <> 'hackass_owner'::regrole)), 0, 'both are STABLE (the database refuses writes from them), SECURITY DEFINER and owned by hackass_owner');
select is((select count(*)::int from pg_proc p where p.pronamespace in ('api'::regnamespace, 'app_review'::regnamespace) and p.proname in ('get_public_hack', 'list_public_hacks', 'public_blockers', 'public_hack_json') and p.prosrc ~* '\m(insert\s+into|update\s+app|delete\s+from|perform\s+app_review\.(job_|withdraw))'), 0, 'their bodies contain no data change and enqueue or run no job');
select is((select coalesce(string_agg(r.role_name || ' ' || t.tbl, E'\n'), '') from (values ('anon'), ('authenticated')) r(role_name)
            cross join (values ('hacks'), ('hack_versions'), ('publications'), ('publication_withdrawals'), ('hack_steps'), ('categories'), ('moderation_decisions'), ('jobs'), ('ai_ledger')) t(tbl)
           where pg_temp.err(r.role_name, format('select 1 from app.%s limit 1', t.tbl)) not like '42501|%'), '', 'anon and authenticated still cannot read any underlying table (drafts, submissions, publication records, jobs, accounting)');
select is((select count(*)::int from pg_class c cross join (values ('anon'), ('authenticated')) r(rn) cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate')) p(priv)
            where c.relnamespace = 'app'::regnamespace and c.relkind = 'r' and has_table_privilege(r.rn, c.oid, p.priv)), 0, 'no table privilege exists for them anywhere in schema app');
select is(pg_temp.err('anon', 'select app_review.public_blockers(gen_random_uuid())::text'), '42501|permission denied for schema app_review|', 'the eligibility function is internal');
select is(pg_temp.err('authenticated', 'select app_review.public_hack_json(gen_random_uuid(), true)::text'), '42501|permission denied for schema app_review|', 'and so is the response builder');

-- ===================================================================================================================
-- B. publish a mixed catalog (reviewed by u3, a reviewer), then drive every case without running any job
-- ===================================================================================================================
insert into t_dec select k, pg_temp.ready(3, k) from unnest(array['p1', 'p2', 'p3', 'wdr', 'sv1', 'revt', 'holdt', 'prot', 'tr', 'th', 'tp', 'thi', 'tc', 'ts', 'tl', 'tu', 'tw', 'apprv']) k;
insert into t_dec select k, pg_temp.ready(3, k, 'low', current_date + 10) from unnest(array['expc', 'tzt', 'tzy']) k;
select pg_temp.as_staff(3);
select api.start_review(pg_temp.sid('rej0')::uuid, pg_temp.hash('rej0'));
select api.record_decision(pg_temp.sid('rej0')::uuid, pg_temp.hash('rej0'), 'REJECT', array['quality'], 'Not good enough.', null);
select pg_temp.publish(3, k, case k when 'p1' then 'pub-one' when 'p2' then 'pub-two' when 'p3' then 'pub-three' when 'sv1' then 'repl' else 's-' || k end)
  from unnest(array['p1', 'p2', 'p3', 'wdr', 'sv1', 'revt', 'holdt', 'prot', 'tr', 'th', 'tp', 'thi', 'tc', 'ts', 'tl', 'tu', 'tw', 'expc', 'tzt', 'tzy']) k;
create temp table t_jobs0 as select count(*) as n, count(*) filter (where status <> 'queued') as touched, coalesce(sum(lease_epoch), 0) as epochs from app.jobs;
grant all on t_jobs0 to public;

-- the eligible ones appear in the list and in the detail
select is(pg_temp.slugs(pg_temp.lst('anon', 'p_limit => 100')) like '%pub-one%' and pg_temp.slugs(pg_temp.lst('anon', 'p_limit => 100')) like '%pub-two%' and pg_temp.slugs(pg_temp.lst('anon', 'p_limit => 100')) like '%pub-three%', true, 'published and eligible: all three are in the list');
select is(pg_temp.det('anon', 'pub-one') ->> 'title', 'Public One', 'and in the detail');
select is(pg_temp.det('anon', 's-wdr') ->> 'title', 'Withdrawn later', 'a publication that will be withdrawn is visible while published');

-- hidden: never published
select is((select count(*)::int from unnest(array['subm', 'apprv', 'rej0']) k where pg_temp.slugs(pg_temp.lst('anon', 'p_limit => 100')) like '%' || k || '%'), 0, 'submitted, approved-but-unpublished and rejected content is not in the list');
select is(pg_temp.err('anon', 'select api.get_public_hack(''subm'')::text'), 'PT404|not_found|', 'a never-published slug is not_found');
select is(pg_temp.q(format('select slug from app.hacks where id = %L', pg_temp.hid('subm'))), 'NULL', 'a submitted-only hack has no public slug at all');
select is(pg_temp.q(format('select count(*)::text from app.hacks where id = %L', (select r ->> 'hack_id' from t_draft))), '1', 'the open draft exists privately');
select is(pg_temp.slugs(pg_temp.lst('anon', 'p_limit => 100')) like '%' || (select r ->> 'hack_id' from t_draft) || '%', false, 'and it is not in the catalog');

-- withdrawal hides immediately
select pg_temp.as_staff(5);
select api.withdraw_publication(pg_temp.pid('wdr')::uuid, 'quality', 'Taken down.');
select is(pg_temp.slugs(pg_temp.lst('anon', 'p_limit => 100')) like '%s-wdr%', false, 'a withdrawn publication leaves the list at once');
select is(pg_temp.err('anon', 'select api.get_public_hack(''s-wdr'')::text'), 'PT404|not_found|', 'and the detail is not_found');

-- replacement: the current version only
select is(pg_temp.det('anon', 'repl') ->> 'title', 'Replacement V1', 'before the replacement the first version is public');
select pg_temp.as_member(1);
insert into t_s values ('sv2', pg_temp.submit_as(1, pg_temp.fdoc('Replacement V2', 'kitchen', 'easy', jsonb_build_object('summary', 'Second version summary.')), pg_temp.hid('sv1')::uuid));
insert into t_dec values ('sv2', pg_temp.ready(5, 'sv2'));
select pg_temp.publish(3, 'sv2', null);
select is(pg_temp.det('anon', 'repl') ->> 'title' || '/' || (pg_temp.det('anon', 'repl') ->> 'version_id' = pg_temp.vid('sv2'))::text, 'Replacement V2/true', 'after the replacement the detail shows the current version, identified by its version id');
select is(pg_temp.slugs(pg_temp.lst('anon', 'p_limit => 100')) ~ 'repl' and (pg_temp.lst('anon', 'p_limit => 100')::text not like '%Replacement V1%') and (pg_temp.det('anon', 'repl')::text not like '%Replacement V1%') and (pg_temp.lst('anon', 'p_limit => 100')::text not like '%' || pg_temp.vid('sv1') || '%'), true, 'the older version is neither listed nor in the detail, and its id is nowhere');
select is((select count(*)::int from jsonb_array_elements(pg_temp.lst('anon', 'p_limit => 100') -> 'items') e where e ->> 'slug' = 'repl'), 1, 'the hack is listed once');

-- the commit-time checks of the publications made above fire here (they would otherwise fire when the later review writes below are already in place)
set constraints all immediate;
set constraints all deferred;
-- later review writes hide immediately (the F2-C2 triggers also withdraw; the public read does not depend on that)
select pg_temp.as_staff(5);
select api.record_rights_review(pg_temp.sid('revt')::uuid, pg_temp.hash('revt'), 1, 'revoked', null, null, null);
select api.record_decision(pg_temp.sid('holdt')::uuid, pg_temp.hash('holdt'), 'HOLD', array['needs_evidence'], null, (select d::uuid from t_dec where k = 'holdt'));
select api.record_risk_assessment(pg_temp.sid('prot')::uuid, pg_temp.hash('prot'), 'prohibited', 'Not allowed after all, found later.');
select is((select count(*)::int from unnest(array['s-revt', 's-holdt', 's-prot']) s where pg_temp.slugs(pg_temp.lst('anon', 'p_limit => 100')) like '%' || s || '%' or pg_temp.err('anon', format('select api.get_public_hack(%L)::text', s)) <> 'PT404|not_found|'), 0, 'revoked rights, a hold and a prohibited assessment each hide the hack from list and detail');

-- ===================================================================================================================
-- C. read time: every rule holds with NO trigger, NO job and NO withdrawal doing the work
-- ===================================================================================================================
select pg_temp.lapse_to('expc', -1);
select pg_temp.lapse_to('tzt', 0);
select pg_temp.lapse_to('tzy', -1);
select pg_temp.owner_run('alter table app.moderation_decisions disable trigger decisions_after_write');
select pg_temp.owner_run('alter table app.version_assessments disable trigger assessments_after_write');
select pg_temp.owner_run('alter table app.rights_reviews disable trigger rights_reviews_after_write');
select pg_temp.owner_run(format($$insert into app.rights_reviews (submission_id, version_id, content_hash, canon_version, claim_no, status, reviewer_id) select id, version_id, content_hash, canon_version, 1, 'revoked', %L from app.submissions where id = %L$$, pg_temp.u(5), pg_temp.sid('tr')));
select pg_temp.owner_run(format($$insert into app.moderation_decisions (submission_id, version_id, content_hash, canon_version, decision, reason_codes, actor_id) select id, version_id, content_hash, canon_version, 'HOLD', array['other'], %L from app.submissions where id = %L$$, pg_temp.u(5), pg_temp.sid('th')));
select pg_temp.owner_run(format($$insert into app.version_assessments (submission_id, version_id, content_hash, canon_version, risk_class, rationale, assessed_by) select id, version_id, content_hash, canon_version, 'prohibited', 'Prohibited after publication.', %L from app.submissions where id = %L$$, pg_temp.u(5), pg_temp.sid('tp')));
select pg_temp.owner_run(format($$insert into app.version_assessments (submission_id, version_id, content_hash, canon_version, risk_class, rationale, assessed_by) select id, version_id, content_hash, canon_version, 'high', 'High risk after publication.', %L from app.submissions where id = %L$$, pg_temp.u(5), pg_temp.sid('thi')));
select pg_temp.owner_run('alter table app.hack_steps disable trigger hack_steps_guard');
select pg_temp.owner_run(format($$update app.hack_steps set body = 'Tampered after publication.' where version_id = %L$$, pg_temp.vid('tc')));
select pg_temp.owner_run('alter table app.hack_steps enable trigger hack_steps_guard');
select pg_temp.owner_run('alter table app.publications disable trigger publications_append_only');
select pg_temp.owner_run(format($$update app.publications set snapshot_text = snapshot_text || 'x' where id = %L$$, pg_temp.pid('ts')));
select pg_temp.owner_run('alter table app.publications enable trigger publications_append_only');
select pg_temp.owner_run(format($$update app.version_lifecycle set state = 'under_review' where version_id = %L$$, pg_temp.vid('tl')));
select pg_temp.owner_run('alter table app.version_assets disable trigger version_assets_guard');
select pg_temp.owner_run(format($$insert into app.version_assets (version_id, sha256, asset_id) values (%L, decode(repeat('ab', 32), 'hex'), '30000000-0000-4000-8000-000000000001')$$, pg_temp.vid('tu')));
select pg_temp.owner_run('alter table app.version_assets enable trigger version_assets_guard');
select pg_temp.owner_run(format($$insert into app.publication_withdrawals (publication_id, cause, reason_code, withdrawn_by) values (%L, 'staff', 'other', %L)$$, pg_temp.pid('tw'), pg_temp.u(5)));
select is((select count(*)::int from unnest(array['tr', 'th', 'tp', 'thi', 'tc', 'ts', 'tl', 'tu', 'tw', 'expc', 'tzy']) k where pg_temp.cur(k) <> pg_temp.pid(k)), 0, 'control: in every one of these cases the hack still POINTS at the publication (no trigger or job withdrew anything)');
select is((select n::text || '/' || touched::text || '/' || epochs::text from t_jobs0), (select count(*)::text || '/' || count(*) filter (where status <> 'queued')::text || '/' || coalesce(sum(lease_epoch), 0)::text from app.jobs), 'and no job was run, leased or finished (the job table is exactly as publication left it)');
select is(pg_temp.pb('tr'), 'rights_not_clear:1', 'revoked rights (a review written with no trigger): rights_not_clear:1');
select is(pg_temp.pb('th'), 'decision_not_publish', 'a HOLD decision: decision_not_publish');
select is(pg_temp.pb('tp'), 'risk_prohibited', 'a prohibited assessment: risk_prohibited');
select is(pg_temp.pb('thi'), 'risk_high_needs_admin', 'a high assessment on a reviewer''s publication: risk_high_needs_admin');
select is(pg_temp.pb('expc'), 'rights_not_clear:1', 'rights that expired by the calendar alone: rights_not_clear:1');
select ok(pg_temp.pb('tc') like '%content_hash_mismatch%' and pg_temp.pb('tc') like '%hash_mismatch%', 'changed frozen content: content_hash_mismatch');
select is(pg_temp.pb('ts'), 'snapshot_mismatch', 'a tampered snapshot: snapshot_mismatch');
select is(pg_temp.pb('tl'), 'lifecycle_not_approved', 'a version no longer approved: lifecycle_not_approved');
select ok(pg_temp.pb('tu') like '%unresolved_references:asset_id%', 'an unresolved asset reference: unresolved_references:asset_id');
select is(pg_temp.pb('tw'), 'withdrawn', 'a withdrawal row with the pointer left set: withdrawn');
select is(pg_temp.pb('p1'), '', 'control: an eligible publication has no blockers');
select is((select count(*)::int from unnest(array['tr', 'th', 'tp', 'thi', 'tc', 'ts', 'tl', 'tu', 'tw', 'expc', 'tzy']) k
            where pg_temp.slugs(pg_temp.lst('anon', 'p_limit => 100')) like '%s-' || k || '%' or pg_temp.err('anon', format('select api.get_public_hack(%L)::text', 's-' || k)) <> 'PT404|not_found|'), 0, 'every one of them is hidden from the list and from the detail');
select is(pg_temp.err('anon', 'select api.get_public_hack(''s-tr'')::text'), pg_temp.err('anon', 'select api.get_public_hack(''no-such-slug'')::text'), 'ineligible and missing slugs return the identical error');
select is(pg_temp.err('anon', 'select api.get_public_hack(''Not A Slug!'')::text'), pg_temp.err('anon', 'select api.get_public_hack(''no-such-slug'')::text'), 'and so does a malformed slug');
-- the UTC boundary, whatever the session's time zone says
select is(pg_temp.det('anon', 's-tzt') ->> 'title', 'Expires today UTC', 'rights expiring TODAY (UTC) are still valid today');
set local timezone = 'Pacific/Kiritimati';
select case when extract(hour from clock_timestamp() at time zone 'UTC') >= 10 then is(pg_temp.det('anon', 's-tzt') ->> 'title', 'Expires today UTC', 'a session whose date is already tomorrow (UTC+14) still sees it') else skip('UTC+14 is not a day ahead before 10:00 UTC', 1) end;
set local timezone = 'Etc/GMT+12';
select case when extract(hour from clock_timestamp() at time zone 'UTC') < 12 then is(pg_temp.err('anon', 'select api.get_public_hack(''s-tzy'')::text'), 'PT404|not_found|', 'a session whose date is still yesterday (UTC-12) does not revive rights that expired yesterday (UTC)') else skip('UTC-12 is not a day behind from 12:00 UTC', 1) end;
set local timezone = 'UTC';

-- ===================================================================================================================
-- C2. each check of the eligibility definition on its own (savepoints: every case is undone before the next), on an otherwise eligible hack
-- ===================================================================================================================
select is(pg_temp.pb('p2'), '', 'control: pub-two is eligible');
-- the snapshot has two parts and each is checked: the text against a recomputation, the stored hash against the text
savepoint c2a;
select pg_temp.owner_run('alter table app.publications disable trigger publications_append_only');
select pg_temp.owner_run(format($$update app.publications set snapshot_hash = app_content.hash_text('something else') where id = %L$$, pg_temp.pid('p2')));
select is(pg_temp.pb('p2'), 'snapshot_mismatch', 'only the stored snapshot HASH altered (text intact): snapshot_mismatch');
rollback to savepoint c2a;
savepoint c2b;
select pg_temp.owner_run('alter table app.publications disable trigger publications_append_only');
select pg_temp.owner_run(format($$update app.publications set snapshot_text = snapshot_text || 'x', snapshot_hash = app_content.hash_text(snapshot_text || 'x') where id = %L$$, pg_temp.pid('p2')));
select is(pg_temp.pb('p2'), 'snapshot_mismatch', 'text AND hash rewritten consistently (so the hash matches the text): still snapshot_mismatch, because the text is recomputed from current rows');
rollback to savepoint c2b;
-- cheap structural reasons short-circuit: a withdrawn publication reports only that, even with other damage
savepoint c2c;
select pg_temp.owner_run('alter table app.publications disable trigger publications_append_only');
select pg_temp.owner_run(format($$update app.publications set snapshot_text = snapshot_text || 'x' where id = %L$$, pg_temp.pid('p2')));
select pg_temp.owner_run(format($$insert into app.publication_withdrawals (publication_id, cause, reason_code, withdrawn_by) values (%L, 'staff', 'other', %L)$$, pg_temp.pid('p2'), pg_temp.u(5)));
select is(pg_temp.pb('p2'), 'withdrawn', 'a withdrawn publication with a damaged snapshot reports only `withdrawn` (the expensive checks do not run)');
rollback to savepoint c2c;
-- a publication that is not the hack's current one (the superseded first publication of the replaced hack)
select ok(pg_temp.pb('sv1') like '%not_current%', 'a superseded publication is not_current');
select is(pg_temp.pb('sv1') like 'not_current%', true, 'and not_current is reported first');
-- a hack with no slug
savepoint c2d;
select pg_temp.owner_run('alter table app.hacks disable trigger user');
select pg_temp.owner_run(format($$alter table app.hacks alter column slug drop not null$$));
select pg_temp.owner_run(format($$update app.hacks set slug = null where current_publication_id = %L$$, pg_temp.pid('p2')));
select ok(pg_temp.pb('p2') like '%no_slug%', 'a hack without a slug: no_slug');
rollback to savepoint c2d;
-- the response builder never emits a member-profile attribution, even if one existed
savepoint c2e;
select pg_temp.owner_run('alter table app.version_attributions disable trigger user');
select pg_temp.owner_run(format($$insert into app.version_attributions (version_id, attribution_no, role, profile_id) values (%L, 9, 'contributor', '30000000-0000-4000-8000-0000000000aa')$$, pg_temp.vid('p2')));
select is(pg_temp.owner_val(format('select jsonb_array_length(app_review.public_hack_json(%L, true) -> ''attributions'')::text', pg_temp.pid('p2'))),
          pg_temp.owner_val(format('select count(*)::text from app.version_attributions where version_id = %L and profile_id is null', pg_temp.vid('p2'))), 'a profile attribution row is not in the response');
rollback to savepoint c2e;
select is(pg_temp.pb('p2'), '', 'control: every case above was undone');

-- ===================================================================================================================
-- D. the public response: exactly the allowlist, built field by field
-- ===================================================================================================================
create temp table t_d as select pg_temp.det('anon', 'pub-one') as r;
grant all on t_d to public;
select is(pg_temp.keys((select r from t_d)), 'ai_requirement,attributions,category,cost,difficulty,estimate_basis,limitations,materials,outcome,published_at,requirements,slug,sources,steps,summary,tags,time_minutes,title,version_id', 'the detail has exactly the documented top-level fields');
select is(pg_temp.keys((select r -> 'category' from t_d)) || '|' || pg_temp.keys((select r -> 'cost' from t_d)) || '|' || pg_temp.keys((select r -> 'time_minutes' from t_d)), 'name,slug|currency,max_cents,min_cents|max,min', 'category, cost and time are exactly their documented fields');
select is(pg_temp.keys((select r -> 'steps' -> 0 from t_d)) || '|' || pg_temp.keys((select r -> 'materials' -> 0 from t_d)) || '|' || pg_temp.keys((select r -> 'requirements' -> 0 from t_d)) || '|' || pg_temp.keys((select r -> 'attributions' -> 0 from t_d)) || '|' || pg_temp.keys((select r -> 'sources' -> 0 from t_d)),
  'body,position|detail,name,position|detail,kind,name|name,role,url|author,kind,license,license_version,url', 'and so are the elements of steps, materials, requirements, attributions and sources');
select is((select r ->> 'title' || '/' || (r -> 'category' ->> 'name') || '/' || (r ->> 'difficulty') || '/' || (r -> 'time_minutes' ->> 'max') || '/' || (r -> 'cost' ->> 'max_cents') || '/' || (r -> 'cost' ->> 'currency') || '/' || (r ->> 'ai_requirement') from t_d), 'Public One/Kitchen/easy/15/500/USD/helpful', 'the values are the published version''s');
select is((select jsonb_array_length(r -> 'steps') || '/' || jsonb_array_length(r -> 'materials') || '/' || jsonb_array_length(r -> 'requirements') || '/' || jsonb_array_length(r -> 'tags') || '/' || jsonb_array_length(r -> 'attributions') || '/' || jsonb_array_length(r -> 'sources') from t_d), '2/2/2/2/1/1', 'with all of its steps, materials, requirements, tags, attribution and source');
select is((select (r -> 'sources' -> 0 ->> 'license') || '/' || (r -> 'attributions' -> 0 ->> 'name') || '/' || (r -> 'steps' -> 1 ->> 'body') || '/' || (r -> 'tags' ->> 0) from t_d), 'CC-BY-4.0/A. Cook/Step two body./fridge', 'in order, with the declared license and attribution');
select is((select r::text ~ 'PRIVATE PERMISSION NOTE|PRIVATE ASSET NOTE|Evidence that is long enough|Rationale that is long enough|Checked the original' from t_d), false, 'author notes, evidence notes and review rationales are absent');
select is((select r::text ~ (pg_temp.u(1)::text || '|' || pg_temp.u(3)::text || '|' || pg_temp.u(4)::text || '|' || pg_temp.u(5)::text || '|' || pg_temp.hid('p1') || '|' || pg_temp.pid('p1') || '|' || pg_temp.sid('p1') || '|' || pg_temp.hash('p1')) from t_d), false, 'no account, staff, hack, publication, submission identifier and no hash appears');
select is((select lower(r::text) ~ 'snapshot|decision|assessment|rights_review|job|ledger|budget|withdraw|reviewer|published_by|submitter|created_by' from t_d), false, 'and none of the internal vocabulary appears');
create temp table t_l as select pg_temp.lst('anon', 'p_limit => 100') as r;
grant all on t_l to public;
select is(pg_temp.keys((select r from t_l)) || '|' || pg_temp.keys((select r -> 'items' -> 0 from t_l)) || '|' || pg_temp.keys((select r -> 'items' -> 0 -> 'category' from t_l)), 'items,next_cursor,page_size|ai_requirement,category,cost,difficulty,published_at,slug,summary,time_minutes,title,version_id|name,slug', 'a list response and its items have exactly the documented fields');
select is((select r::text ~ ('Step one body|Not for glass|' || pg_temp.hid('p1') || '|' || pg_temp.pid('p1') || '|' || pg_temp.u(1)::text || '|' || pg_temp.u(3)::text) from t_l), false, 'the list carries no detail-only text and no internal identifier');

-- ===================================================================================================================
-- E. anonymous and authenticated callers receive the same public content
-- ===================================================================================================================
select pg_temp.as_member(2);
select is(pg_temp.det('authenticated', 'pub-one'), pg_temp.det('anon', 'pub-one'), 'detail: authenticated member = anon');
select is(pg_temp.lst('authenticated', 'p_limit => 100'), pg_temp.lst('anon', 'p_limit => 100'), 'list: authenticated member = anon');
select pg_temp.as_staff(3);
select is(pg_temp.det('authenticated', 'pub-one'), pg_temp.det('anon', 'pub-one'), 'detail: a staff member = anon (no extra field for staff)');
select is(pg_temp.lst('authenticated', 'p_limit => 100'), pg_temp.lst('anon', 'p_limit => 100'), 'list: a staff member = anon');
select pg_temp.as_member(1);
select is(pg_temp.det('authenticated', 'pub-one'), pg_temp.det('anon', 'pub-one'), 'detail: the author = anon (an author gets no private view of their own published hack here)');
select is(pg_temp.err('authenticated', 'select api.get_public_hack(''s-subm'')::text'), 'PT404|not_found|', 'and cannot read their own unpublished work through it');

-- ===================================================================================================================
-- F. list and detail share one definition; ordering and pagination
-- ===================================================================================================================
select is(pg_temp.slugs(pg_temp.lst('anon', 'p_limit => 100')), 's-tzt,repl,pub-two,pub-three,pub-one', 'the list holds exactly the five eligible hacks, newest publication first, ties by slug descending');
select is(pg_temp.owner_val($q$select count(*)::int from app.hacks h where h.current_publication_id is not null and cardinality(app_review.public_blockers(h.current_publication_id)) = 0$q$), '5', 'control: the internal definition finds the same five');
-- the slugs the internal definition accepts / rejects, compared with what the public functions return
select is(pg_temp.owner_val($q$select string_agg(h.slug, ',' order by h.slug) from app.hacks h where h.slug is not null and cardinality(app_review.public_blockers(h.current_publication_id)) = 0$q$),
           (select string_agg(x, ',' order by x) from unnest(string_to_array(pg_temp.slugs(pg_temp.lst('anon', 'p_limit => 100')), ',')) x), 'the hacks the definition accepts are exactly the hacks the list returns');
select is((select count(*)::int from unnest(string_to_array(pg_temp.owner_val($q$select string_agg(h.slug, ',') from app.hacks h where h.slug is not null and cardinality(app_review.public_blockers(h.current_publication_id)) = 0$q$), ',')) sl
            where pg_temp.err('anon', format('select api.get_public_hack(%L)::text', sl)) not like 'OK:%'), 0, 'every hack the definition accepts has a working detail');
select is((select count(*)::int from unnest(string_to_array(pg_temp.owner_val($q$select string_agg(h.slug, ',') from app.hacks h where h.slug is not null and h.current_publication_id is not null and cardinality(app_review.public_blockers(h.current_publication_id)) > 0$q$), ',')) sl
            where pg_temp.err('anon', format('select api.get_public_hack(%L)::text', sl)) like 'OK:%' or pg_temp.slugs(pg_temp.lst('anon', 'p_limit => 100')) like '%' || sl || '%'), 0, 'and every hack it rejects is missing from both');
select is((select count(distinct (e ->> 'published_at'))::int from jsonb_array_elements(pg_temp.lst('anon', 'p_limit => 100') -> 'items') e), 1, 'control: every publication here has the SAME timestamp (one transaction), so the order rests on the tie-breaker');
select is(pg_temp.walk('anon', 2), 's-tzt,repl,pub-two,pub-three,pub-one', 'pages of 2 over tied timestamps return every hack exactly once, in order');
select is(pg_temp.walk('anon', 1), 's-tzt,repl,pub-two,pub-three,pub-one', 'pages of 1 do too');
select is((pg_temp.lst('anon', 'p_limit => 2') -> 'next_cursor' ->> 'slug') || '/' || (pg_temp.lst('anon', 'p_limit => 5') -> 'next_cursor')::text, 'repl/null', 'next_cursor is the last item''s position, and null when the page reaches the end');
select is((pg_temp.lst('anon') ->> 'page_size') || '/' || (pg_temp.lst('anon', 'p_limit => 1000') ->> 'page_size') || '/' || (pg_temp.lst('anon', 'p_limit => 7') ->> 'page_size'), '25/100/7', 'the default page is 25, a request above 100 is capped at 100, anything between is honoured');
select is(pg_temp.err('anon', 'select api.list_public_hacks(p_limit => 0)::text'), 'PT422|invalid_content|p_limit', 'a page size below 1 is refused');
select is(pg_temp.err('anon', 'select api.list_public_hacks(p_limit => -5)::text'), 'PT422|invalid_content|p_limit', 'including a negative one');
select is(pg_temp.err('anon', 'select api.list_public_hacks(p_after_slug => ''pub-one'')::text'), 'PT422|invalid_content|cursor', 'half a cursor is refused (slug only)');
select is(pg_temp.err('anon', format('select api.list_public_hacks(p_after_published_at => %L)::text', now())), 'PT422|invalid_content|cursor', 'half a cursor is refused (time only)');
select is(pg_temp.err('anon', format('select api.list_public_hacks(p_after_published_at => %L, p_after_slug => %L)::text', now(), 'Not A Slug')), 'PT422|invalid_content|cursor', 'a malformed cursor slug is refused');
select is(pg_temp.err('anon', 'select api.list_public_hacks(p_difficulty => ''impossible'')::text'), 'PT422|invalid_content|p_difficulty', 'an unknown difficulty is refused');
select is(pg_temp.err('anon', 'select api.list_public_hacks(p_category => ''Bad Cat!'')::text'), 'PT422|invalid_content|p_category', 'a malformed category is refused');
select is(pg_temp.slugs(pg_temp.lst('anon', 'p_category => ''no-such-category''')), '', 'an unknown category slug is simply an empty list');
select is(pg_temp.slugs(pg_temp.lst('anon', 'p_category => ''garden''')), 'pub-two', 'the category filter uses the published version''s category');
select is(pg_temp.slugs(pg_temp.lst('anon', 'p_difficulty => ''hard''')), 'pub-three', 'the difficulty filter uses the published version''s difficulty');
select is(pg_temp.slugs(pg_temp.lst('anon', 'p_category => ''kitchen'', p_difficulty => ''easy''')), 's-tzt,repl,pub-one', 'and filters combine');
select is(pg_temp.walk('anon', 1, ', p_category => ''kitchen'''), 's-tzt,repl,pub-three,pub-one', 'a filtered traversal paginates the same way');
select is(pg_temp.slugs(pg_temp.lst('anon', format('p_after_published_at => %L, p_after_slug => %L', (select (e ->> 'published_at') from jsonb_array_elements(pg_temp.lst('anon', 'p_limit => 100') -> 'items') e limit 1), 'zzzz'))), 's-tzt,repl,pub-two,pub-three,pub-one', 'a cursor ahead of everything (same time, greater slug) returns all of them: the cursor need not name a real hack');
select is(pg_temp.slugs(pg_temp.lst('anon', format('p_after_published_at => %L, p_after_slug => %L', (select (e ->> 'published_at') from jsonb_array_elements(pg_temp.lst('anon', 'p_limit => 100') -> 'items') e limit 1), '0'))), '', 'and one past the end returns nothing');

-- reads never changed anything
select is((select n::text || '/' || touched::text || '/' || epochs::text from t_jobs0), (select count(*)::text || '/' || count(*) filter (where status <> 'queued')::text || '/' || coalesce(sum(lease_epoch), 0)::text from app.jobs), 'after all these reads the job table is still untouched');

select * from finish();
rollback;
