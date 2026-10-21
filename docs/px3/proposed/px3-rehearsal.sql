-- PX-3 REHEARSAL, REVISION 1 (evidence for review; run inside a transaction that is ROLLED BACK, on the disposable local database).
-- Behavioural checks of docs/px3/proposed/px3-my-work.draft.sql with real roles and the real guard. Prints PASS lines; any failed expectation aborts.
-- Usage:  { echo "begin;"; cat px3-my-work.draft.sql px3-rehearsal.sql; echo "rollback;"; } | psql -U postgres -d postgres -v ON_ERROR_STOP=1
create temp table px3_users (tag text primary key, uid uuid, sid uuid);
grant all on px3_users to public;
insert into px3_users values ('A', gen_random_uuid(), gen_random_uuid()), ('B', gen_random_uuid(), gen_random_uuid());
insert into auth.users (id, aud, role, email) select uid, 'authenticated', 'authenticated', 'px3-' || tag || '@example.test' from px3_users;
insert into auth.sessions (id, user_id) select sid, uid from px3_users;

create function pg_temp.as_member(p_tag text) returns void language plpgsql as $$
declare u px3_users;
begin
  select * into u from px3_users where tag = p_tag;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u.uid, 'session_id', u.sid, 'aal', 'aal1')::text, true);
end $$;
create function pg_temp.expect_err(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlstate = p_state then raise notice 'PASS  %  [%]', p_label, sqlstate; return; end if;
    raise exception 'FAIL % : expected % got % (%)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL % : no error raised', p_label;
end $$;
create function pg_temp.pdoc(p_title text default 'Title', p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('title', p_title, 'output_format', 'Concise summary', 'full_prompt', 'do the thing', 'starting_prompt', 'starter text', 'origin_kind', 'scratch') || p_extra $$;
create function pg_temp.rdoc(p_outcome text default 'partial', p_text text default 'half worked') returns jsonb language sql as $$
  select jsonb_build_object('outcome', p_outcome, 'reflection', p_text, 'next_change', 'add budget') $$;
create function pg_temp.count_as_owner(p_sql text) returns bigint language plpgsql as $$
declare n bigint; begin reset role; set local role hackass_owner; execute p_sql into n; reset role; set local role authenticated; return n; end $$;
grant execute on all functions in schema pg_temp to public;

do $$
declare a_id uuid; r jsonb; r2 jsonb; page1 jsonb; page2 jsonb; ref jsonb; rid uuid := gen_random_uuid(); i int; q jsonb; v int; bt jsonb; bt2 jsonb; p3 uuid; e1 jsonb; e2 jsonb; n_before bigint;
begin
  set local role authenticated; perform pg_temp.as_member('A');
  -- ===== ownership, idempotency, versions (unchanged from revision 0, adapted) =====
  r := api.save_prompt(gen_random_uuid(), pg_temp.pdoc('A one')); a_id := (r ->> 'id')::uuid; assert (r ->> 'version')::int = 1; raise notice 'PASS  A creates a prompt (version 1)';
  perform pg_temp.as_member('B');
  perform pg_temp.expect_err(format('select api.get_my_prompt(%L)', a_id), 'PT404', 'B cannot read A''s prompt');
  perform pg_temp.expect_err(format('select api.get_my_prompt(%L)', gen_random_uuid()), 'PT404', 'a nonexistent id gives the identical error');
  perform pg_temp.expect_err(format('select api.save_prompt(%L, %L::jsonb, %L, 1)', gen_random_uuid(), pg_temp.pdoc('hijack'), a_id), 'PT404', 'B cannot update A''s prompt');
  perform pg_temp.expect_err(format('select api.delete_my_prompt(%L, 1)', a_id), 'PT404', 'B cannot delete A''s prompt');
  perform pg_temp.expect_err(format('select api.save_reflection(%L, %L, 1, %L::jsonb)', gen_random_uuid(), a_id, pg_temp.rdoc()), 'PT404', 'B cannot attach a result to A''s prompt');
  perform pg_temp.expect_err(format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb, %L, 1)', gen_random_uuid(), pg_temp.pdoc('hijack'), pg_temp.rdoc(), a_id), 'PT404', 'B cannot use the combined save on A''s prompt');
  assert (api.list_my_prompts() -> 'items') = '[]'::jsonb and (api.list_my_results() -> 'items') = '[]'::jsonb; raise notice 'PASS  B''s lists are empty (A''s rows never appear)';
  perform pg_temp.as_member('A');
  perform pg_temp.expect_err(format('select api.save_prompt(%L, %L::jsonb, %L, 7)', gen_random_uuid(), pg_temp.pdoc('x'), a_id), 'PT409', 'wrong expected version -> conflict');
  perform pg_temp.expect_err(format('select api.save_prompt(%L, %L::jsonb, %L)', gen_random_uuid(), pg_temp.pdoc('x'), a_id), 'PT422', 'update without an expected version is refused');
  r := api.save_prompt(gen_random_uuid(), pg_temp.pdoc('A one edited'), a_id, 1); assert (r ->> 'version')::int = 2; raise notice 'PASS  update with the right version -> 2';
  perform pg_temp.expect_err(format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('x', '{"owner_id":"00000000-0000-0000-0000-000000000000"}')), 'PT422', 'an unknown key (owner_id) is rejected');
  perform pg_temp.expect_err(format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc(repeat('x', 121))), 'PT422', 'a title over 120 characters is rejected');
  perform pg_temp.expect_err(format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('x', '{"origin_kind":"catalog"}')), 'PT422', 'catalog origin without a slug is rejected');
  for i in 1..3 loop perform api.save_prompt(gen_random_uuid(), pg_temp.pdoc('P' || i)); end loop;
  page1 := api.list_my_prompts(2); page2 := api.list_my_prompts(2, (page1 -> 'next_cursor' ->> 'updated_at')::timestamptz, (page1 -> 'next_cursor' ->> 'id')::uuid);
  assert jsonb_array_length(page1 -> 'items') = 2 and page1 -> 'next_cursor' is not null and jsonb_array_length(page2 -> 'items') >= 1;
  assert not exists (select 1 from jsonb_array_elements(page1 -> 'items') x join jsonb_array_elements(page2 -> 'items') y on x ->> 'id' = y ->> 'id'); raise notice 'PASS  keyset pagination: pages do not overlap';

  -- ===== CHANGE 4: create retries are bound to their original payload =====
  r := api.save_prompt(rid, pg_temp.pdoc('Bound')); r2 := api.save_prompt(rid, pg_temp.pdoc('Bound')); assert r ->> 'id' = r2 ->> 'id';
  assert pg_temp.count_as_owner('select count(*) from app.saved_prompts where title = ''Bound''') = 1; raise notice 'PASS  an IDENTICAL create retry returns the stored row (no duplicate)';
  perform set_config('request.jwt.claims', current_setting('request.jwt.claims'), true);
  perform pg_temp.expect_err(format('select api.save_prompt(%L, %L::jsonb)', rid, pg_temp.pdoc('Bound but different')), 'PT409', 'the SAME request id with DIFFERENT content is refused (not silently answered)');
  ref := api.save_reflection(gen_random_uuid(), a_id, 2, pg_temp.rdoc('partial', 'half worked')); v := (ref ->> 'prompt_version')::int; assert v = 2;
  -- result create retries
  rid := gen_random_uuid(); r := api.save_reflection(rid, a_id, 2, pg_temp.rdoc('yes', 'first')); r2 := api.save_reflection(rid, a_id, 2, pg_temp.rdoc('yes', 'first')); assert r ->> 'id' = r2 ->> 'id'; raise notice 'PASS  an identical result retry returns the stored result';
  perform pg_temp.expect_err(format('select api.save_reflection(%L, %L, 2, %L::jsonb)', rid, a_id, pg_temp.rdoc('yes', 'DIFFERENT')), 'PT409', 'a result id reused with different content is refused');
  p3 := (api.save_prompt(gen_random_uuid(), pg_temp.pdoc('Other parent')) ->> 'id')::uuid;
  perform pg_temp.expect_err(format('select api.save_reflection(%L, %L, 1, %L::jsonb)', rid, p3, pg_temp.rdoc('yes', 'first')), 'PT409', 'a result id reused for a DIFFERENT parent prompt is refused');
  perform pg_temp.expect_err(format('select api.save_reflection(%L, %L, 3, %L::jsonb)', rid, a_id, pg_temp.rdoc('yes', 'first')), 'PT409', 'a result id reused with a different expected version is refused');

  -- ===== CHANGE 1: what was actually tried =====
  perform pg_temp.expect_err(format('select api.save_reflection(%L, %L, 1, %L::jsonb)', gen_random_uuid(), a_id, pg_temp.rdoc()), 'PT409', 'a result against a STALE prompt version is refused (the member tried an older text)');
  perform pg_temp.expect_err(format('select api.save_reflection(%L, %L, NULL, %L::jsonb)', gen_random_uuid(), a_id, pg_temp.rdoc()), 'PT422', 'the expected prompt version is required');
  r := api.save_prompt(gen_random_uuid(), pg_temp.pdoc('A one RENAMED', '{"full_prompt":"changed later","starting_prompt":"starter CHANGED"}'), a_id, 2);   -- the parent moves on to version 3
  q := api.get_my_result((ref ->> 'id')::uuid);
  assert q ->> 'attempted_prompt' = 'do the thing' and q ->> 'starting_prompt' = 'starter text' and q ->> 'title' = 'A one edited' and (q ->> 'prompt_version')::int = 2;
  raise notice 'PASS  a result keeps the prompt text, the STARTING prompt, the title and the version it was saved against (the parent changed to v3 and was renamed)';
  assert (api.list_my_results(25, 'partial') -> 'items' -> 0 ->> 'title') = 'A one edited'; raise notice 'PASS  My results lists the SNAPSHOT title, not the parent''s current title';
  perform pg_temp.as_member('B'); perform pg_temp.expect_err(format('select api.get_my_result(%L)', ref ->> 'id'), 'PT404', 'B cannot read A''s result'); perform pg_temp.as_member('A');

  -- ===== CHANGE 2: one operation, one transaction =====
  rid := gen_random_uuid(); n_before := pg_temp.count_as_owner('select count(*) from app.saved_prompts');
  bt := api.save_prompt_and_result(rid, pg_temp.pdoc('Both new'), pg_temp.rdoc('no', 'did not work'));
  assert pg_temp.count_as_owner('select count(*) from app.saved_prompts') = n_before + 1 and (bt -> 'result' ->> 'id') is not null; raise notice 'PASS  the combined save creates the prompt AND the result';
  q := api.get_my_result((bt -> 'result' ->> 'id')::uuid); assert q ->> 'attempted_prompt' = 'do the thing' and (q ->> 'prompt_version')::int = 1;
  -- validation failure in the RESULT half: nothing is written, not even the prompt
  n_before := pg_temp.count_as_owner('select count(*) from app.saved_prompts');
  perform pg_temp.expect_err(format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('Never stored'), '{"outcome":"bogus"}'), 'PT422', 'an invalid result makes the whole combined save fail');
  assert pg_temp.count_as_owner('select count(*) from app.saved_prompts') = n_before; raise notice 'PASS  ...and no prompt was created';
  -- FAILURE AFTER THE PROMPT WAS WRITTEN: the result quota (50 per prompt) trips inside the function; the prompt update must be rolled back
  p3 := (api.save_prompt(gen_random_uuid(), pg_temp.pdoc('Quota parent')) ->> 'id')::uuid;
  for i in 1..50 loop perform api.save_reflection(gen_random_uuid(), p3, 1, pg_temp.rdoc('yes', 'r' || i)); end loop;
  perform pg_temp.expect_err(format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb, %L, 1)', gen_random_uuid(), pg_temp.pdoc('Quota parent CHANGED'), pg_temp.rdoc(), p3), 'PT429', 'the combined save fails when the result quota trips');
  q := api.get_my_prompt(p3); assert q ->> 'title' = 'Quota parent' and (q ->> 'version')::int = 1 and (q ->> 'result_count')::int = 50;
  raise notice 'PASS  ...and the prompt update was ROLLED BACK (title and version unchanged): no partial save';
  -- conflict
  perform pg_temp.expect_err(format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb, %L, 9)', gen_random_uuid(), pg_temp.pdoc('x'), pg_temp.rdoc(), a_id), 'PT409', 'a stale expected version fails the combined save');
  -- retries of the combined operation
  rid := gen_random_uuid(); bt := api.save_prompt_and_result(rid, pg_temp.pdoc('A one RENAMED', '{"full_prompt":"v4 text"}'), pg_temp.rdoc('yes', 'combined update'), a_id, 3);
  bt2 := api.save_prompt_and_result(rid, pg_temp.pdoc('A one RENAMED', '{"full_prompt":"v4 text"}'), pg_temp.rdoc('yes', 'combined update'), a_id, 3);   -- the prompt is now v4; the identical retry still answers
  assert bt -> 'result' ->> 'id' = bt2 -> 'result' ->> 'id'; raise notice 'PASS  an identical retry of a combined UPDATE (after the prompt moved on) returns the stored outcome';
  perform pg_temp.expect_err(format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb, %L, 3)', rid, pg_temp.pdoc('A one RENAMED', '{"full_prompt":"different"}'), pg_temp.rdoc('yes', 'combined update'), a_id), 'PT409', 'the same request id with different prompt content is refused');
  perform pg_temp.expect_err(format('select api.save_prompt_and_result(%L, %L::jsonb, %L::jsonb, %L, 3)', rid, pg_temp.pdoc('A one RENAMED', '{"full_prompt":"v4 text"}'), pg_temp.rdoc('yes', 'combined update, other words'), a_id), 'PT409', 'the same request id with a different result is refused');
  assert (api.get_my_result((bt -> 'result' ->> 'id')::uuid) ->> 'attempted_prompt') = 'v4 text';

  -- ===== update / delete of a result; snapshots stay =====
  r := api.update_my_reflection((ref ->> 'id')::uuid, 1, pg_temp.rdoc('no', 'rewritten words')); assert (r ->> 'version')::int = 2;
  q := api.get_my_result((ref ->> 'id')::uuid); assert q ->> 'outcome' = 'no' and q ->> 'attempted_prompt' = 'do the thing' and q ->> 'starting_prompt' = 'starter text'; raise notice 'PASS  editing a result changes only the member''s words; the snapshot is untouched';
  perform pg_temp.expect_err(format('select api.update_my_reflection(%L, 1, %L::jsonb)', ref ->> 'id', pg_temp.rdoc()), 'PT409', 'a stale result version is refused');
  perform pg_temp.as_member('B'); perform pg_temp.expect_err(format('select api.update_my_reflection(%L, 2, %L::jsonb)', ref ->> 'id', pg_temp.rdoc()), 'PT404', 'B cannot edit A''s result'); perform pg_temp.expect_err(format('select api.delete_my_reflection(%L, 2)', ref ->> 'id'), 'PT404', 'B cannot delete A''s result'); perform pg_temp.as_member('A');
  perform api.delete_my_reflection((ref ->> 'id')::uuid, 2); perform pg_temp.expect_err(format('select api.get_my_result(%L)', ref ->> 'id'), 'PT404', 'a deleted result is gone');

  -- ===== export =====
  e1 := api.export_my_data('summary'); assert (e1 ->> 'prompts')::int = (select count(*) from jsonb_array_elements(api.list_my_prompts(100) -> 'items'));
  page1 := api.export_my_data('prompts', null, 2); page2 := api.export_my_data('prompts', (page1 ->> 'next_after_id')::uuid, 2);
  assert jsonb_array_length(page1 -> 'items') = 2 and page1 ->> 'next_after_id' is not null and not exists (select 1 from jsonb_array_elements(page1 -> 'items') x join jsonb_array_elements(page2 -> 'items') y on x ->> 'id' = y ->> 'id');
  assert not (page1 -> 'items' -> 0 ? 'owner_id') and not (page1 -> 'items' -> 0 ? 'request_hash'); raise notice 'PASS  export: summary counts, pages of at most N without overlap, no owner_id or request_hash in the output';
  e2 := api.export_my_data('results', null, 5); assert jsonb_array_length(e2 -> 'items') >= 1 and not (e2 -> 'items' -> 0 ? 'owner_id') and (e2 -> 'items' -> 0 ? 'attempted_prompt');
  perform pg_temp.expect_err('select api.export_my_data(''prompts'', null, 51)', 'PT422', 'an export page over 50 rows is refused'); perform pg_temp.expect_err('select api.export_my_data(''everything'')', 'PT422', 'an unknown export kind is refused');
  perform pg_temp.as_member('B'); assert (api.export_my_data('summary') ->> 'prompts')::int = 0 and jsonb_array_length(api.export_my_data('prompts') -> 'items') = 0; raise notice 'PASS  B''s export contains none of A''s rows'; perform pg_temp.as_member('A');

  -- ===== delete cascade with a count for the warning =====
  q := api.get_my_prompt(p3); assert (q ->> 'result_count')::int = 50;
  r := api.delete_my_prompt(p3, 1); assert (r ->> 'results_deleted')::int = 50 and pg_temp.count_as_owner('select count(*) from app.saved_reflections where prompt_id = ' || quote_literal(p3)) = 0;
  raise notice 'PASS  deleting a prompt reports and removes its results (50) for the confirmation warning';

  -- ===== structure, grants, guard (unchanged) =====
  perform pg_temp.as_member('B');
  perform pg_temp.expect_err('select * from app.saved_prompts', '42501', 'authenticated has no table privilege');
  reset role; set local role anon; perform pg_temp.expect_err(format('select api.get_my_prompt(%L)', a_id), '42501', 'anon cannot execute the functions'); perform pg_temp.expect_err('select api.export_my_data(''summary'')', '42501', 'anon cannot export');
  reset role; set local role service_role; perform pg_temp.expect_err(format('select api.get_my_prompt(%L)', a_id), '42501', 'service_role cannot execute the functions'); perform pg_temp.expect_err('select * from app.saved_reflections', '42501', 'service_role has no table privilege');
  reset role; set local role hackass_owner; perform pg_temp.expect_err(format('insert into app.saved_reflections (owner_id, prompt_id, request_id, request_hash, outcome, attempted_prompt, prompt_title, origin_kind, prompt_version) values (%L, %L, gen_random_uuid(), repeat(''a'', 64), ''yes'', ''x'', ''t'', ''scratch'', 1)', (select uid from px3_users where tag = 'B'), a_id), '23503', 'a result cannot point at another owner''s prompt'); reset role;
  set local role authenticated; perform pg_temp.as_member('B');
  for i in 1..100 loop perform api.save_prompt(gen_random_uuid(), pg_temp.pdoc('q' || i)); end loop;
  perform pg_temp.expect_err(format('select api.save_prompt(%L, %L::jsonb)', gen_random_uuid(), pg_temp.pdoc('one too many')), 'PT429', 'the 101st prompt is refused (quota 100)');
  reset role; delete from auth.sessions where id = (select sid from px3_users where tag = 'B'); set local role authenticated; perform pg_temp.as_member('B');
  perform pg_temp.expect_err('select api.list_my_prompts()', '28000', 'a revoked session is refused inside the database');
  reset role; set local role hackass_owner; update app.accounts set status = 'disabled' where user_id = (select uid from px3_users where tag = 'A'); reset role; set local role authenticated; perform pg_temp.as_member('A');
  perform pg_temp.expect_err('select api.list_my_prompts()', '42501', 'a disabled account is refused'); reset role;
  set local role hackass_owner; update app.accounts set status = 'active' where user_id = (select uid from px3_users where tag = 'A'); reset role;
  set local role hackass_owner; grant usage on schema app_guard to postgres; grant execute on function app_guard.on_auth_user_deleted_content() to postgres; reset role;
  create trigger px3_erase after delete on auth.users for each row execute function app_guard.on_auth_user_deleted_content();
  delete from auth.users where id = (select uid from px3_users where tag = 'A');
  assert not exists (select 1 from app.saved_prompts where owner_id = (select uid from px3_users where tag = 'A')) and not exists (select 1 from app.saved_reflections where owner_id = (select uid from px3_users where tag = 'A'));
  assert exists (select 1 from app.accounts where user_id = (select uid from px3_users where tag = 'A') and status = 'deleted'); raise notice 'PASS  deleting the Auth user erases the member''s saved work (the account row stays, marked deleted)';
  raise notice 'REHEARSAL COMPLETE';
end $$;
