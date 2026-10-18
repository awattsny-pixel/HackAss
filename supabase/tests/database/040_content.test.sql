-- F2-B: drafts, submission, immutability and ownership, exercised through the exposed api functions as the real Supabase roles
-- (claims in request.jwt.claims, as PostgREST provides them) and through direct DML as the owner role for the immutability rules.
-- Real signed JWTs and genuine concurrency are in scripts/local-f2b-checks.mjs.
begin;
select no_plan();

create function pg_temp.act(p_role text, p_sub uuid, p_sid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_sub, 'session_id', p_sid, 'aal', 'aal1'))::text, true);
  perform set_config('role', p_role, true);
end $$;
-- Run a statement as a role and report its result / SQLSTATE (the owner and application roles cannot call pgTAP themselves).
create function pg_temp.as_val(p_role text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('role', p_role, true);
  begin execute p_sql into v;
  exception when others then perform set_config('role', 'none', true); return 'ERR:' || sqlstate || ':' || sqlerrm; end;
  perform set_config('role', 'none', true);
  return coalesce(v, 'NULL');
end $$;
create function pg_temp.owner_val(p_sql text) returns text language sql as $$ select pg_temp.as_val('hackass_owner', p_sql) $$;
create function pg_temp.owner_do(p_sql text) returns text language plpgsql as $$
begin
  perform set_config('role', 'hackass_owner', true);
  begin execute p_sql;
  exception when others then perform set_config('role', 'none', true); return 'ERR:' || sqlstate || ':' || sqlerrm; end;
  perform set_config('role', 'none', true);
  return 'ok';
end $$;
-- cleanup attempts whose outcome does not matter (errors ignored, nothing printed)
create function pg_temp.owner_try(p_sql text) returns void language plpgsql as $$
begin perform pg_temp.owner_do(p_sql); end $$;
-- fixture statements: fail loudly, print nothing that looks like TAP
create function pg_temp.owner_run(p_sql text) returns void language plpgsql as $$
declare r text;
begin
  r := pg_temp.owner_do(p_sql);
  if r <> 'ok' then raise exception 'fixture failed: % (%)', r, left(p_sql, 80); end if;
end $$;
-- the first token of an error from owner_val / as_val: "ERR:<sqlstate>:<message>" -> "<sqlstate>:<message>"
create function pg_temp.code(p text) returns text language sql as $$ select case when p like 'ERR:%' then substring(p from 5) else 'OK' end $$;

-- ---- fixtures ---------------------------------------------------------------------------------------------------------
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'u1@example.test'),
  ('00000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'u2@example.test'),
  ('00000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'u3@example.test');
insert into auth.sessions (id, user_id) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003');
select pg_temp.owner_run($$insert into app.categories (slug, name) values ('kitchen', 'Kitchen'), ('home', 'Home')$$);
select pg_temp.owner_run($$insert into app.staff_assignments (user_id, role, granted_by) values ('00000000-0000-4000-8000-000000000003', 'admin', 'fixture')$$);

-- a complete, valid document
create function pg_temp.doc(p_title text default 'Keep herbs fresh') returns jsonb language sql as $$
  select jsonb_build_object(
    'category_slug', 'kitchen', 'title', p_title, 'summary', 'Store cut herbs upright in water.', 'outcome', 'Crisp herbs for two weeks.', 'difficulty', 'easy',
    'time_min_minutes', 5, 'time_max_minutes', 10, 'cost_min_cents', 0, 'cost_max_cents', 250, 'currency', 'USD', 'estimate_basis', 'three trials', 'ai_requirement', 'none', 'limitations', 'Basil dislikes the fridge.',
    'steps', jsonb_build_array('Trim the stems.', 'Stand in a jar.', 'Cover loosely.'),
    'materials', jsonb_build_array(jsonb_build_object('name', 'Glass jar', 'detail', 'any size'), jsonb_build_object('name', 'Bag')),
    'requirements', jsonb_build_array(jsonb_build_object('kind', 'tool', 'name', 'Scissors'), jsonb_build_object('kind', 'skill', 'name', 'None')),
    'tags', jsonb_build_array('kitchen', 'herbs'),
    'attributions', jsonb_build_array(jsonb_build_object('role', 'author', 'profile_id', '00000000-0000-4000-8000-000000000001')),
    'source_claims', jsonb_build_array(jsonb_build_object('kind', 'original_work')),
    'assets', jsonb_build_array(jsonb_build_object('asset_id', '30000000-0000-4000-8000-000000000001', 'sha256', repeat('ab', 32)))) $$;

-- the hash of the standard document, computed by the SQL canonical function as the owner role
create temp table t_dochash as select pg_temp.owner_val(format($f$select encode(app_content.hash_text(app_content.canonical_text_json(%L::jsonb)), 'hex')$f$, pg_temp.doc())) as h;
grant all on t_dochash to public;
select matches((select h from t_dochash), '^[0-9a-f]{64}$', 'the standard document hashes to 64 hex characters');

-- ===================================================================================================================
-- A. drafts are editable
-- ===================================================================================================================
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
create temp table t_ids as select (api.create_draft()) as r;
grant all on t_ids to public;
select is((select r ->> 'version_no' from t_ids), '1', 'create_draft: a new hack gets version 1');
select is((api.get_version((select (r ->> 'version_id')::uuid from t_ids))) ->> 'state', 'draft', 'a new draft starts in lifecycle state draft');
reset role;
select is((select created_by::text from app.hack_versions where id = (select (r ->> 'version_id')::uuid from t_ids)), '00000000-0000-4000-8000-000000000001', 'the owner is the database-derived caller (no client-supplied id exists)');
select is((select count(*)::int from app.hacks where id = (select (r ->> 'hack_id')::uuid from t_ids) and created_by = '00000000-0000-4000-8000-000000000001'), 1, 'the hack records the caller as creator');

select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
create temp table t_save1 as select api.save_draft((select (r ->> 'version_id')::uuid from t_ids), pg_temp.doc()) as r;
grant all on t_save1 to public;
select is((select r ->> 'content_hash' from t_save1), (select h from t_dochash), 'save_draft: the returned hash equals the hash of the document it was given');
select is((api.get_version((select (r ->> 'version_id')::uuid from t_ids))) -> 'content' ->> 'title', 'Keep herbs fresh', 'the draft content is readable by its owner');
create temp table t_save2 as select api.save_draft((select (r ->> 'version_id')::uuid from t_ids), pg_temp.doc('A different title') - 'tags' || jsonb_build_object('steps', jsonb_build_array('Only one step.'))) as r;
grant all on t_save2 to public;
select isnt((select r ->> 'content_hash' from t_save2), (select r ->> 'content_hash' from t_save1), 'editing a draft changes its hash');
select is((api.get_version((select (r ->> 'version_id')::uuid from t_ids))) -> 'content' -> 'steps', '["Only one step."]'::jsonb, 'save_draft replaces the whole content: old steps are gone');
select is((api.get_version((select (r ->> 'version_id')::uuid from t_ids))) -> 'content' -> 'tags', '[]'::jsonb, 'and omitted lists are emptied');
select is((api.get_version((select (r ->> 'version_id')::uuid from t_ids)) ->> 'computed_hash'), (select r ->> 'content_hash' from t_save2), 'get_version.computed_hash equals the hash save_draft returned');
-- normalization on write
create temp table t_norm as select api.save_draft((select (r ->> 'version_id')::uuid from t_ids), jsonb_build_object('title', E'Café', 'summary', E'a\r\nb\rc', 'steps', jsonb_build_array('x'))) as r;
grant all on t_norm to public;
select is((api.get_version((select (r ->> 'version_id')::uuid from t_ids))) -> 'content' ->> 'title', E'Café', 'text is stored NFC-normalized');
select is((api.get_version((select (r ->> 'version_id')::uuid from t_ids))) -> 'content' ->> 'summary', E'a\nb\nc', 'CRLF and CR are stored as LF');
reset role;

-- invalid content is rejected with PT422 and never partially applied
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select pg_temp.owner_run('select 1'); -- (keeps the helper warm)
select api.save_draft((select (r ->> 'version_id')::uuid from t_ids), pg_temp.doc('Before the bad edits'));
create temp table t_before as select api.get_version((select (r ->> 'version_id')::uuid from t_ids)) as r;
grant all on t_before to public;
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"risk_class":"low"}'), 'PT422', 'invalid_content', 'a privileged field (risk_class) cannot be supplied');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"frozen_at":"2026-01-01T00:00:00Z"}'), 'PT422', 'invalid_content', 'the seal (frozen_at) cannot be supplied');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"content_hash":"00"}'), 'PT422', 'invalid_content', 'content_hash cannot be supplied');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"created_by":"00000000-0000-4000-8000-000000000002"}'), 'PT422', 'invalid_content', 'created_by cannot be supplied');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"status":"approved","approved":true}'), 'PT422', 'invalid_content', 'approval fields cannot be supplied');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"materials":[{"name":"x","risk":"low"}]}'), 'PT422', 'invalid_content', 'unknown keys are rejected inside list items too');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"title":5}'), 'PT422', 'invalid_content', 'a wrong type is rejected');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"category_slug":"nope"}'), 'PT422', 'invalid_content', 'an unknown category is rejected');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"title":"' || repeat('x', 121) || '"}'), 'PT422', 'invalid_content', 'an over-long title is rejected (check constraint)');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), E'{"title":"a\\u0007b"}'), 'PT422', 'invalid_content', 'a control character is rejected');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"title":"ok","tags":["Bad Tag"]}'), 'PT422', 'invalid_content', 'a malformed tag is rejected after earlier parts were written (atomic)');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"requirements":[{"kind":"tool","name":"a"},{"kind":"tool","name":"a"}]}'), 'PT422', 'invalid_content', 'a duplicate requirement is rejected');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"attributions":[{"role":"author","profile_id":"00000000-0000-4000-8000-000000000001","external_name":"X"}]}'), 'PT422', 'invalid_content', 'an attribution cannot be both a member and external');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"assets":[{"asset_id":"30000000-0000-4000-8000-000000000001","sha256":"XYZ"}]}'), 'PT422', 'invalid_content', 'a malformed asset digest is rejected');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"time_min_minutes":9,"time_max_minutes":2}'), 'PT422', 'invalid_content', 'a time range with min > max is rejected');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"time_min_minutes":1.5}'), 'PT422', 'invalid_content', 'a non-integer number is rejected');
select throws_ok(format($$select api.save_draft(%L, NULL)$$, (select r ->> 'version_id' from t_ids)), 'PT422', 'invalid_content', 'a NULL document is rejected');
select is((api.get_version((select (r ->> 'version_id')::uuid from t_ids))) -> 'content', (select r -> 'content' from t_before), 'after all the rejected edits the draft is exactly as it was');

select is(jsonb_array_length(api.list_my_versions()), 1, 'list_my_versions: the owner sees the draft');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002');
select is(jsonb_array_length(api.list_my_versions()), 0, 'list_my_versions: another member sees nothing of it');
reset role;

-- ===================================================================================================================
-- B. submission: hash, freeze, immutability
-- ===================================================================================================================
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select api.save_draft((select (r ->> 'version_id')::uuid from t_ids), pg_temp.doc());
select throws_ok(format($$select api.submit_version(%L, %L)$$, (select r ->> 'version_id' from t_ids), repeat('0', 64)), 'PT409', 'hash_mismatch', 'submit with a wrong expected hash is a conflict');
select throws_ok(format($$select api.submit_version(%L, %L)$$, (select r ->> 'version_id' from t_ids), 'not-hex'), 'PT422', 'invalid_content', 'a malformed expected hash is rejected');
select throws_ok(format($$select api.submit_version(%L, NULL)$$, (select r ->> 'version_id' from t_ids)), 'PT422', 'invalid_content', 'a NULL expected hash is rejected');
reset role;
select is((select frozen_at is null from app.hack_versions where id = (select (r ->> 'version_id')::uuid from t_ids)), true, 'a rejected submit leaves the draft unfrozen');

-- an incomplete draft cannot be submitted
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
create temp table t_inc as select api.create_draft() as r;
grant all on t_inc to public;
select api.save_draft((select (r ->> 'version_id')::uuid from t_inc), '{"title":"Only a title"}'::jsonb);
select throws_ok(format($$select api.submit_version(%L, %L)$$, (select r ->> 'version_id' from t_inc), (select api.get_version((select (r ->> 'version_id')::uuid from t_inc)) ->> 'computed_hash')), 'PT422', 'incomplete_content', 'an incomplete draft (no summary, steps, claims) cannot be submitted');
select api.save_draft((select (r ->> 'version_id')::uuid from t_inc), pg_temp.doc('Needs a url') || jsonb_build_object('source_claims', jsonb_build_array(jsonb_build_object('kind', 'third_party_reuse'))));
select throws_ok(format($$select api.submit_version(%L, %L)$$, (select r ->> 'version_id' from t_inc), (select api.get_version((select (r ->> 'version_id')::uuid from t_inc)) ->> 'computed_hash')), 'PT422', 'incomplete_content', 'a third-party-reuse claim without a source URL cannot be submitted');
select api.delete_draft((select (r ->> 'version_id')::uuid from t_inc));
reset role;

select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
create temp table t_sub as select api.submit_version((select (r ->> 'version_id')::uuid from t_ids), (select api.get_version((select (r ->> 'version_id')::uuid from t_ids)) ->> 'computed_hash')) as r;
grant all on t_sub to public;
select is((select r ->> 'content_hash' from t_sub), (select h from t_dochash), 'submit_version: the frozen hash is the hash of the committed content');
select is(api.get_version((select (r ->> 'version_id')::uuid from t_ids)) ->> 'state', 'submitted', 'lifecycle moved to submitted');
reset role;
select is((select encode(content_hash, 'hex') from app.hack_versions where id = (select (r ->> 'version_id')::uuid from t_ids)), (select r ->> 'content_hash' from t_sub), 'the stored hash equals the hash returned');
select is(pg_temp.owner_val($$select (content_hash = app_content.version_hash(id))::text from app.hack_versions where frozen_at is not null limit 1$$), 'true', 'the stored hash equals the hash recomputed from the committed rows');
select is((select (frozen_at is not null and canon_version = 1)::text from app.hack_versions where id = (select (r ->> 'version_id')::uuid from t_ids)), 'true', 'frozen_at and canon_version are set');
select is((select count(*)::int from app.submissions where version_id = (select (r ->> 'version_id')::uuid from t_ids) and submitter_id = '00000000-0000-4000-8000-000000000001' and encode(content_hash, 'hex') = (select r ->> 'content_hash' from t_sub)), 1, 'the submission record exists and carries the same hash');

-- rejected edits after submission, through the api
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_ids), '{"title":"sneaky"}'), 'PT409', 'version_frozen', 'save_draft after submission is refused');
select throws_ok(format($$select api.delete_draft(%L)$$, (select r ->> 'version_id' from t_ids)), 'PT409', 'version_frozen', 'a submitted version can never be deleted');
select throws_ok(format($$select api.submit_version(%L, %L)$$, (select r ->> 'version_id' from t_ids), (select r ->> 'content_hash' from t_sub)), 'PT409', 'version_frozen', 'a version cannot be submitted twice');
reset role;

-- rejected edits after submission, directly in the tables (as the owner role: the strongest caller)
select is(pg_temp.code(pg_temp.owner_val(format($$update app.hack_versions set title = 'x' where id = %L$$, (select r ->> 'version_id' from t_ids)))), 'PT409:version_frozen', 'UPDATE of a frozen version is rejected');
select is(pg_temp.code(pg_temp.owner_val(format($$delete from app.hack_versions where id = %L$$, (select r ->> 'version_id' from t_ids)))), 'PT409:version_frozen', 'DELETE of a frozen version is rejected');
select is(pg_temp.code(pg_temp.owner_val(format($$update app.hack_versions set frozen_at = null, content_hash = null, canon_version = null where id = %L$$, (select r ->> 'version_id' from t_ids)))), 'PT409:version_frozen', 'a frozen version cannot be un-frozen');
select is(pg_temp.code(pg_temp.owner_val(format($$update app.hack_versions set content_hash = decode(repeat('00', 32), 'hex') where id = %L$$, (select r ->> 'version_id' from t_ids)))), 'PT409:version_frozen', 'the stored hash cannot be rewritten');
select is(pg_temp.code(pg_temp.owner_val('truncate app.hack_versions cascade')), 'PT409:truncate_forbidden', 'TRUNCATE of the version table is refused');
select is(pg_temp.code(pg_temp.owner_val('truncate app.hack_steps')), 'PT409:truncate_forbidden', 'TRUNCATE of a child table is refused');

-- every hashed child table rejects INSERT, UPDATE and DELETE once the parent is frozen
create temp table t_child_ops (tbl text, op text, stmt text);
insert into t_child_ops select 'hack_steps', 'INSERT', format($s$insert into app.hack_steps (version_id, position, body) values (%L, 9, 'late')$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'hack_steps', 'UPDATE', format($s$update app.hack_steps set body = 'late' where version_id = %L and position = 1$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'hack_steps', 'DELETE', format($s$delete from app.hack_steps where version_id = %L and position = 1$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'hack_materials', 'INSERT', format($s$insert into app.hack_materials (version_id, position, name) values (%L, 9, 'late')$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'hack_materials', 'UPDATE', format($s$update app.hack_materials set name = 'late' where version_id = %L and position = 1$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'hack_materials', 'DELETE', format($s$delete from app.hack_materials where version_id = %L and position = 1$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'hack_requirements', 'INSERT', format($s$insert into app.hack_requirements (version_id, kind, name) values (%L, 'tool', 'late')$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'hack_requirements', 'UPDATE', format($s$update app.hack_requirements set detail = 'late' where version_id = %L$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'hack_requirements', 'DELETE', format($s$delete from app.hack_requirements where version_id = %L$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'version_tags', 'INSERT', format($s$insert into app.version_tags (version_id, slug) values (%L, 'late')$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'version_tags', 'UPDATE', format($s$update app.version_tags set slug = 'late' where version_id = %L$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'version_tags', 'DELETE', format($s$delete from app.version_tags where version_id = %L$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'version_attributions', 'INSERT', format($s$insert into app.version_attributions (version_id, attribution_no, role, external_name) values (%L, 9, 'contributor', 'late')$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'version_attributions', 'UPDATE', format($s$update app.version_attributions set role = 'contributor' where version_id = %L$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'version_attributions', 'DELETE', format($s$delete from app.version_attributions where version_id = %L$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'source_claims', 'INSERT', format($s$insert into app.source_claims (version_id, claim_no, kind) values (%L, 9, 'original_work')$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'source_claims', 'UPDATE', format($s$update app.source_claims set kind = 'licensed' where version_id = %L$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'source_claims', 'DELETE', format($s$delete from app.source_claims where version_id = %L$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'version_assets', 'INSERT', format($s$insert into app.version_assets (version_id, sha256, asset_id) values (%L, decode(repeat('cd', 32), 'hex'), '30000000-0000-4000-8000-000000000009')$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'version_assets', 'UPDATE', format($s$update app.version_assets set asset_id = '30000000-0000-4000-8000-000000000009' where version_id = %L$s$, (select r ->> 'version_id' from t_ids));
insert into t_child_ops select 'version_assets', 'DELETE', format($s$delete from app.version_assets where version_id = %L$s$, (select r ->> 'version_id' from t_ids));
select is((select count(*)::int from t_child_ops), 21, '7 hashed child tables x INSERT/UPDATE/DELETE = 21 attempts');
select is(
  (select coalesce(string_agg(tbl || ' ' || op || ' -> ' || pg_temp.code(pg_temp.owner_val(stmt)), E'\n' order by tbl, op) filter (where pg_temp.code(pg_temp.owner_val(stmt)) <> 'PT409:version_frozen'), '') from t_child_ops),
  '', 'every one of the 21 child INSERT/UPDATE/DELETE attempts on a frozen version fails with version_frozen');
select is(pg_temp.owner_val(format($q$select (content_hash = app_content.version_hash(id))::text from app.hack_versions where id = %L$q$, (select r ->> 'version_id' from t_ids))), 'true', 'after all those attempts the stored hash still equals the recomputed hash');
select is(pg_temp.code(pg_temp.owner_val(format($$update app.submissions set content_hash = decode(repeat('00', 32), 'hex') where version_id = %L$$, (select r ->> 'version_id' from t_ids)))), 'PT409:submission_immutable', 'a submission cannot be updated');
select is(pg_temp.code(pg_temp.owner_val('delete from app.submissions')), 'PT409:submission_immutable', 'a submission cannot be deleted');

-- lifecycle is separate: it can change on a frozen version, content cannot
select is(pg_temp.owner_do(format($$update app.version_lifecycle set state = 'superseded', state_changed_at = now() where version_id = %L$$, (select r ->> 'version_id' from t_ids))), 'ok', 'superseding a frozen version (lifecycle only) succeeds');
select is((select state from app.version_lifecycle where version_id = (select (r ->> 'version_id')::uuid from t_ids)), 'superseded', 'and the state is now superseded');
select is(pg_temp.code(pg_temp.owner_val(format($$update app.hack_versions set title = 'x' where id = %L$$, (select r ->> 'version_id' from t_ids)))), 'PT409:version_frozen', 'while content stays immutable');
select is(pg_temp.owner_do(format($$update app.version_lifecycle set state = 'withdrawn' where version_id = %L$$, (select r ->> 'version_id' from t_ids))), 'ok', 'withdrawing a frozen version also only touches lifecycle');

-- the seal itself: only a correct, single-step freeze is possible
create temp table t_seal as select 1 as one;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
create temp table t_d2 as select api.create_draft() as r;
grant all on t_d2 to public;
select api.save_draft((select (r ->> 'version_id')::uuid from t_d2), pg_temp.doc('Seal tests'));
reset role;
select is(pg_temp.code(pg_temp.owner_val(format($$update app.hack_versions set frozen_at = now(), content_hash = decode(repeat('00', 32), 'hex'), canon_version = 1 where id = %L$$, (select r ->> 'version_id' from t_d2)))), 'PT409:hash_mismatch', 'a hand-made freeze with a wrong hash is rejected by the trigger');
select is(pg_temp.code(pg_temp.owner_val(format($$update app.hack_versions set content_hash = decode(repeat('00', 32), 'hex') where id = %L$$, (select r ->> 'version_id' from t_d2)))), 'PT409:seal_incomplete', 'a hash without frozen_at is rejected (the table also carries a seal_all_or_none check as a second wall)');
select is(pg_temp.code(pg_temp.owner_val(format($$update app.hack_versions set frozen_at = now(), canon_version = 1, title = 'changed while freezing', content_hash = app_content.version_hash(id) where id = %L$$, (select r ->> 'version_id' from t_d2)))), 'PT409:freeze_must_not_change_content', 'the freeze cannot change content in the same statement');
select is(pg_temp.code(pg_temp.owner_val(format($$update app.hack_versions set version_no = 9 where id = %L$$, (select r ->> 'version_id' from t_d2)))), 'PT409:identity_immutable', 'identity columns never change, even on a draft');
select is(pg_temp.code(pg_temp.owner_val(format($$update app.hack_versions set created_by = '00000000-0000-4000-8000-000000000002' where id = %L$$, (select r ->> 'version_id' from t_d2)))), 'PT409:identity_immutable', 'ownership cannot be reassigned');
select is(pg_temp.code(pg_temp.owner_val(format($$insert into app.hack_versions (hack_id, version_no, created_by, frozen_at, content_hash, canon_version) values (%L, 5, '00000000-0000-4000-8000-000000000001', now(), decode(repeat('00', 32), 'hex'), 1)$$, (select r ->> 'hack_id' from t_d2)))), 'PT409:version_frozen', 'a version cannot be inserted already frozen');

-- ===================================================================================================================
-- C. revisions and one open draft per hack
-- ===================================================================================================================
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
create temp table t_rev as select api.create_draft((select (r ->> 'hack_id')::uuid from t_ids)) as r;
grant all on t_rev to public;
select is((select r ->> 'version_no' from t_rev), '2', 'a revision of a submitted hack is version 2');
select throws_ok(format($$select api.create_draft(%L)$$, (select r ->> 'hack_id' from t_ids)), 'PT409', 'open_draft_exists', 'only one open draft per hack');
select lives_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_rev), '{"title":"Revision two"}'), 'the new revision is editable');
select is((api.get_version((select (r ->> 'version_id')::uuid from t_ids))) -> 'content' ->> 'title', 'Keep herbs fresh', 'version 1 is untouched by edits to version 2');
reset role;

-- ===================================================================================================================
-- D. child moves check BOTH parents
-- ===================================================================================================================
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
create temp table t_ma as select api.create_draft() as r;
create temp table t_mb as select api.create_draft() as r;
grant all on t_ma to public; grant all on t_mb to public;
select api.save_draft((select (r ->> 'version_id')::uuid from t_ma), pg_temp.doc('Move source') || jsonb_build_object('tags', jsonb_build_array('moveme', 'stay')));
select api.save_draft((select (r ->> 'version_id')::uuid from t_mb), pg_temp.doc('Move target'));
reset role;
select is(pg_temp.owner_do(format($$update app.version_tags set version_id = %L where version_id = %L and slug = 'moveme'$$, (select r ->> 'version_id' from t_mb), (select r ->> 'version_id' from t_ma))), 'ok', 'moving a child between two DRAFTS is allowed');
select is((select count(*)::int from app.version_tags where version_id = (select (r ->> 'version_id')::uuid from t_mb) and slug = 'moveme'), 1, 'and the row is now in the target draft');
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select api.submit_version((select (r ->> 'version_id')::uuid from t_ma), (select api.get_version((select (r ->> 'version_id')::uuid from t_ma)) ->> 'computed_hash'));
reset role;
select is(pg_temp.code(pg_temp.owner_val(format($$update app.version_tags set version_id = %L where version_id = %L and slug = 'stay'$$, (select r ->> 'version_id' from t_mb), (select r ->> 'version_id' from t_ma)))), 'PT409:version_frozen', 'moving a child OUT of a frozen version is rejected (old parent)');
select is(pg_temp.code(pg_temp.owner_val(format($$update app.version_tags set version_id = %L where version_id = %L and slug = 'moveme'$$, (select r ->> 'version_id' from t_ma), (select r ->> 'version_id' from t_mb)))), 'PT409:version_frozen', 'moving a child INTO a frozen version is rejected (new parent)');
select is(pg_temp.owner_val(format($q$select (content_hash = app_content.version_hash(id))::text from app.hack_versions where id = %L$q$, (select r ->> 'version_id' from t_ma))), 'true', 'the frozen version still hashes to its stored hash after both attempts');

-- ===================================================================================================================
-- E. ownership and unauthorized access (every function, every way in)
-- ===================================================================================================================
-- another member (u2) cannot see, edit, submit or delete u1's version, and cannot tell it from a missing one
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002');
select throws_ok(format($$select api.get_version(%L)$$, (select r ->> 'version_id' from t_rev)), 'PT404', 'not_found', 'get_version: another member gets not_found');
select throws_ok(format($$select api.save_draft(%L, '{"title":"x"}'::jsonb)$$, (select r ->> 'version_id' from t_rev)), 'PT404', 'not_found', 'save_draft: another member gets not_found');
select throws_ok(format($$select api.submit_version(%L, %L)$$, (select r ->> 'version_id' from t_rev), repeat('a', 64)), 'PT404', 'not_found', 'submit_version: another member gets not_found');
select throws_ok(format($$select api.delete_draft(%L)$$, (select r ->> 'version_id' from t_rev)), 'PT404', 'not_found', 'delete_draft: another member gets not_found');
select throws_ok(format($$select api.create_draft(%L)$$, (select r ->> 'hack_id' from t_rev)), 'PT404', 'not_found', 'create_draft: another member cannot add a revision to someone else''s hack');
select throws_ok($$select api.get_version('99999999-9999-4999-8999-999999999999')$$, 'PT404', 'not_found', 'a version that does not exist gives the identical answer');
reset role;
-- staff authority is not content authority: an admin (u3) cannot read or edit a member's draft through these functions
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003');
select throws_ok(format($$select api.get_version(%L)$$, (select r ->> 'version_id' from t_rev)), 'PT404', 'not_found', 'an admin is not the owner: get_version gives not_found');
select throws_ok(format($$select api.save_draft(%L, '{"title":"x"}'::jsonb)$$, (select r ->> 'version_id' from t_rev)), 'PT404', 'not_found', 'an admin cannot edit a member''s draft');
reset role;
-- the draft is unchanged by all of that
select is((select title from app.hack_versions where id = (select (r ->> 'version_id')::uuid from t_rev)), 'Revision two', 'the draft was not touched by the unauthorized attempts');

-- anon and service_role cannot execute any content function; no claims / signed-out / disabled are refused by the guard
select is(
  (select coalesce(string_agg(f, ', ' order by f), '') from (values
     ('create_draft()'), ('save_draft(''10000000-0000-4000-8000-000000000001'', ''{}'')'), ('get_version(''10000000-0000-4000-8000-000000000001'')'),
     ('list_my_versions()'), ('submit_version(''10000000-0000-4000-8000-000000000001'', ''aa'')'), ('delete_draft(''10000000-0000-4000-8000-000000000001'')')) v(f)
    where pg_temp.code(pg_temp.as_val('anon', 'select api.' || f)) not like '42501:%'),
  '', 'anon: EXECUTE denied on all six content functions (42501)');
select is(
  (select coalesce(string_agg(f, ', ' order by f), '') from (values
     ('create_draft()'), ('save_draft(''10000000-0000-4000-8000-000000000001'', ''{}'')'), ('get_version(''10000000-0000-4000-8000-000000000001'')'),
     ('list_my_versions()'), ('submit_version(''10000000-0000-4000-8000-000000000001'', ''aa'')'), ('delete_draft(''10000000-0000-4000-8000-000000000001'')')) v(f)
    where pg_temp.code(pg_temp.as_val('service_role', 'select api.' || f)) not like '42501:%'),
  '', 'service_role: EXECUTE denied on all six content functions (42501)');
select set_config('request.jwt.claims', '', true);
select is(
  (select coalesce(string_agg(f, ', ' order by f), '') from (values
     ('create_draft()'), ('save_draft(''10000000-0000-4000-8000-000000000001'', ''{}'')'), ('get_version(''10000000-0000-4000-8000-000000000001'')'),
     ('list_my_versions()'), ('submit_version(''10000000-0000-4000-8000-000000000001'', ''aa'')'), ('delete_draft(''10000000-0000-4000-8000-000000000001'')')) v(f)
    where pg_temp.code(pg_temp.as_val('authenticated', 'select api.' || f)) not like '28000:not_authenticated'),
  '', 'authenticated role without verified claims: all six refuse (not_authenticated)');
-- a signed-out session (row removed) and a disabled account are refused by every function
delete from auth.sessions where id = '10000000-0000-4000-8000-000000000002';
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002');
select is(
  (select coalesce(string_agg(f, ', ' order by f), '') from (values
     ('create_draft()'), ('save_draft(''10000000-0000-4000-8000-000000000001'', ''{}'')'), ('get_version(''10000000-0000-4000-8000-000000000001'')'),
     ('list_my_versions()'), ('submit_version(''10000000-0000-4000-8000-000000000001'', ''aa'')'), ('delete_draft(''10000000-0000-4000-8000-000000000001'')')) v(f)
    where pg_temp.code(pg_temp.as_val('authenticated', 'select api.' || f)) not like '28000:session_invalid'),
  '', 'a signed-out session whose token is otherwise valid is refused by all six functions');
reset role;
select pg_temp.owner_run($$update app.accounts set status = 'disabled' where user_id = '00000000-0000-4000-8000-000000000001'$$);
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select is(
  (select coalesce(string_agg(f, ', ' order by f), '') from (values
     ('create_draft()'), ('save_draft(''10000000-0000-4000-8000-000000000001'', ''{}'')'), ('get_version(''10000000-0000-4000-8000-000000000001'')'),
     ('list_my_versions()'), ('submit_version(''10000000-0000-4000-8000-000000000001'', ''aa'')'), ('delete_draft(''10000000-0000-4000-8000-000000000001'')')) v(f)
    where pg_temp.code(pg_temp.as_val('authenticated', 'select api.' || f)) not like '42501:account_inactive'),
  '', 'a disabled account is refused by all six functions, even for its own versions');
reset role;
select pg_temp.owner_run($$update app.accounts set status = 'active' where user_id = '00000000-0000-4000-8000-000000000001'$$);

-- no direct table access for members, anon, service_role: not even SELECT
select is(
  (select coalesce(string_agg(r.role_name || ' ' || t.tbl || ' ' || o.op, E'\n' order by r.role_name, t.tbl, o.op), '') from
     (values ('authenticated'), ('anon'), ('service_role')) r(role_name)
     cross join (values ('categories'), ('hacks'), ('hack_versions'), ('version_lifecycle'), ('submissions'), ('hack_steps'), ('hack_materials'), ('hack_requirements'), ('version_tags'), ('version_attributions'), ('source_claims'), ('version_assets')) t(tbl)
     cross join (values ('select 1 from app.%s limit 1'), ('delete from app.%s'), ('truncate app.%s')) o(op)
    where pg_temp.code(pg_temp.as_val(r.role_name, format(o.op, t.tbl))) not like '42501:%'),
  '', 'authenticated, anon and service_role are denied SELECT, DELETE and TRUNCATE on all 12 content tables (42501)');
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select is(pg_temp.code(pg_temp.as_val('authenticated', format($$update app.hack_versions set title = 'direct' where id = %L$$, (select r ->> 'version_id' from t_rev)))), '42501:permission denied for schema app', 'a member cannot write their own draft directly: writes only through save_draft');
select is(pg_temp.code(pg_temp.as_val('authenticated', $$insert into app.hack_steps (version_id, position, body) values ('10000000-0000-4000-8000-000000000001', 1, 'x')$$)), '42501:permission denied for schema app', 'a member cannot insert child rows directly');
reset role;

-- ===================================================================================================================
-- F. limits and deletion
-- ===================================================================================================================
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-0000000000e2');
reset role;
insert into auth.sessions (id, user_id) values ('10000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-000000000002');
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-0000000000e2');
do $$ begin for i in 1..20 loop perform api.create_draft(); end loop; end $$;
select throws_ok($$select api.create_draft()$$, 'PT429', 'too_many_drafts', 'a member cannot hold more than 20 open drafts');
reset role;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
create temp table t_del as select api.create_draft() as r;
grant all on t_del to public;
select api.save_draft((select (r ->> 'version_id')::uuid from t_del), pg_temp.doc('To be deleted'));
select is(api.delete_draft((select (r ->> 'version_id')::uuid from t_del)), '{"deleted": true}'::jsonb, 'an abandoned draft can be deleted by its owner');
reset role;
select is((select count(*)::int from app.hack_versions where id = (select (r ->> 'version_id')::uuid from t_del)) + (select count(*)::int from app.hack_steps where version_id = (select (r ->> 'version_id')::uuid from t_del)) + (select count(*)::int from app.hacks where id = (select (r ->> 'hack_id')::uuid from t_del)), 0, 'the draft, its children and its (now empty) hack are gone');

-- ===================================================================================================================
-- H1. the category slug is part of the hash, so it is immutable (names stay editable)
-- ===================================================================================================================
select is(pg_temp.code(pg_temp.owner_do($$update app.categories set slug = 'kitchen-renamed' where slug = 'kitchen'$$)), 'PT409:category_slug_immutable', 'a category slug cannot be changed (a frozen version hashes it)');
select is(pg_temp.owner_val(format($q$select (content_hash = app_content.version_hash(id))::text from app.hack_versions where id = %L$q$, (select r ->> 'version_id' from t_ids))), 'true', 'after the attempted rename the frozen version still hashes to its stored hash');
select is(pg_temp.code(pg_temp.owner_do($$update app.categories set slug = 'home-renamed' where slug = 'home'$$)), 'PT409:category_slug_immutable', 'even an unreferenced category cannot change its slug');
select pg_temp.owner_try($$update app.categories set slug = 'kitchen' where slug = 'kitchen-renamed'$$);   -- (only does anything on code without the guard: restores the fixture so later sections still run)
select pg_temp.owner_try($$update app.categories set slug = 'home' where slug = 'home-renamed'$$);
select is(pg_temp.owner_do($$update app.categories set name = 'Kitchen & Cooking' where slug = 'kitchen'$$), 'ok', 'the display name remains editable');
select is(pg_temp.code(pg_temp.owner_do($$update app.categories set id = pg_catalog.gen_random_uuid() where slug = 'kitchen'$$)), 'PT409:category_id_immutable', 'a category id cannot change either');
select is(pg_temp.code(pg_temp.owner_do($$delete from app.categories where slug = 'kitchen'$$)), '23503:update or delete on table "categories" violates foreign key constraint "hack_versions_category_id_fkey" on table "hack_versions"', 'a referenced category cannot be deleted');

-- ===================================================================================================================
-- H2. size limits are enforced BEFORE any replacement starts
-- ===================================================================================================================
-- canary: counts every UPDATE of a version and every DELETE of a step, outside the transaction (a sequence is not rolled back)
select pg_temp.owner_run($$create sequence app_content.zz_canary_seq$$);
select pg_temp.owner_run($outer$create function app_content.zz_canary() returns trigger language plpgsql security definer set search_path = '' as $f$ begin perform pg_catalog.nextval('app_content.zz_canary_seq'); if tg_op = 'DELETE' then return old; end if; return new; end $f$$outer$);
select pg_temp.owner_run($$create trigger zz_canary_v before update on app.hack_versions for each row execute function app_content.zz_canary()$$);
select pg_temp.owner_run($$create trigger zz_canary_s before delete on app.hack_steps for each row execute function app_content.zz_canary()$$);
select pg_temp.owner_run($$create trigger zz_canary_t before delete on app.version_tags for each row execute function app_content.zz_canary()$$);
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
create temp table t_lim as select api.create_draft() as r;
grant all on t_lim to public;
select api.save_draft((select (r ->> 'version_id')::uuid from t_lim), pg_temp.doc('Limits baseline'));
create temp table t_lim_before as select api.get_version((select (r ->> 'version_id')::uuid from t_lim)) as r;
grant all on t_lim_before to public;
reset role;

create function pg_temp.canary() returns bigint language plpgsql as $$
declare v text;
begin v := pg_temp.owner_val('select last_value::text from app_content.zz_canary_seq'); return v::bigint; end $$;
create temp table t_c0 as select pg_temp.canary() as n;
grant all on t_c0 to public;

-- list-count boundaries: exactly the cap is accepted, one more is rejected with limit_exceeded naming the list
create function pg_temp.items(p_kind text, p_n integer) returns jsonb language sql as $$
  select coalesce(jsonb_agg(case p_kind
      when 'requirements' then jsonb_build_object('kind', 'tool', 'name', 'req ' || g)
      when 'tags' then to_jsonb('tag-' || g)
      when 'assets' then jsonb_build_object('asset_id', '30000000-0000-4000-8000-' || lpad(g::text, 12, '0'), 'sha256', lpad(to_hex(g), 64, '0'))
      when 'steps' then to_jsonb('step ' || g)
      when 'materials' then jsonb_build_object('name', 'material ' || g)
      when 'attributions' then jsonb_build_object('role', 'contributor', 'external_name', 'person ' || g)
      when 'source_claims' then jsonb_build_object('kind', 'original_work')
    end), '[]'::jsonb) from generate_series(1, p_n) g $$;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select lives_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('requirements', pg_temp.items('requirements', 30))), '30 requirements are accepted');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('requirements', pg_temp.items('requirements', 31))), 'PT422', 'limit_exceeded', '31 requirements are rejected');
select lives_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('tags', pg_temp.items('tags', 10))), '10 tags are accepted');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('tags', pg_temp.items('tags', 11))), 'PT422', 'limit_exceeded', '11 tags are rejected');
select lives_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('assets', pg_temp.items('assets', 20))), '20 assets are accepted');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('assets', pg_temp.items('assets', 21))), 'PT422', 'limit_exceeded', '21 assets are rejected');
select lives_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('steps', pg_temp.items('steps', 50))), '50 steps are accepted');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('steps', pg_temp.items('steps', 51))), 'PT422', 'limit_exceeded', '51 steps are rejected');
select lives_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('materials', pg_temp.items('materials', 50))), '50 materials are accepted');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('materials', pg_temp.items('materials', 51))), 'PT422', 'limit_exceeded', '51 materials are rejected');
select lives_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('attributions', pg_temp.items('attributions', 10))), '10 attributions are accepted');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('attributions', pg_temp.items('attributions', 11))), 'PT422', 'limit_exceeded', '11 attributions are rejected');
select lives_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('source_claims', pg_temp.items('source_claims', 10))), '10 source claims are accepted');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('source_claims', pg_temp.items('source_claims', 11))), 'PT422', 'limit_exceeded', '11 source claims are rejected');

-- put the baseline back, remember the canary, then reject a series of oversize documents: nothing may be updated or deleted
select api.save_draft((select (r ->> 'version_id')::uuid from t_lim), pg_temp.doc('Limits baseline') || jsonb_build_object('tags', pg_temp.items('tags', 3)));
reset role;
create temp table t_c1 as select pg_temp.canary() as n;
grant all on t_c1 to public;
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
create temp table t_lim_before2 as select api.get_version((select (r ->> 'version_id')::uuid from t_lim)) as r;
grant all on t_lim_before2 to public;
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('title', 'changed', 'tags', pg_temp.items('tags', 11))), 'PT422', 'limit_exceeded', 'an oversize list is rejected even when other fields are valid');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('title', 'changed', 'requirements', pg_temp.items('requirements', 31))), 'PT422', 'limit_exceeded', 'an oversize requirements list is rejected');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('title', 'changed', 'assets', pg_temp.items('assets', 21))), 'PT422', 'limit_exceeded', 'an oversize assets list is rejected');
reset role;
select is((select n from t_c1), pg_temp.canary(), 'rejected oversize saves performed no UPDATE of the version and no DELETE of children (rejection happens before replacement begins)');
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select is(api.get_version((select (r ->> 'version_id')::uuid from t_lim)), (select r from t_lim_before2), 'and the draft is exactly as before');

-- document size: the cap is 131072 bytes of JSON text, checked first
create function pg_temp.sized(p_bytes integer) returns jsonb language sql as $$
  -- {"zz": "<n a's>"} renders as 10 + n bytes
  select jsonb_build_object('zz', repeat('a', p_bytes - 10)) $$;
select is(octet_length((pg_temp.sized(131072))::text), 131072, 'test helper: builds a document of exactly 131072 bytes');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), pg_temp.sized(131073)), 'PT422', 'limit_exceeded', 'a document of 131073 bytes is rejected as too large (before its unknown key is even examined)');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), pg_temp.sized(131072)), 'PT422', 'invalid_content', 'a document of exactly 131072 bytes passes the size check (and is then rejected for its unknown key)');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), jsonb_build_object('title', 'x', 'summary', repeat('é', 70000))), 'PT422', 'limit_exceeded', 'multi-byte text counts in bytes: 70000 two-byte characters exceed the cap');
reset role;
select is((select n from t_c1), pg_temp.canary(), 'oversize documents performed no UPDATE and no DELETE either');

-- the database also backstops the three lists that had no cap: direct writes beyond the cap fail
select pg_temp.owner_run(format($$delete from app.hack_requirements where version_id = %L$$, (select r ->> 'version_id' from t_lim)));
select pg_temp.owner_run(format($$insert into app.hack_requirements (version_id, kind, name) select %L, 'tool', 'n' || g from generate_series(1, 30) g$$, (select r ->> 'version_id' from t_lim)));
select is(pg_temp.code(pg_temp.owner_do(format($$insert into app.hack_requirements (version_id, kind, name) values (%L, 'tool', 'one too many')$$, (select r ->> 'version_id' from t_lim)))), 'PT422:limit_exceeded', 'direct insert of a 31st requirement fails in the database');
select is(pg_temp.code(pg_temp.owner_do(format($$insert into app.version_tags (version_id, slug) select %L, 'x' || g from generate_series(1, 8) g$$, (select r ->> 'version_id' from t_lim)))), 'PT422:limit_exceeded', 'direct insert beyond 10 tags fails in the database (3 exist + 8)');
select is(pg_temp.code(pg_temp.owner_do(format($$insert into app.version_assets (version_id, sha256, asset_id) select %L, decode(lpad(to_hex(g + 1000), 64, '0'), 'hex'), pg_catalog.gen_random_uuid() from generate_series(1, 21) g$$, (select r ->> 'version_id' from t_lim)))), 'PT422:limit_exceeded', 'direct insert of 21 assets fails in the database');

-- ===================================================================================================================
-- H3. identifiers must be in the documented form, on write as well as in the hash
-- ===================================================================================================================
select pg_temp.act('authenticated', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), '{"attributions":[{"role":"author","profile_id":"00000000-0000-4000-8000-00000000000A"}]}'), 'PT422', 'invalid_content', 'an UPPERCASE profile_id is rejected at input');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), '{"attributions":[{"role":"author","profile_id":"{00000000-0000-4000-8000-000000000001}"}]}'), 'PT422', 'invalid_content', 'a braced profile_id is rejected');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), '{"attributions":[{"role":"author","profile_id":"00000000000040008000000000000001"}]}'), 'PT422', 'invalid_content', 'a profile_id without hyphens is rejected');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), format('{"assets":[{"asset_id":"30000000-0000-4000-8000-00000000000B","sha256":"%s"}]}', repeat('ab', 32))), 'PT422', 'invalid_content', 'an UPPERCASE asset_id is rejected');
select throws_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), format('{"assets":[{"asset_id":"30000000-0000-4000-8000-00000000000b","sha256":"%s"}]}', upper(repeat('ab', 32)))), 'PT422', 'invalid_content', 'an uppercase sha256 is rejected');
select lives_ok(format($$select api.save_draft(%L, %L::jsonb)$$, (select r ->> 'version_id' from t_lim), '{"attributions":[{"role":"author","profile_id":"00000000-0000-4000-8000-0000000000aa"}]}'), 'the documented lowercase hyphenated form is accepted');
reset role;
select is(pg_temp.owner_val(format($q$select (app_content.canonical_text(%L::uuid) = app_content.canonical_text_json(app_content.version_doc(%L::uuid)))::text$q$, (select r ->> 'version_id' from t_lim), (select r ->> 'version_id' from t_lim))), 'true', 'the rebuilt document and the input document render identically for identifiers');

-- remove the canary objects
select pg_temp.owner_run($$drop trigger zz_canary_v on app.hack_versions$$);
select pg_temp.owner_run($$drop trigger zz_canary_s on app.hack_steps$$);
select pg_temp.owner_run($$drop trigger zz_canary_t on app.version_tags$$);

-- ===================================================================================================================
-- G. global invariant
-- ===================================================================================================================
select is(pg_temp.owner_val($$select count(*)::text from app.hack_versions v where v.frozen_at is not null and v.content_hash is distinct from app_content.version_hash(v.id)$$), '0', 'every frozen version in the database has a stored hash equal to the hash recomputed from its committed rows');
select is(pg_temp.owner_val($$select count(*)::text from app.submissions s join app.hack_versions v on v.id = s.version_id where s.content_hash is distinct from v.content_hash$$), '0', 'every submission carries the hash of its version');

select * from finish();
rollback;
