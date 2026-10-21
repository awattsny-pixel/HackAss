-- PX-3a: private saving of prompts and results. Ownership, versions, payload-bound retries with ORIGINAL receipts, snapshots, the atomic combined save, quotas, export,
-- grants and erasure, as real roles through the real guard. Two-CONNECTION races (competing updates, identical creates, quota) are in scripts/local-px3a-checks.mjs.
begin;
select no_plan();

create function pg_temp.set_claims(p_role text, p_sub uuid, p_sid uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role', p_role, 'sub', p_sub, 'session_id', p_sid, 'aal', 'aal1')::text, true); end $$;
create function pg_temp.u(n integer) returns uuid language sql as $$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.s(n integer) returns uuid language sql as $$ select ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.as_member(n integer) returns void language plpgsql as $$ begin perform pg_temp.set_claims('authenticated', pg_temp.u(n), pg_temp.s(n)); end $$;
-- run an api call as `authenticated` and return its jsonb
create function pg_temp.api(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin perform set_config('role', 'authenticated', true); execute p_sql into v; perform set_config('role', 'none', true); return v; end $$;
-- run any statement as p_role; return 'SQLSTATE|message|detail' on error, 'OK' otherwise
create function pg_temp.err(p_role text, p_sql text) returns text language plpgsql as $$
declare m text; d text; c text;
begin
  perform set_config('role', p_role, true);
  begin execute p_sql;
  exception when others then
    get stacked diagnostics m = message_text, d = pg_exception_detail, c = returned_sqlstate;
    perform set_config('role', 'none', true); return c || '|' || m || '|' || coalesce(d, '');
  end;
  perform set_config('role', 'none', true); return 'OK';
end $$;
create function pg_temp.owner_val(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('role', 'hackass_owner', true);
  begin execute p_sql into v; exception when others then perform set_config('role', 'none', true); return 'ERR:' || sqlstate || ':' || sqlerrm; end;
  perform set_config('role', 'none', true); return coalesce(v, 'NULL');
end $$;
create function pg_temp.pdoc(p_title text default 'Title', p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('title', p_title, 'output_format', 'Concise summary', 'full_prompt', 'do the thing', 'starting_prompt', 'starter text', 'origin_kind', 'scratch') || p_extra $$;
create function pg_temp.rdoc(p_outcome text default 'partial', p_text text default 'half worked') returns jsonb language sql as $$
  select jsonb_build_object('outcome', p_outcome, 'reflection', p_text, 'next_change', 'add budget') $$;
create temp table t_k (k text primary key, v jsonb);
grant all on t_k to public;
create function pg_temp.k(p_key text) returns jsonb language sql as $$ select v from t_k where k = p_key $$;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select (v ->> 'id')::uuid from t_k where k = p_key $$;

insert into auth.users (id, aud, role, email) select pg_temp.u(i), 'authenticated', 'authenticated', 'work' || i || '@example.test' from generate_series(1, 3) i;
insert into auth.sessions (id, user_id) select pg_temp.s(i), pg_temp.u(i) from generate_series(1, 3) i;

-- ---- structure and grants ------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relname in ('saved_prompts', 'saved_reflections') and c.relrowsecurity and not c.relforcerowsecurity), 2, 'both tables have RLS on');
select is((select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname in ('saved_prompts', 'saved_reflections')), 0, 'and no policy exists (default deny)');
select is((select string_agg(r.rolname || ':' || p.priv, ',' order by r.rolname, p.priv) from pg_class c cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'hackass_worker')) r
             cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv) where c.relname in ('saved_prompts', 'saved_reflections') and has_table_privilege(r.rolname, c.oid, p.priv)), null, 'no application role holds any privilege on the two tables');
select is((select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'api' and p.proname in ('save_prompt','get_my_prompt','list_my_prompts','delete_my_prompt','save_reflection','save_prompt_and_result','update_my_reflection','delete_my_reflection','list_my_results','get_my_result','export_my_data')
              and not (has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('hackass_worker', p.oid, 'execute'))), null,
          'all eleven member functions: executable by authenticated, never by anon, service_role or the worker');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname in ('save_prompt','get_my_prompt','list_my_prompts','delete_my_prompt','save_reflection','save_prompt_and_result','update_my_reflection','delete_my_reflection','list_my_results','get_my_result','export_my_data')), 11, 'exactly eleven member functions exist');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app_work' and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))), 0, 'the app_work helpers are not executable by any API role');
select is((select count(*)::int from pg_trigger t where t.tgrelid = 'auth.users'::regclass and t.tgname = 'hackass_work_content_deleted' and not t.tgisinternal), 1, 'the erasure trigger is installed on auth.users');

-- ---- direct access and anonymous callers --------------------------------------------------------------------------------------------------------
select is(pg_temp.err('authenticated', 'select * from app.saved_prompts'), '42501|permission denied for schema app|', 'authenticated cannot read the tables directly (denied at the schema)');
select is(pg_temp.err('service_role', 'select * from app.saved_reflections'), '42501|permission denied for schema app|', 'service_role cannot read the tables directly (denied at the schema)');
select is(left(pg_temp.err('anon', 'select api.export_my_data(''summary'')'), 5), '42501', 'anon cannot execute the member functions');
select is(left(pg_temp.err('service_role', 'select api.list_my_prompts()'), 5), '42501', 'service_role cannot execute the member functions');

-- ---- ownership: A creates, B cannot touch --------------------------------------------------------------------------------------------------------
select pg_temp.as_member(1);
insert into t_k values ('a1', pg_temp.api(format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('A one'))));
select is((pg_temp.k('a1') ->> 'version')::int, 1, 'A creates a prompt at version 1');
select pg_temp.as_member(2);
select is(pg_temp.err('authenticated', format('select api.get_my_prompt(%L)', pg_temp.id('a1'))), 'PT404|not_found|', 'B cannot read A''s prompt');
select is(pg_temp.err('authenticated', format('select api.get_my_prompt(%L)', gen_random_uuid())), 'PT404|not_found|', 'a nonexistent id gives the IDENTICAL error');
select is(pg_temp.err('authenticated', format('select api.save_prompt(%L, %L::jsonb, %L, 1)', gen_random_uuid(), pg_temp.pdoc('hijack'), pg_temp.id('a1'))), 'PT404|not_found|', 'B cannot update A''s prompt');
select is(pg_temp.err('authenticated', format('select api.delete_my_prompt(%L, 1)', pg_temp.id('a1'))), 'PT404|not_found|', 'B cannot delete A''s prompt');
select is(pg_temp.err('authenticated', format('select api.save_reflection(%L, %L, 1, %L::jsonb)', gen_random_uuid(), pg_temp.id('a1'), pg_temp.rdoc())), 'PT404|not_found|', 'B cannot attach a result to A''s prompt');
select is(pg_temp.err('authenticated', format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb, %L, 1)', gen_random_uuid(), pg_temp.pdoc('hijack'), pg_temp.rdoc(), pg_temp.id('a1'))), 'PT404|not_found|', 'B cannot use the combined save on A''s prompt');
select is((pg_temp.api('select api.list_my_prompts()') -> 'items'), '[]'::jsonb, 'B lists none of A''s prompts');
select is(pg_temp.owner_val(format('select count(*)::text from app.saved_prompts where owner_id = %L', pg_temp.u(2))), '0', 'and nothing was written for B by the refused attempts');

-- ---- versions, validation, pagination -------------------------------------------------------------------------------------------------------------
select pg_temp.as_member(1);
select is(left(pg_temp.err('authenticated', format('select api.save_prompt(%L, %L::jsonb, %L, 7)', gen_random_uuid(), pg_temp.pdoc('x'), pg_temp.id('a1'))), 5), 'PT409', 'a wrong expected version is a conflict');
select is(left(pg_temp.err('authenticated', format('select api.save_prompt(%L, %L::jsonb, %L)', gen_random_uuid(), pg_temp.pdoc('x'), pg_temp.id('a1'))), 5), 'PT422', 'an update without an expected version is refused');
insert into t_k values ('a1v2', pg_temp.api(format('select api.save_prompt(%L, %L::jsonb, %L, 1)', gen_random_uuid(), pg_temp.pdoc('A one edited'), pg_temp.id('a1'))));
select is((pg_temp.k('a1v2') ->> 'version')::int, 2, 'an update at the right version gives version 2');
select is(pg_temp.err('authenticated', format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('x', '{"owner_id":"00000000-0000-0000-0000-000000000000"}'))), 'PT422|invalid_content|(root).owner_id', 'an unknown key (owner_id) is rejected, naming only the key');
select is(pg_temp.err('authenticated', format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc(repeat('x', 121)))), 'PT422|invalid_content|title', 'a title over 120 characters is rejected, naming only the field');
select is(left(pg_temp.err('authenticated', format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('x', '{"origin_kind":"catalog"}'))), 5), 'PT422', 'catalog origin without a slug is rejected');
select is(left(pg_temp.err('authenticated', format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('x', '{"origin_kind":"catalog","origin_slug":"../x"}'))), 5), 'PT422', 'a malformed slug is rejected');
select is(left(pg_temp.err('authenticated', format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), '{"title":5}')), 5), 'PT422', 'a non-string field is rejected');
select is((pg_temp.api(format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('Demo practice', '{"origin_kind":"demo","origin_title":"Pantry meal"}'))) ->> 'version')::int, 1, 'a demo-origin prompt is accepted (attribution kept)');
select is(pg_temp.err('authenticated', 'select api.list_my_prompts(0)'), 'PT422|invalid_content|p_limit', 'limit 0 is refused');
select is(pg_temp.err('authenticated', 'select api.list_my_prompts(101)'), 'PT422|invalid_content|p_limit', 'limit 101 is refused');
select pg_temp.api(format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('P' || i))) from generate_series(1, 3) i;
insert into t_k values ('pg1', pg_temp.api('select api.list_my_prompts(2)'));
insert into t_k values ('pg2', pg_temp.api(format('select api.list_my_prompts(2, %L::timestamptz, %L::uuid)', pg_temp.k('pg1') -> 'next_cursor' ->> 'updated_at', pg_temp.k('pg1') -> 'next_cursor' ->> 'id')));
select is(jsonb_array_length(pg_temp.k('pg1') -> 'items'), 2, 'keyset pagination: first page has 2 and a next cursor');
select ok(pg_temp.k('pg1') -> 'next_cursor' is not null and jsonb_array_length(pg_temp.k('pg2') -> 'items') >= 1, 'and the second page continues');
select is((select count(*)::int from jsonb_array_elements(pg_temp.k('pg1') -> 'items') x join jsonb_array_elements(pg_temp.k('pg2') -> 'items') y on x ->> 'id' = y ->> 'id'), 0, 'with no overlap between pages');

-- ---- RETRIES ARE BOUND TO THEIR PAYLOAD AND ANSWERED WITH THE ORIGINAL RECEIPT ---------------------------------------------------------------------------
insert into t_k values ('rq', jsonb_build_object('id', gen_random_uuid()));
insert into t_k values ('c1', pg_temp.api(format('select api.save_prompt(%L, %L::jsonb)', pg_temp.id('rq'), pg_temp.pdoc('Text A'))));
insert into t_k values ('c1r', pg_temp.api(format('select api.save_prompt(%L, %L::jsonb)', pg_temp.id('rq'), pg_temp.pdoc('Text A'))));
select is(pg_temp.k('c1r') ->> 'id', pg_temp.k('c1') ->> 'id', 'an IDENTICAL create retry returns the same prompt (no duplicate)');
select is(pg_temp.owner_val(format('select count(*)::text from app.saved_prompts where owner_id = %L and title = ''Text A''', pg_temp.u(1))), '1', 'and exactly one row exists');
select is(pg_temp.err('authenticated', format('select api.save_prompt(%L, %L::jsonb)', pg_temp.id('rq'), pg_temp.pdoc('Text A but different'))), 'PT409|request_reuse|p_request_id', 'the SAME request id with DIFFERENT content is refused, not silently answered');
-- THE REGRESSION: the response to the create is lost; another tab saves text B; the retry must NOT acknowledge text A with B's newer version
insert into t_k values ('c1b', pg_temp.api(format('select api.save_prompt(%L, %L::jsonb, %L, 1)', gen_random_uuid(), pg_temp.pdoc('Text B'), pg_temp.id('c1'))));
insert into t_k values ('c1r2', pg_temp.api(format('select api.save_prompt(%L, %L::jsonb)', pg_temp.id('rq'), pg_temp.pdoc('Text A'))));
select is((pg_temp.k('c1b') ->> 'version')::int, 2, 'REGRESSION setup: another tab saved text B at version 2');
select is((pg_temp.k('c1r2') ->> 'version')::int, 1, 'REGRESSION: the retry of the original create answers with the ORIGINAL receipt (version 1), never version 2');
select ok((pg_temp.k('c1r2') ->> 'replay')::boolean and (pg_temp.k('c1r2') ->> 'superseded')::boolean, 'and says explicitly that it is a replay and that the prompt has since moved on (the caller must reconcile)');
select is(pg_temp.err('authenticated', format('select api.save_prompt(%L, %L::jsonb, %L, %s)', gen_random_uuid(), pg_temp.pdoc('Text A'), pg_temp.id('c1'), pg_temp.k('c1r2') ->> 'version')), 'PT409|version_conflict|saved_prompts', 'an update using the receipt''s version is a CONFLICT: the client cannot overwrite text B by mistake');
select is(pg_temp.api(format('select api.get_my_prompt(%L)', pg_temp.id('c1'))) ->> 'title', 'Text B', 'and the stored prompt is still text B');
select ok(not (pg_temp.k('c1') ? 'replay'), 'a first-time create answer carries no replay flag');

-- result retries
insert into t_k values ('pr', pg_temp.api(format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('Result parent'))));
insert into t_k values ('rr', jsonb_build_object('id', gen_random_uuid()));
insert into t_k values ('r1', pg_temp.api(format('select api.save_reflection(%L, %L, 1, %L::jsonb)', pg_temp.id('rr'), pg_temp.id('pr'), pg_temp.rdoc('yes', 'first'))));
insert into t_k values ('r1r', pg_temp.api(format('select api.save_reflection(%L, %L, 1, %L::jsonb)', pg_temp.id('rr'), pg_temp.id('pr'), pg_temp.rdoc('yes', 'first'))));
select is(pg_temp.k('r1r') ->> 'id', pg_temp.k('r1') ->> 'id', 'an identical result retry returns the stored result');
select is(pg_temp.err('authenticated', format('select api.save_reflection(%L, %L, 1, %L::jsonb)', pg_temp.id('rr'), pg_temp.id('pr'), pg_temp.rdoc('yes', 'DIFFERENT'))), 'PT409|request_reuse|p_request_id', 'a result request id reused with different content is refused');
select is(pg_temp.err('authenticated', format('select api.save_reflection(%L, %L, 1, %L::jsonb)', pg_temp.id('rr'), pg_temp.id('c1'), pg_temp.rdoc('yes', 'first'))), 'PT409|request_reuse|p_request_id', 'reused for a DIFFERENT parent prompt: refused');
select is(pg_temp.err('authenticated', format('select api.save_reflection(%L, %L, 2, %L::jsonb)', pg_temp.id('rr'), pg_temp.id('pr'), pg_temp.rdoc('yes', 'first'))), 'PT409|request_reuse|p_request_id', 'reused with a different expected prompt version: refused');
-- REGRESSION for results: the member edits the result after the first response was lost; the retry must not present the edited version as its acknowledgment
insert into t_k values ('r1e', pg_temp.api(format('select api.update_my_reflection(%L, 1, %L::jsonb)', pg_temp.id('r1'), pg_temp.rdoc('no', 'edited words'))));
insert into t_k values ('r1r2', pg_temp.api(format('select api.save_reflection(%L, %L, 1, %L::jsonb)', pg_temp.id('rr'), pg_temp.id('pr'), pg_temp.rdoc('yes', 'first'))));
select is((pg_temp.k('r1e') ->> 'version')::int, 2, 'REGRESSION setup (results): the result was edited to version 2');
select is((pg_temp.k('r1r2') ->> 'version')::int, 1, 'REGRESSION (results): the retry answers with the ORIGINAL receipt (version 1), not the edited version');
select ok((pg_temp.k('r1r2') ->> 'replay')::boolean and (pg_temp.k('r1r2') ->> 'superseded')::boolean, 'and flags the replay and that the result has moved on');
select is(pg_temp.err('authenticated', format('select api.update_my_reflection(%L, %s, %L::jsonb)', pg_temp.id('r1'), pg_temp.k('r1r2') ->> 'version', pg_temp.rdoc('yes', 'stale overwrite'))), 'PT409|version_conflict|saved_reflections', 'updating with the receipt''s version is a conflict (the edit is not overwritten)');
select is(pg_temp.api(format('select api.get_my_result(%L)', pg_temp.id('r1'))) ->> 'reflection', 'edited words', 'and the edited words are still stored');

-- ---- WHAT WAS ACTUALLY TRIED -----------------------------------------------------------------------------------------------------------------
select is(left(pg_temp.err('authenticated', format('select api.save_reflection(%L, %L, 1, %L::jsonb)', gen_random_uuid(), pg_temp.id('c1'), pg_temp.rdoc())), 5), 'PT409', 'a result against a STALE prompt version is refused');
select is(pg_temp.err('authenticated', format('select api.save_reflection(%L, %L, NULL, %L::jsonb)', gen_random_uuid(), pg_temp.id('c1'), pg_temp.rdoc())), 'PT422|invalid_content|p_expected_prompt_version', 'the expected prompt version is required');
insert into t_k values ('snap', pg_temp.api(format('select api.save_reflection(%L, %L, 2, %L::jsonb)', gen_random_uuid(), pg_temp.id('c1'), pg_temp.rdoc('partial', 'snapshot test'))));
insert into t_k values ('c1v3', pg_temp.api(format('select api.save_prompt(%L, %L::jsonb, %L, 2)', gen_random_uuid(), pg_temp.pdoc('Renamed later', '{"full_prompt":"changed later","starting_prompt":"starter CHANGED"}'), pg_temp.id('c1'))));
select is((pg_temp.api(format('select api.get_my_result(%L)', pg_temp.id('snap'))) ->> 'attempted_prompt') || '|' || (pg_temp.api(format('select api.get_my_result(%L)', pg_temp.id('snap'))) ->> 'starting_prompt') || '|' || (pg_temp.api(format('select api.get_my_result(%L)', pg_temp.id('snap'))) ->> 'title'),
          'do the thing|starter text|Text B', 'a result keeps the tried prompt, the STARTING prompt and the title as saved, although the parent changed to v3 and was renamed');
select is((pg_temp.api('select api.list_my_results(25, ''partial'')') -> 'items' -> 0 ->> 'title'), 'Text B', 'My results lists the SNAPSHOT title, not the parent''s current title');
select pg_temp.as_member(2);
select is(pg_temp.err('authenticated', format('select api.get_my_result(%L)', pg_temp.id('snap'))), 'PT404|not_found|', 'B cannot read A''s result');
select is(pg_temp.err('authenticated', format('select api.update_my_reflection(%L, 1, %L::jsonb)', pg_temp.id('snap'), pg_temp.rdoc())), 'PT404|not_found|', 'B cannot edit A''s result');
select is(pg_temp.err('authenticated', format('select api.delete_my_reflection(%L, 1)', pg_temp.id('snap'))), 'PT404|not_found|', 'B cannot delete A''s result');
select pg_temp.as_member(1);

-- ---- THE COMBINED SAVE IS ONE TRANSACTION ----------------------------------------------------------------------------------------------------------
insert into t_k values ('rqb', jsonb_build_object('id', gen_random_uuid()));
insert into t_k values ('b1', pg_temp.api(format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb)', pg_temp.id('rqb'), pg_temp.pdoc('Both new'), pg_temp.rdoc('no', 'did not work'))));
select ok(pg_temp.k('b1') -> 'prompt' ->> 'id' is not null and pg_temp.k('b1') -> 'result' ->> 'id' is not null, 'the combined save creates the prompt AND the result');
select is(pg_temp.owner_val(format('select count(*)::text from app.saved_prompts where title = ''Never stored'' and owner_id = %L', pg_temp.u(1))), '0', 'precondition: no prompt titled "Never stored"');
select is(pg_temp.err('authenticated', format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('Never stored'), '{"outcome":"bogus"}')), 'PT422|invalid_content|outcome', 'an invalid result fails the whole combined save');
select is(pg_temp.owner_val(format('select count(*)::text from app.saved_prompts where title = ''Never stored'' and owner_id = %L', pg_temp.u(1))), '0', 'and no prompt was created');
-- a failure AFTER the prompt write (result quota 50 per prompt) rolls the prompt update back
insert into t_k values ('qp', pg_temp.api(format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('Quota parent'))));
select pg_temp.api(format('select api.save_reflection(%L, %L, 1, %L::jsonb)', gen_random_uuid(), pg_temp.id('qp'), pg_temp.rdoc('yes', 'r' || i))) from generate_series(1, 50) i;
select is(pg_temp.err('authenticated', format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb, %L, 1)', gen_random_uuid(), pg_temp.pdoc('Quota parent CHANGED'), pg_temp.rdoc(), pg_temp.id('qp'))), 'PT429|quota_exceeded|saved_reflections', 'the combined save fails when the 50-results-per-prompt quota trips');
select is((pg_temp.api(format('select api.get_my_prompt(%L)', pg_temp.id('qp'))) ->> 'title') || '|' || (pg_temp.api(format('select api.get_my_prompt(%L)', pg_temp.id('qp'))) ->> 'version') || '|' || (pg_temp.api(format('select api.get_my_prompt(%L)', pg_temp.id('qp'))) ->> 'result_count'),
          'Quota parent|1|50', 'and the prompt update was ROLLED BACK (title and version unchanged): no partial save');
select is(left(pg_temp.err('authenticated', format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb, %L, 9)', gen_random_uuid(), pg_temp.pdoc('x'), pg_temp.rdoc(), pg_temp.id('c1'))), 5), 'PT409', 'a stale expected version fails the combined save');
-- retries of the combined operation: ORIGINAL receipt, flagged when things moved on
insert into t_k values ('rqc', jsonb_build_object('id', gen_random_uuid()));
insert into t_k values ('cb', pg_temp.api(format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb, %L, 3)', pg_temp.id('rqc'), pg_temp.pdoc('Text B', '{"full_prompt":"v4 text"}'), pg_temp.rdoc('yes', 'combined update'), pg_temp.id('c1'))));
select is((pg_temp.k('cb') -> 'prompt' ->> 'version')::int, 4, 'the combined update moved the prompt to version 4');
insert into t_k values ('cbn', pg_temp.api(format('select api.save_prompt(%L, %L::jsonb, %L, 4)', gen_random_uuid(), pg_temp.pdoc('Text B', '{"full_prompt":"v5 text"}'), pg_temp.id('c1'))));
insert into t_k values ('cbr', pg_temp.api(format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb, %L, 3)', pg_temp.id('rqc'), pg_temp.pdoc('Text B', '{"full_prompt":"v4 text"}'), pg_temp.rdoc('yes', 'combined update'), pg_temp.id('c1'))));
select is((pg_temp.k('cbr') -> 'prompt' ->> 'version')::int, 4, 'REGRESSION (combined): the retry answers with the prompt version of the ORIGINAL operation (4), not the current version (5)');
select ok((pg_temp.k('cbr') ->> 'replay')::boolean and (pg_temp.k('cbr') ->> 'superseded')::boolean and pg_temp.k('cbr') -> 'result' ->> 'id' = pg_temp.k('cb') -> 'result' ->> 'id', 'same result id, flagged as a replay that has been superseded');
select is(pg_temp.err('authenticated', format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb, %L, 3)', pg_temp.id('rqc'), pg_temp.pdoc('Text B', '{"full_prompt":"different"}'), pg_temp.rdoc('yes', 'combined update'), pg_temp.id('c1'))), 'PT409|request_reuse|p_request_id', 'the same combined request id with different prompt content is refused');
select is(pg_temp.err('authenticated', format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb, %L, 3)', pg_temp.id('rqc'), pg_temp.pdoc('Text B', '{"full_prompt":"v4 text"}'), pg_temp.rdoc('yes', 'other words'), pg_temp.id('c1'))), 'PT409|request_reuse|p_request_id', 'and with a different result');

-- ---- editing and deleting results; export; cascade --------------------------------------------------------------------------------------------------
select is((pg_temp.api(format('select api.get_my_result(%L)', pg_temp.id('snap'))) ->> 'outcome'), 'partial', 'before editing: the outcome is partial');
insert into t_k values ('snape', pg_temp.api(format('select api.update_my_reflection(%L, 1, %L::jsonb)', pg_temp.id('snap'), pg_temp.rdoc('no', 'rewritten words'))));
select is((pg_temp.api(format('select api.get_my_result(%L)', pg_temp.id('snap'))) ->> 'attempted_prompt'), 'do the thing', 'editing a result changes only the member''s words; the snapshot is untouched');
select is(left(pg_temp.err('authenticated', format('select api.update_my_reflection(%L, 1, %L::jsonb)', pg_temp.id('snap'), pg_temp.rdoc())), 5), 'PT409', 'a stale result version is a conflict');
select pg_temp.api(format('select api.delete_my_reflection(%L, 2)', pg_temp.id('snap')));
select is(pg_temp.err('authenticated', format('select api.get_my_result(%L)', pg_temp.id('snap'))), 'PT404|not_found|', 'a deleted result is gone');
insert into t_k values ('ex', pg_temp.api('select api.export_my_data(''summary'')'));
select ok((pg_temp.k('ex') ->> 'prompts')::int >= 5 and (pg_temp.k('ex') ->> 'results')::int >= 50, 'export summary counts the member''s own rows');
insert into t_k values ('ex1', pg_temp.api('select api.export_my_data(''prompts'', null, 2)'));
insert into t_k values ('ex2', pg_temp.api(format('select api.export_my_data(''prompts'', %L::uuid, 2)', pg_temp.k('ex1') ->> 'next_after_id')));
select ok(jsonb_array_length(pg_temp.k('ex1') -> 'items') = 2 and pg_temp.k('ex1') ->> 'next_after_id' is not null, 'export pages hold at most the requested rows and give a cursor');
select is((select count(*)::int from jsonb_array_elements(pg_temp.k('ex1') -> 'items') x join jsonb_array_elements(pg_temp.k('ex2') -> 'items') y on x ->> 'id' = y ->> 'id'), 0, 'without overlap');
select ok(not (pg_temp.k('ex1') -> 'items' -> 0 ? 'owner_id') and not (pg_temp.k('ex1') -> 'items' -> 0 ? 'request_hash') and not (pg_temp.k('ex1') -> 'items' -> 0 ? 'request_receipt'), 'export items carry no owner id, request hash or receipt');
select ok((pg_temp.api('select api.export_my_data(''results'', null, 5)') -> 'items' -> 0 ? 'attempted_prompt') and not (pg_temp.api('select api.export_my_data(''results'', null, 5)') -> 'items' -> 0 ? 'owner_id'), 'result export carries the snapshot and no owner id');
select is(pg_temp.err('authenticated', 'select api.export_my_data(''prompts'', null, 51)'), 'PT422|invalid_content|p_limit', 'an export page over 50 rows is refused');
select is(pg_temp.err('authenticated', 'select api.export_my_data(''everything'')'), 'PT422|invalid_content|p_kind', 'an unknown export kind is refused');
select pg_temp.as_member(2);
select is(((pg_temp.api('select api.export_my_data(''summary'')') ->> 'prompts')::int) + jsonb_array_length(pg_temp.api('select api.export_my_data(''prompts'')') -> 'items'), 0, 'B''s export contains none of A''s rows');
select pg_temp.as_member(1);
select is((pg_temp.api(format('select api.get_my_prompt(%L)', pg_temp.id('qp'))) ->> 'result_count')::int, 50, 'before deleting: the prompt reports its 50 results (for the confirmation warning)');
select is((pg_temp.api(format('select api.delete_my_prompt(%L, 1)', pg_temp.id('qp'))) ->> 'results_deleted')::int, 50, 'deleting the prompt reports the 50 results it removed');
select is(pg_temp.owner_val(format('select count(*)::text from app.saved_reflections where prompt_id = %L', pg_temp.id('qp'))), '0', 'and they are gone (cascade)');

-- ---- composite foreign key, quota, guard ----------------------------------------------------------------------------------------------------------
select is(left(pg_temp.err('hackass_owner', format('insert into app.saved_reflections (owner_id, prompt_id, request_id, request_hash, request_receipt, outcome, attempted_prompt, prompt_title, origin_kind, prompt_version) values (%L, %L, gen_random_uuid(), repeat(''a'', 64), ''{}'', ''yes'', ''x'', ''t'', ''scratch'', 1)', pg_temp.u(2), pg_temp.id('c1'))), 5), '23503', 'a result cannot reference another owner''s prompt, whatever any function does');
select pg_temp.as_member(2);
select pg_temp.api(format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('q' || i))) from generate_series(1, 100) i;
select is(pg_temp.err('authenticated', format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('one too many'))), 'PT429|quota_exceeded|saved_prompts', 'the 101st prompt is refused (quota 100)');
select pg_temp.as_member(3);
select is(jsonb_array_length(pg_temp.api('select api.list_my_prompts()') -> 'items'), 0, 'member C starts empty');
delete from auth.sessions where id = pg_temp.s(3);
select is(pg_temp.err('authenticated', 'select api.list_my_prompts()'), '28000|session_invalid|', 'a revoked session is refused inside the database');
select pg_temp.owner_val(format('update app.accounts set status = ''disabled'' where user_id = %L returning ''x''', pg_temp.u(1)));
select pg_temp.as_member(1);
select is(left(pg_temp.err('authenticated', 'select api.list_my_prompts()'), 5), '42501', 'a disabled account is refused');
select pg_temp.owner_val(format('update app.accounts set status = ''active'' where user_id = %L returning ''x''', pg_temp.u(1)));

-- ---- erasure when the Auth user is deleted ----------------------------------------------------------------------------------------------------------
select ok(pg_temp.owner_val(format('select count(*)::text from app.saved_prompts where owner_id = %L', pg_temp.u(1)))::int > 0, 'precondition: A has saved work');
delete from auth.users where id = pg_temp.u(1);
select is(pg_temp.owner_val(format('select (select count(*) from app.saved_prompts where owner_id = %L) + (select count(*) from app.saved_reflections where owner_id = %L)', pg_temp.u(1), pg_temp.u(1))), '0', 'deleting the Auth user erases the member''s prompts and results');
select is(pg_temp.owner_val(format('select status from app.accounts where user_id = %L', pg_temp.u(1))), 'deleted', 'and the account row stays, marked deleted');
select is(pg_temp.owner_val(format('select count(*)::text from app.saved_prompts where owner_id = %L', pg_temp.u(2))), '100', 'while another member''s work is untouched');

select * from finish();
rollback;
