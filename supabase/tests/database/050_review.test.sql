-- F2-C1: moderation records and human review decisions, exercised through the exposed api functions as the real Supabase roles (claims in
-- request.jwt.claims, as PostgREST provides them) and through direct DML as the owner role. Real signed JWTs and genuine concurrency are in
-- scripts/local-f2c-checks.mjs.
begin;
select no_plan();

-- ---- helpers -----------------------------------------------------------------------------------------------------------------------------
create function pg_temp.set_claims(p_role text, p_sub uuid, p_sid uuid, p_aal text, p_amr jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_sub, 'session_id', p_sid, 'aal', p_aal, 'amr', p_amr))::text, true);
end $$;
create function pg_temp.amr(p_age interval) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', floor(extract(epoch from now() - p_age))::bigint), jsonb_build_object('method', 'password', 'timestamp', floor(extract(epoch from now() - p_age))::bigint)) $$;
create function pg_temp.u(n integer) returns uuid language sql as $$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.s(n integer) returns uuid language sql as $$ select ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
-- act as a member (aal1) / as staff (aal2, fresh TOTP)
create function pg_temp.as_member(n integer) returns void language plpgsql as $$
begin perform pg_temp.set_claims('authenticated', pg_temp.u(n), pg_temp.s(n), 'aal1', null); end $$;
create function pg_temp.as_staff(n integer, p_age interval default interval '30 seconds') returns void language plpgsql as $$
begin perform pg_temp.set_claims('authenticated', pg_temp.u(n), pg_temp.s(n), 'aal2', pg_temp.amr(p_age)); end $$;
-- run SQL as a role; report 'OK:<result>' or '<sqlstate>|<message>|<detail>'
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
create function pg_temp.call(p_role text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('role', p_role, true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  return v;
end $$;

create function pg_temp.lk(p_have text, p_pattern text, p_desc text) returns text language sql as $$ select ok(p_have like p_pattern, p_desc) || case when p_have like p_pattern then '' else E'\n# have: ' || coalesce(p_have, 'NULL') || E'\n# want like: ' || p_pattern end $$;

-- ---- fixtures: u1 author, u2 other member, u3 reviewer, u4 admin, u5 second reviewer, u6 staff who also submits -------------------------------------------
insert into auth.users (id, aud, role, email) select pg_temp.u(i), 'authenticated', 'authenticated', 'u' || i || '@example.test' from generate_series(1, 8) i;
insert into auth.sessions (id, user_id) select pg_temp.s(i), pg_temp.u(i) from generate_series(1, 8) i;
select pg_temp.owner_run($$insert into app.categories (slug, name) values ('kitchen', 'Kitchen')$$);
select pg_temp.owner_run(format($$insert into app.staff_assignments (user_id, role, granted_by) values (%L, 'reviewer', 'fixture'), (%L, 'admin', 'fixture'), (%L, 'reviewer', 'fixture'), (%L, 'reviewer', 'fixture')$$, pg_temp.u(3), pg_temp.u(4), pg_temp.u(5), pg_temp.u(6)));

create function pg_temp.doc(p_title text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('category_slug', 'kitchen', 'title', p_title, 'summary', 'A summary.', 'outcome', 'An outcome.', 'difficulty', 'easy',
    'steps', jsonb_build_array('Do the thing.'), 'attributions', jsonb_build_array(jsonb_build_object('role', 'author', 'external_name', 'A. Cook')),
    'source_claims', jsonb_build_array(jsonb_build_object('kind', 'original_work'))) || p_extra $$;
-- create, fill and submit a version as user n; returns {submission_id, version_id, hash}
create function pg_temp.submit_as(n integer, p_doc jsonb) returns jsonb language plpgsql as $$
declare c jsonb; v uuid; h text; r jsonb;
begin
  perform pg_temp.as_member(n);
  perform set_config('role', 'authenticated', true);
  c := api.create_draft(); v := (c ->> 'version_id')::uuid;
  perform api.save_draft(v, p_doc);
  h := api.get_version(v) ->> 'computed_hash';
  r := api.submit_version(v, h);
  perform set_config('role', 'none', true);
  return jsonb_build_object('submission_id', r ->> 'submission_id', 'version_id', v, 'hash', h, 'hack_id', c ->> 'hack_id');
end $$;
create temp table t_s (k text primary key, r jsonb);
grant all on t_s to public;
insert into t_s values
  ('main',   pg_temp.submit_as(1, pg_temp.doc('Main submission'))),
  ('two',    pg_temp.submit_as(1, pg_temp.doc('Two claims') || jsonb_build_object('source_claims', jsonb_build_array(jsonb_build_object('kind', 'original_work'), jsonb_build_object('kind', 'third_party_reuse', 'canonical_url', 'https://example.test/src', 'license_spdx', 'MIT', 'permission_note', 'The author says it is MIT.'))))),
  ('refs',   pg_temp.submit_as(1, pg_temp.doc('Has references') || jsonb_build_object('attributions', jsonb_build_array(jsonb_build_object('role', 'author', 'profile_id', pg_temp.u(2))), 'assets', jsonb_build_array(jsonb_build_object('asset_id', '30000000-0000-4000-8000-000000000001', 'sha256', repeat('ab', 32)))))),
  ('own6',   pg_temp.submit_as(6, pg_temp.doc('Staff member''s own work'))),
  ('named3', pg_temp.submit_as(1, pg_temp.doc('Names the reviewer') || jsonb_build_object('attributions', jsonb_build_array(jsonb_build_object('role', 'contributor', 'profile_id', pg_temp.u(3)))))),
  ('risk',   pg_temp.submit_as(1, pg_temp.doc('Risk tests'))),
  ('tamper', pg_temp.submit_as(1, pg_temp.doc('Tamper tests'))),
  ('chain',  pg_temp.submit_as(1, pg_temp.doc('Decision chain')));
create function pg_temp.sid(k text) returns text language sql as $$ select r ->> 'submission_id' from t_s where t_s.k = $1 $$;
create function pg_temp.vid(k text) returns text language sql as $$ select r ->> 'version_id' from t_s where t_s.k = $1 $$;
create function pg_temp.hash(k text) returns text language sql as $$ select r ->> 'hash' from t_s where t_s.k = $1 $$;
select is((select count(*)::int from app.submissions), 8, 'fixtures: eight frozen submissions');

-- call-string builders (dummy-safe: every argument is well formed)
create function pg_temp.calls(p_sub text, p_hash text) returns table (fn text, sql text) language sql as $$
  select * from (values
    ('list_submissions_for_review', 'select api.list_submissions_for_review()::text'),
    ('get_submission_for_review', format('select api.get_submission_for_review(%L)::text', p_sub)),
    ('start_review', format('select api.start_review(%L, %L)::text', p_sub, p_hash)),
    ('record_risk_assessment', format('select api.record_risk_assessment(%L, %L, ''low'', ''A rationale long enough.'')::text', p_sub, p_hash)),
    ('record_rights_review', format('select api.record_rights_review(%L, %L, 1, ''needs_evidence'', null, null, null)::text', p_sub, p_hash)),
    ('record_decision', format('select api.record_decision(%L, %L, ''HOLD'', array[''other''], null, null)::text', p_sub, p_hash))) v(fn, sql) $$;
create temp table t_calls as select * from pg_temp.calls('99999999-9999-4999-8999-999999999999', repeat('0', 64));
grant all on t_calls to public;
select is((select count(*)::int from t_calls), 6, 'six staff functions');

-- ===================================================================================================================
-- A. direct JWT calls: every staff function is guarded the same way
-- ===================================================================================================================
create function pg_temp.guard_failures(p_role text, p_expect text) returns text language sql as $$
  select coalesce(string_agg(fn || ' -> ' || split_part(pg_temp.err(p_role, sql), '|', 1) || ':' || split_part(pg_temp.err(p_role, sql), '|', 2), E'\n' order by fn), '')
    from t_calls where pg_temp.err(p_role, sql) not like p_expect $$;
select pg_temp.set_claims('anon', null, null, null, null);
select is(pg_temp.guard_failures('anon', '42501|%'), '', 'anon: EXECUTE denied on all six');
select pg_temp.set_claims('service_role', null, null, null, null);
select is(pg_temp.guard_failures('service_role', '42501|%'), '', 'service_role: EXECUTE denied on all six');
select set_config('request.jwt.claims', '', true);
select is(pg_temp.guard_failures('authenticated', '28000|not_authenticated|%'), '', 'no verified claims: all six refuse (not_authenticated)');
-- signed-out session whose token is otherwise valid
delete from auth.sessions where id = pg_temp.s(7);
select pg_temp.set_claims('authenticated', pg_temp.u(7), pg_temp.s(7), 'aal2', pg_temp.amr(interval '30 seconds'));
select is(pg_temp.guard_failures('authenticated', '28000|session_invalid|%'), '', 'a signed-out session with aal2 claims: all six refuse (session_invalid)');
insert into auth.sessions (id, user_id) values (pg_temp.s(7), pg_temp.u(7));
-- inactive account (u7 is staff in this test)
select pg_temp.owner_run(format($$insert into app.staff_assignments (user_id, role, granted_by) values (%L, 'reviewer', 'fixture')$$, pg_temp.u(7)));
select pg_temp.owner_run(format($$update app.accounts set status = 'disabled' where user_id = %L$$, pg_temp.u(7)));
select pg_temp.as_staff(7);
select is(pg_temp.guard_failures('authenticated', '42501|account_inactive|%'), '', 'a disabled account that still holds a staff role: all six refuse (account_inactive)');
select pg_temp.owner_run(format($$update app.accounts set status = 'active' where user_id = %L$$, pg_temp.u(7)));
-- removed staff role
select pg_temp.as_staff(7);
select is((select string_agg(distinct split_part(pg_temp.err('authenticated', sql), '|', 2), ',') from t_calls where fn <> 'list_submissions_for_review'), 'not_found', 'and a dummy submission id gives not_found, not a guard error');
select pg_temp.owner_run(format($$update app.staff_assignments set revoked_at = now(), revoked_by = 'test' where user_id = %L and revoked_at is null$$, pg_temp.u(7)));
select pg_temp.as_staff(7);
select is(pg_temp.guard_failures('authenticated', '42501|not_staff|%'), '', 'staff role removed: the SAME valid session and fresh-MFA token is refused by all six (not_staff)');
-- a plain member
select pg_temp.as_member(2);
select is(pg_temp.guard_failures('authenticated', '42501|not_staff|%'), '', 'a member who is not staff: all six refuse (not_staff)');
-- MFA
select pg_temp.as_member(3);
select is(pg_temp.guard_failures('authenticated', '42501|mfa_required|%'), '', 'staff with an aal1 session: all six refuse (insufficient MFA)');
select pg_temp.set_claims('authenticated', pg_temp.u(3), pg_temp.s(3), 'aal2', null);
select is(pg_temp.guard_failures('authenticated', '42501|mfa_required|%'), '', 'aal2 claimed but no amr: refused (mfa_required)');
select pg_temp.as_staff(3, interval '16 minutes');
select is(pg_temp.guard_failures('authenticated', '42501|mfa_stale|%'), '', 'MFA 16 minutes old: all six refuse (mfa_stale)');
select pg_temp.as_staff(3, interval '-1 second');
select is(pg_temp.guard_failures('authenticated', '42501|mfa_stale|%'), '', 'MFA timestamp 1 second in the future: refused (mfa_stale)');
select pg_temp.as_staff(3, interval '14 minutes');
select is((select string_agg(distinct split_part(pg_temp.err('authenticated', sql), '|', 2), ',') from t_calls where fn <> 'list_submissions_for_review'), 'not_found', 'MFA 14 minutes old passes the guard');
-- no direct access to the internals
select pg_temp.as_staff(3);
select is((select coalesce(string_agg(f, ', '), '') from unnest(array['app_review.lock_submission(''99999999-9999-4999-8999-999999999999'')', 'app_review.approval_blockers(''99999999-9999-4999-8999-999999999999'', ''99999999-9999-4999-8999-999999999999'')', 'app_guard.require_staff()']) f where pg_temp.err('authenticated', 'select ' || f || '::text') not like '42501|%'), '', 'staff cannot call the internal review or guard functions directly');
select is(pg_temp.err('authenticated', 'select count(*) from app.moderation_decisions'), '42501|permission denied for schema app|', 'staff have no direct table access either');

-- ===================================================================================================================
-- B. members, anon, service_role and (by catalog) the worker cannot write or read the records
-- ===================================================================================================================
select is(
  (select coalesce(string_agg(r.role_name || ' ' || t.tbl || ' ' || o.op, E'\n'), '') from (values ('authenticated'), ('anon'), ('service_role')) r(role_name)
     cross join (values ('version_assessments'), ('rights_reviews'), ('moderation_decisions')) t(tbl)
     cross join (values ('select 1 from app.%s limit 1'), ('insert into app.%s default values'), ('update app.%s set seq = 1'), ('delete from app.%s'), ('truncate app.%s')) o(op)
    where pg_temp.err(r.role_name, format(o.op, t.tbl)) not like '42501|%'),
  '', 'authenticated, anon and service_role are denied SELECT/INSERT/UPDATE/DELETE/TRUNCATE on all three record tables');
select is((select count(*)::int from (select has_table_privilege('hackass_worker', c.oid, p.priv) h from pg_class c cross join (values ('select'), ('insert'), ('update'), ('delete')) p(priv)
            where c.oid in ('app.version_assessments'::regclass, 'app.rights_reviews'::regclass, 'app.moderation_decisions'::regclass)) x where h), 0, 'the worker role holds no privilege on the record tables');
select is((select count(*)::int from information_schema.routine_privileges where grantee in ('hackass_worker', 'PUBLIC', 'anon', 'service_role') and routine_schema in ('api', 'app_review') and routine_name in ('record_decision', 'record_rights_review', 'record_risk_assessment', 'start_review')), 0, 'and no EXECUTE on the writing functions');

-- ===================================================================================================================
-- C. the review flow, step by step, on the main submission (u3 reviewer)
-- ===================================================================================================================
select pg_temp.as_staff(3);
create temp table t_q as select pg_temp.call('authenticated', 'select api.list_submissions_for_review()') as r;
grant all on t_q to public;
select is((select jsonb_array_length(r) from t_q), 7, 'the queue holds the 7 submissions u3 may review (the one naming u3 as author is hidden)');
select is((select count(*)::int from jsonb_array_elements((select r from t_q)) e where e ->> 'submission_id' = pg_temp.sid('named3')), 0, 'a submission that names the reviewer as a member author is not listed for them');
select is(pg_temp.err('authenticated', format('select api.get_submission_for_review(%L)::text', pg_temp.sid('named3'))), '42501|self_review|', 'and cannot be read by them either (self_review)');
select is((api.get_submission_for_review(pg_temp.sid('main')::uuid)) -> 'approval_blockers', '["assessment_missing", "rights_not_clear:1"]'::jsonb, 'get_submission_for_review lists the approval blockers: no assessment, claim 1 not cleared');
select is((api.get_submission_for_review(pg_temp.sid('main')::uuid)) -> 'content' ->> 'title', 'Main submission', 'the reviewer reads the frozen content');
select is((api.get_submission_for_review(pg_temp.sid('main')::uuid)) ->> 'state', 'submitted', 'and the state');
-- wrong hash
select pg_temp.lk(pg_temp.err('authenticated', format('select api.start_review(%L, %L)::text', pg_temp.sid('main'), repeat('a', 64))), 'PT409|hash_mismatch|%', 'start_review with the wrong hash is refused (hash_mismatch)');
select pg_temp.lk(pg_temp.err('authenticated', format('select api.start_review(%L, %L)::text', pg_temp.sid('main'), 'NOT-HEX')), 'PT422|invalid_content|expected_hash', 'a malformed hash is refused');
-- decisions need a review in progress
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''HOLD'', array[''other''], null, null)::text', pg_temp.sid('main'), pg_temp.hash('main'))), 'PT409|invalid_state|submitted', 'a decision before start_review is refused (invalid_state)');
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_risk_assessment(%L, %L, ''low'', ''Long enough rationale.'')::text', pg_temp.sid('main'), pg_temp.hash('main'))), 'PT409|invalid_state|submitted', 'an assessment before start_review is refused');
select is(api.start_review(pg_temp.sid('main')::uuid, pg_temp.hash('main')) ->> 'state', 'under_review', 'start_review moves the submission to under_review');
select is(api.start_review(pg_temp.sid('main')::uuid, pg_temp.hash('main')) ->> 'state', 'under_review', 'and is idempotent');
select is(pg_temp.owner_val(format($$select state from app.version_lifecycle where version_id = %L$$, pg_temp.vid('main'))), 'under_review', 'the lifecycle row (not the content) changed');

-- approval is blocked, step by step, with the reasons
select is(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''PUBLISH'', null, null, null)::text', pg_temp.sid('main'), pg_temp.hash('main'))), 'PT409|approval_blocked|assessment_missing,rights_not_clear:1', 'PUBLISH with no assessment and no rights review is blocked, naming both');
select api.record_risk_assessment(pg_temp.sid('main')::uuid, pg_temp.hash('main'), 'low', 'Ordinary household tip, no hazard.');
select is(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''PUBLISH'', null, null, null)::text', pg_temp.sid('main'), pg_temp.hash('main'))), 'PT409|approval_blocked|rights_not_clear:1', 'with an assessment, rights are still not clear: the author''s own declaration (original_work) is not clearance');
-- rights reviews: validation
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_rights_review(%L, %L, 1, ''clear'', null, null, null)::text', pg_temp.sid('main'), pg_temp.hash('main'))), 'PT422|invalid_content|%', 'a clear review needs a basis and an evidence note');
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_rights_review(%L, %L, 1, ''clear'', ''staff_original_check'', ''short'', null)::text', pg_temp.sid('main'), pg_temp.hash('main'))), 'PT422|invalid_content|%', 'an evidence note under 10 characters is refused');
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_rights_review(%L, %L, 1, ''clear'', ''no_such_basis'', ''Checked the original thoroughly.'', null)::text', pg_temp.sid('main'), pg_temp.hash('main'))), 'PT422|invalid_content|%', 'an unknown basis code is refused');
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_rights_review(%L, %L, 1, ''clear'', ''staff_original_check'', ''Checked the original thoroughly.'', %L)::text', pg_temp.sid('main'), pg_temp.hash('main'), current_date)), 'PT422|invalid_content|expires_on', 'a review that is already expired is refused');
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_rights_review(%L, %L, 7, ''hold'', null, null, null)::text', pg_temp.sid('main'), pg_temp.hash('main'))), 'PT404|not_found|claim', 'a claim that does not exist is not_found');
-- the states that do not clear
select api.record_rights_review(pg_temp.sid('main')::uuid, pg_temp.hash('main'), 1, 'needs_evidence', null, null, null);
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''PUBLISH'', null, null, null)::text', pg_temp.sid('main'), pg_temp.hash('main'))), 'PT409|approval_blocked|rights_not_clear:1', 'needs_evidence does not clear');
select api.record_rights_review(pg_temp.sid('main')::uuid, pg_temp.hash('main'), 1, 'hold', null, null, null);
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''PUBLISH'', null, null, null)::text', pg_temp.sid('main'), pg_temp.hash('main'))), 'PT409|approval_blocked|rights_not_clear:1', 'hold does not clear');
select api.record_rights_review(pg_temp.sid('main')::uuid, pg_temp.hash('main'), 1, 'clear', 'staff_original_check', 'Checked the original thoroughly.', current_date + 30);
select api.record_rights_review(pg_temp.sid('main')::uuid, pg_temp.hash('main'), 1, 'revoked', null, null, null);
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''PUBLISH'', null, null, null)::text', pg_temp.sid('main'), pg_temp.hash('main'))), 'PT409|approval_blocked|rights_not_clear:1', 'a later revoked review beats an earlier clear one (the latest per claim wins)');
select is((select r -> 'rights' -> 0 ->> 'seq' from (select api.get_submission_for_review(pg_temp.sid('main')::uuid) r) x), '4', 'the claim has four review records; the effective one is seq 4');
select api.record_rights_review(pg_temp.sid('main')::uuid, pg_temp.hash('main'), 1, 'clear', 'staff_original_check', 'Checked the original again; it is the author''s own work.', current_date + 30);
select is(api.get_submission_for_review(pg_temp.sid('main')::uuid) -> 'approval_blockers', '[]'::jsonb, 'with a low assessment and a clear review of the only claim nothing blocks approval');

-- expired clearance does not count (recorded directly as the owner with yesterday''s date; the RPC refuses such dates)
select pg_temp.owner_run(format($$insert into app.rights_reviews (submission_id, version_id, content_hash, canon_version, claim_no, status, basis_code, evidence_note, expires_on, reviewer_id) select id, version_id, content_hash, canon_version, 1, 'clear', 'staff_original_check', 'An already expired clearance.', current_date - 1, %L from app.submissions where id = %L$$, pg_temp.u(3), pg_temp.sid('main')));
select is(api.get_submission_for_review(pg_temp.sid('main')::uuid) -> 'approval_blockers', '["rights_not_clear:1"]'::jsonb, 'a clear review whose expires_on has passed no longer clears (the newest record is the expired one)');
select api.record_rights_review(pg_temp.sid('main')::uuid, pg_temp.hash('main'), 1, 'clear', 'staff_original_check', 'Renewed after the expiry, checked again.', current_date + 90);

-- the decision
select throws_ok(format($$select api.record_decision(%L, %L, 'PUBLISH', null, null, '00000000-0000-4000-8000-0000000000aa')$$, pg_temp.sid('main'), pg_temp.hash('main')), 'PT409', 'decision_conflict', 'naming a prior decision that does not exist is a conflict');
create temp table t_d1 as select api.record_decision(pg_temp.sid('main')::uuid, pg_temp.hash('main'), 'PUBLISH', null, 'Looks good.', null) as r;
grant all on t_d1 to public;
select is((select r ->> 'seq' from t_d1), '1', 'the approval is decision 1');
select is((select r ->> 'supersedes_id' from t_d1), null, 'it supersedes nothing');
select is((select r ->> 'state' from t_d1), 'approved', 'and the lifecycle is approved (a record about the version; publication is a later slice)');
reset role;
select is(pg_temp.owner_val(format($q$select (d.actor_id = %L and d.content_hash = s.content_hash and d.version_id = s.version_id and d.canon_version = s.canon_version and d.decided_by_kind = 'human')::text from app.moderation_decisions d join app.submissions s on s.id = d.submission_id where d.id = %L$q$, pg_temp.u(3), (select r ->> 'decision_id' from t_d1))), 'true', 'the stored decision is bound to the exact frozen version, hash and canon version, and its reviewer is the authenticated caller');
select is(pg_temp.owner_val(format($q$select count(*)::text from app.rights_reviews where submission_id = %L and claim_hash = app_review.claim_hash(version_id, claim_no)$q$, pg_temp.sid('main'))), '7', 'every rights review carries the hash of the claim it reviewed (7 records)');
select is(pg_temp.owner_val(format($q$select (position(app_review.claim_line(%L::uuid, 1) in app_content.canonical_text(%L::uuid)) > 0)::text$q$, pg_temp.vid('main'), pg_temp.vid('main'))), 'true', 'the claim line a review hashes appears verbatim in the version''s canonical text');

-- ===================================================================================================================
-- D. decision history: linear chain, optimistic concurrency, immutable records
-- ===================================================================================================================
select pg_temp.as_staff(3);
select throws_ok(format($$select api.record_decision(%L, %L, 'REJECT', array['quality'], 'Changed my mind.', null)$$, pg_temp.sid('main'), pg_temp.hash('main')), 'PT409', 'decision_conflict', 'deciding without knowing the latest decision is a conflict (expected prior = none, but one exists)');
create temp table t_d2 as select api.record_decision(pg_temp.sid('main')::uuid, pg_temp.hash('main'), 'REJECT', array['quality'], 'Withdrawn approval after a second look.', (select (r ->> 'decision_id')::uuid from t_d1)) as r;
grant all on t_d2 to public;
select is((select r ->> 'seq' from t_d2), '2', 'the second decision has seq 2');
select is((select r ->> 'supersedes_id' from t_d2), (select r ->> 'decision_id' from t_d1), 'and supersedes the first');
select is((select r ->> 'state' from t_d2), 'rejected', 'the lifecycle follows: rejected');
select throws_ok(format($$select api.record_decision(%L, %L, 'REQUEST_CHANGES', null, null, %L)$$, pg_temp.sid('main'), pg_temp.hash('main'), (select r ->> 'decision_id' from t_d2)), 'PT422', 'invalid_content', 'a non-approving decision must carry at least one reason code (the constraint is named, no value echoed)');
select is((api.get_submission_for_review(pg_temp.sid('main')::uuid) -> 'decisions')::text like '%"seq": 1%"seq": 2%', true, 'the history is returned in order');
reset role;
select is(pg_temp.owner_val(format($q$select string_agg(seq::text || ':' || coalesce(supersedes_id::text, '-'), ',' order by seq) from app.moderation_decisions where submission_id = %L$q$, pg_temp.sid('main'))), (select '1:-,2:' || (r ->> 'decision_id') from t_d1), 'the stored chain is exactly 1:- , 2:<id of 1>');
-- append-only
select is(pg_temp.owner_do(format($$update app.moderation_decisions set decision = 'PUBLISH' where submission_id = %L$$, pg_temp.sid('main'))), 'PT409|record_immutable', 'a decision cannot be updated');
select is(pg_temp.owner_do(format($$delete from app.moderation_decisions where submission_id = %L$$, pg_temp.sid('main'))), 'PT409|record_immutable', 'a decision cannot be deleted');
select ok(pg_temp.owner_do('truncate app.moderation_decisions') in ('PT409|truncate_forbidden', '0A000|cannot truncate a table referenced in a foreign key constraint'), 'the decision table cannot be truncated (by its trigger, or since F2-C2 by PostgreSQL itself: publications reference it)');
select is(pg_temp.owner_do(format($$update app.rights_reviews set status = 'clear' where submission_id = %L$$, pg_temp.sid('main'))), 'PT409|record_immutable', 'a rights review cannot be updated');
select is(pg_temp.owner_do(format($$delete from app.rights_reviews where submission_id = %L$$, pg_temp.sid('main'))), 'PT409|record_immutable', 'a rights review cannot be deleted');
select ok(pg_temp.owner_do('truncate app.rights_reviews') in ('PT409|truncate_forbidden', '0A000|cannot truncate a table referenced in a foreign key constraint'), 'the rights table cannot be truncated (by its trigger, or since F2-C2 by PostgreSQL itself: publications reference it)');
select is(pg_temp.owner_do(format($$update app.version_assessments set risk_class = 'low' where submission_id = %L$$, pg_temp.sid('main'))), 'PT409|record_immutable', 'an assessment cannot be updated');
select is(pg_temp.owner_do(format($$delete from app.version_assessments where submission_id = %L$$, pg_temp.sid('main'))), 'PT409|record_immutable', 'an assessment cannot be deleted');
select ok(pg_temp.owner_do('truncate app.version_assessments') in ('PT409|truncate_forbidden', '0A000|cannot truncate a table referenced in a foreign key constraint'), 'the assessment table cannot be truncated (by its trigger, or since F2-C2 by PostgreSQL itself: publications reference it)');
-- binding is a database constraint, and the sequence/chain/claim hash are trigger-assigned (a caller cannot choose them)
select pg_temp.lk(pg_temp.owner_do(format($$insert into app.moderation_decisions (submission_id, version_id, content_hash, canon_version, decision, reason_codes, actor_id) select id, version_id, decode(repeat('00', 32), 'hex'), canon_version, 'HOLD', array['other'], %L from app.submissions where id = %L$$, pg_temp.u(3), pg_temp.sid('main'))), 'PT409|hash_mismatch', 'a decision quoting the wrong content hash is refused by the trigger');
select pg_temp.owner_run('alter table app.moderation_decisions disable trigger decisions_guard');
select pg_temp.lk(pg_temp.owner_do(format($$insert into app.moderation_decisions (submission_id, version_id, content_hash, canon_version, seq, decision, reason_codes, actor_id) select id, version_id, decode(repeat('00', 32), 'hex'), canon_version, 50, 'HOLD', array['other'], %L from app.submissions where id = %L$$, pg_temp.u(3), pg_temp.sid('main'))), '23503|%', 'even with the trigger switched off, the composite foreign key refuses a decision whose hash is not the submission''s frozen hash');
select pg_temp.owner_run('alter table app.moderation_decisions enable trigger decisions_guard');
select pg_temp.owner_run(format($$insert into app.moderation_decisions (submission_id, version_id, content_hash, canon_version, seq, supersedes_id, decision, reason_codes, actor_id) select id, version_id, content_hash, canon_version, 99, null, 'HOLD', array['other'], %L from app.submissions where id = %L$$, pg_temp.u(5), pg_temp.sid('chain')));
select is(pg_temp.owner_val(format($q$select seq::text || ':' || coalesce(supersedes_id::text, '-') from app.moderation_decisions where submission_id = %L$q$, pg_temp.sid('chain'))), '1:-', 'a caller-supplied seq or supersedes_id is overwritten: the trigger assigns them under the submission lock');
select is(pg_temp.owner_do(format($$insert into app.moderation_decisions (submission_id, version_id, content_hash, canon_version, decision, reason_codes, actor_id, decided_by_kind) select id, version_id, content_hash, canon_version, 'HOLD', array['other'], %L, 'automated' from app.submissions where id = %L$$, pg_temp.u(5), pg_temp.sid('chain'))) like '23514|%', true, 'only human decisions can be recorded in this slice');
select pg_temp.lk(pg_temp.owner_do(format($$insert into app.moderation_decisions (submission_id, version_id, content_hash, canon_version, decision, reason_codes, actor_id) values (%L, %L, decode(%L, 'hex'), 1, 'HOLD', array['other'], %L)$$, '99999999-9999-4999-8999-999999999999', pg_temp.vid('chain'), pg_temp.hash('chain'), pg_temp.u(5))), 'PT404|not_found', 'a decision for a submission that does not exist fails (so unfrozen content can never be decided)');
select pg_temp.lk(pg_temp.owner_do(format($$insert into app.moderation_decisions (submission_id, version_id, content_hash, canon_version, decision, reason_codes, note, actor_id) select id, version_id, content_hash, canon_version, 'HOLD', array['not_a_code'], null, %L from app.submissions where id = %L$$, pg_temp.u(5), pg_temp.sid('chain'))), '23514|%', 'unknown reason codes are refused by the table');

-- ===================================================================================================================
-- E. approval needs more than the reviewer's say-so
-- ===================================================================================================================
-- unresolved references: a member-profile attribution and an asset keep the submission ineligible even with a low assessment and cleared rights
select pg_temp.as_staff(5);
select api.start_review(pg_temp.sid('refs')::uuid, pg_temp.hash('refs'));
select api.record_risk_assessment(pg_temp.sid('refs')::uuid, pg_temp.hash('refs'), 'low', 'Ordinary household tip, no hazard.');
select api.record_rights_review(pg_temp.sid('refs')::uuid, pg_temp.hash('refs'), 1, 'clear', 'staff_original_check', 'Checked the original thoroughly.', null);
select is(api.get_submission_for_review(pg_temp.sid('refs')::uuid) -> 'unresolved_references', '["asset_id", "profile_id"]'::jsonb, 'the reviewer sees both unresolved references');
select is(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''PUBLISH'', null, null, null)::text', pg_temp.sid('refs'), pg_temp.hash('refs'))), 'PT409|approval_blocked|unresolved_references:asset_id,unresolved_references:profile_id', 'PUBLISH is refused while a profile or an asset reference is unresolved');
create temp table t_d3 as select api.record_decision(pg_temp.sid('refs')::uuid, pg_temp.hash('refs'), 'REQUEST_CHANGES', array['attribution'], 'Resolve the profile and asset references.', null) as r;
grant all on t_d3 to public;
select is((select r ->> 'state' from t_d3), 'under_review', 'a non-approving decision is still recorded (REQUEST_CHANGES keeps the review open)');
-- author declarations alone: a second claim declaring a licence is not cleared by declaring it
select pg_temp.as_staff(5);
select api.start_review(pg_temp.sid('two')::uuid, pg_temp.hash('two'));
select api.record_risk_assessment(pg_temp.sid('two')::uuid, pg_temp.hash('two'), 'medium', 'Reuses a third-party source; check the licence.');
select api.record_rights_review(pg_temp.sid('two')::uuid, pg_temp.hash('two'), 1, 'clear', 'staff_original_check', 'Checked the original thoroughly.', null);
select is(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''PUBLISH'', null, null, null)::text', pg_temp.sid('two'), pg_temp.hash('two'))), 'PT409|approval_blocked|rights_not_clear:2', 'a claim that DECLARES an MIT licence is not cleared by the declaration: only a staff rights review clears it');
select api.record_rights_review(pg_temp.sid('two')::uuid, pg_temp.hash('two'), 2, 'clear', 'license_text_checked', 'The source page shows MIT; the notice is preserved.', null);
select lives_ok(format($$select api.record_decision(%L, %L, 'PUBLISH', null, null, null)$$, pg_temp.sid('two'), pg_temp.hash('two')), 'with both claims cleared by staff and a medium assessment, approval succeeds');

-- risk classes
select pg_temp.as_staff(5);
select api.start_review(pg_temp.sid('risk')::uuid, pg_temp.hash('risk'));
select api.record_rights_review(pg_temp.sid('risk')::uuid, pg_temp.hash('risk'), 1, 'clear', 'staff_original_check', 'Checked the original thoroughly.', null);
select api.record_risk_assessment(pg_temp.sid('risk')::uuid, pg_temp.hash('risk'), 'prohibited', 'Describes something that must not be published.');
select is(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''PUBLISH'', null, null, null)::text', pg_temp.sid('risk'), pg_temp.hash('risk'))), 'PT409|approval_blocked|risk_prohibited', 'a prohibited risk class blocks approval');
select api.record_risk_assessment(pg_temp.sid('risk')::uuid, pg_temp.hash('risk'), 'high', 'Uses a hot pan near children; needs senior sign-off.');
select is(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''PUBLISH'', null, null, null)::text', pg_temp.sid('risk'), pg_temp.hash('risk'))), 'PT409|approval_blocked|risk_high_needs_admin', 'a high risk class needs an admin: a reviewer is refused');
select pg_temp.as_staff(4);
select lives_ok(format($$select api.record_decision(%L, %L, 'PUBLISH', null, null, null)$$, pg_temp.sid('risk'), pg_temp.hash('risk')), 'and an admin may approve it');
select pg_temp.as_staff(5);
select is(pg_temp.err('authenticated', format('select api.record_risk_assessment(%L, %L, ''low'', ''x'')::text', pg_temp.sid('risk'), pg_temp.hash('risk'))), 'PT422|invalid_content|' || (select conname from pg_constraint where conrelid = 'app.version_assessments'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%clean_text(rationale%'), 'a rationale shorter than 10 characters is refused (constraint named, value not echoed)');

-- ===================================================================================================================
-- F. self-review and caller-supplied identity
-- ===================================================================================================================
select pg_temp.as_staff(6);
select is(
  (select coalesce(string_agg(fn || ':' || split_part(pg_temp.err('authenticated', sql), '|', 2), ', ' order by fn), '') from pg_temp.calls(pg_temp.sid('own6'), pg_temp.hash('own6')) where fn <> 'list_submissions_for_review'
     and pg_temp.err('authenticated', sql) not like '42501|self_review|%'),
  '', 'a staff member cannot read, start, assess, rights-review or decide their OWN submission (self_review) -- all five functions');
select is((select count(*)::int from jsonb_array_elements(pg_temp.call('authenticated', 'select api.list_submissions_for_review()')) e where e ->> 'submission_id' = pg_temp.sid('own6')), 0, 'and it is not in their queue');
select pg_temp.as_staff(3);
select is(
  (select coalesce(string_agg(fn, ', ' order by fn), '') from pg_temp.calls(pg_temp.sid('named3'), pg_temp.hash('named3')) where fn <> 'list_submissions_for_review' and pg_temp.err('authenticated', sql) not like '42501|self_review|%'),
  '', 'a reviewer named as a member author in the content cannot review it either');
-- caller-supplied reviewer identity does not exist as a parameter
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_decision(p_submission_id => %L, p_expected_hash => %L, p_decision => ''HOLD'', p_reason_codes => array[''other''], p_note => null, p_expected_prior_decision_id => null, p_actor_id => %L)::text', pg_temp.sid('chain'), pg_temp.hash('chain'), pg_temp.u(5))), '42883|%', 'record_decision has no actor parameter: supplying one is an error');
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_rights_review(p_submission_id => %L, p_expected_hash => %L, p_claim_no => 1, p_status => ''hold'', p_basis_code => null, p_evidence_note => null, p_expires_on => null, p_reviewer_id => %L)::text', pg_temp.sid('chain'), pg_temp.hash('chain'), pg_temp.u(5))), '42883|%', 'record_rights_review has no reviewer parameter');
select api.start_review(pg_temp.sid('chain')::uuid, pg_temp.hash('chain'));
select api.record_rights_review(pg_temp.sid('chain')::uuid, pg_temp.hash('chain'), 1, 'hold', null, null, null);
select api.record_risk_assessment(pg_temp.sid('chain')::uuid, pg_temp.hash('chain'), 'low', 'Ordinary household tip, no hazard.');
reset role;
select is(pg_temp.owner_val(format($q$select (select string_agg(reviewer_id::text, ',') from app.rights_reviews where submission_id = %L) || '|' || (select string_agg(assessed_by::text, ',') from app.version_assessments where submission_id = %L)$q$, pg_temp.sid('chain'), pg_temp.sid('chain'))), pg_temp.u(3) || '|' || pg_temp.u(3), 'the recorded reviewer is the authenticated caller (u3), not anything the caller could name');

-- ===================================================================================================================
-- G. the database backstops repeat the rules for any other writer (here: the owner role inserting directly)
-- ===================================================================================================================
select pg_temp.lk(pg_temp.owner_do(format($$insert into app.moderation_decisions (submission_id, version_id, content_hash, canon_version, decision, reason_codes, actor_id) select id, version_id, content_hash, canon_version, 'PUBLISH', array[]::text[], %L from app.submissions where id = %L$$, pg_temp.u(5), pg_temp.sid('chain'))), 'PT409|approval_blocked', 'a direct PUBLISH insert is refused by the trigger when rights are not clear');
select pg_temp.lk(pg_temp.owner_do(format($$insert into app.moderation_decisions (submission_id, version_id, content_hash, canon_version, decision, reason_codes, actor_id) select id, version_id, content_hash, canon_version, 'HOLD', array['other'], %L from app.submissions where id = %L$$, pg_temp.u(2), pg_temp.sid('chain'))), '42501|not_staff', 'a direct insert by someone without a staff role is refused');
select pg_temp.lk(pg_temp.owner_do(format($$insert into app.moderation_decisions (submission_id, version_id, content_hash, canon_version, decision, reason_codes, actor_id) select id, version_id, content_hash, canon_version, 'HOLD', array['other'], %L from app.submissions where id = %L$$, pg_temp.u(6), pg_temp.sid('own6'))), '42501|self_review', 'a direct insert by the submitter is refused (self_review)');
select pg_temp.lk(pg_temp.owner_do(format($$insert into app.rights_reviews (submission_id, version_id, content_hash, canon_version, claim_no, status, reviewer_id) select id, version_id, content_hash, canon_version, 1, 'hold', %L from app.submissions where id = %L$$, pg_temp.u(2), pg_temp.sid('chain'))), '42501|not_staff', 'a direct rights-review insert by a non-staff account is refused');
select pg_temp.lk(pg_temp.owner_do(format($$insert into app.rights_reviews (submission_id, version_id, content_hash, canon_version, claim_no, status, reviewer_id) select id, version_id, content_hash, canon_version, 5, 'hold', %L from app.submissions where id = %L$$, pg_temp.u(5), pg_temp.sid('chain'))), 'PT404|not_found', 'a rights review must name a claim that exists');
select pg_temp.owner_run('alter table app.rights_reviews disable trigger rights_reviews_guard');
select pg_temp.lk(pg_temp.owner_do(format($$insert into app.rights_reviews (submission_id, version_id, content_hash, canon_version, claim_no, claim_hash, seq, status, reviewer_id) select id, version_id, content_hash, canon_version, 5, decode(repeat('00', 32), 'hex'), 1, 'hold', %L from app.submissions where id = %L$$, pg_temp.u(5), pg_temp.sid('chain'))), '23503|%', 'and with the trigger off the foreign key to source_claims still refuses a claim that does not exist');
select pg_temp.owner_run('alter table app.rights_reviews enable trigger rights_reviews_guard');
select pg_temp.lk(pg_temp.owner_do(format($$insert into app.version_assessments (submission_id, version_id, content_hash, canon_version, risk_class, rationale, assessed_by) select id, version_id, content_hash, canon_version, 'low', 'A long enough rationale.', %L from app.submissions where id = %L$$, pg_temp.u(6), pg_temp.sid('own6'))), '42501|self_review', 'a direct assessment by the submitter is refused');

-- ===================================================================================================================
-- H. hash mismatch, including content that no longer hashes to its frozen hash
-- ===================================================================================================================
select pg_temp.as_staff(5);
select api.start_review(pg_temp.sid('tamper')::uuid, pg_temp.hash('tamper'));
select is(
  (select coalesce(string_agg(fn, ', ' order by fn), '') from pg_temp.calls(pg_temp.sid('tamper'), repeat('0', 64)) where fn not in ('list_submissions_for_review', 'get_submission_for_review') and pg_temp.err('authenticated', sql) not like 'PT409|hash_mismatch|%'),
  '', 'a wrong expected hash is refused by every write function (hash_mismatch)');
reset role;
-- tamper with the committed content behind the database's back (the owner disables the guard in this transaction only)
select pg_temp.owner_run('alter table app.hack_steps disable trigger hack_steps_guard');
select pg_temp.owner_run(format($$update app.hack_steps set body = 'Tampered step.' where version_id = %L$$, pg_temp.vid('tamper')));
select pg_temp.owner_run('alter table app.hack_steps enable trigger hack_steps_guard');
select pg_temp.as_staff(5);
select is(
  (select coalesce(string_agg(fn, ', ' order by fn), '') from pg_temp.calls(pg_temp.sid('tamper'), pg_temp.hash('tamper')) where fn not in ('list_submissions_for_review', 'get_submission_for_review') and pg_temp.err('authenticated', sql) not like 'PT409|hash_mismatch|%'),
  '', 'content that no longer recomputes to its frozen hash blocks every review write even when the reviewer quotes the right hash');
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''PUBLISH'', null, null, null)::text', pg_temp.sid('tamper'), pg_temp.hash('tamper'))), 'PT409|hash_mismatch|%', 'in particular an approval of tampered content is refused');

-- states in which a submission may not be reviewed
select pg_temp.as_staff(5);
reset role;
select pg_temp.owner_run(format($$update app.version_lifecycle set state = 'withdrawn' where version_id = %L$$, pg_temp.vid('chain')));
select pg_temp.as_staff(5);
select is(
  (select coalesce(string_agg(fn, ', ' order by fn), '') from pg_temp.calls(pg_temp.sid('chain'), pg_temp.hash('chain')) where fn in ('start_review', 'record_risk_assessment', 'record_rights_review', 'record_decision')
     and pg_temp.err('authenticated', sql) not like 'PT409|invalid_state|withdrawn'),
  '', 'a withdrawn version cannot be put under review, assessed, rights-reviewed or decided (invalid_state)');
reset role;
select pg_temp.owner_run(format($$update app.version_lifecycle set state = 'superseded' where version_id = %L$$, pg_temp.vid('chain')));
select pg_temp.as_staff(5);
select is(
  (select coalesce(string_agg(fn, ', ' order by fn), '') from pg_temp.calls(pg_temp.sid('chain'), pg_temp.hash('chain')) where fn in ('start_review', 'record_risk_assessment', 'record_rights_review', 'record_decision')
     and pg_temp.err('authenticated', sql) not like 'PT409|invalid_state|superseded'),
  '', 'and neither can a superseded version');
reset role;
select pg_temp.owner_run(format($$update app.version_lifecycle set state = 'under_review' where version_id = %L$$, pg_temp.vid('chain')));

-- a rights review that names a stale claim hash never clears (defence in depth: the trigger normally assigns the hash)
select pg_temp.owner_run('alter table app.rights_reviews disable trigger rights_reviews_guard');
select pg_temp.owner_run(format($$insert into app.rights_reviews (submission_id, version_id, content_hash, canon_version, claim_no, claim_hash, seq, status, basis_code, evidence_note, reviewer_id) select id, version_id, content_hash, canon_version, 1, decode(repeat('00', 32), 'hex'), 90, 'clear', 'staff_original_check', 'A clear review carrying a hash that is not the claim''s.', %L from app.submissions where id = %L$$, pg_temp.u(5), pg_temp.sid('chain')));
select pg_temp.owner_run('alter table app.rights_reviews enable trigger rights_reviews_guard');
select is(pg_temp.owner_val(format($q$select pg_catalog.array_to_string(app_review.approval_blockers(%L, %L), ',')$q$, pg_temp.sid('chain'), pg_temp.u(5))), 'rights_not_clear:1', 'a clear review whose claim_hash is not the claim''s current hash does not clear it');
select pg_temp.owner_run(format($$insert into app.rights_reviews (submission_id, version_id, content_hash, canon_version, claim_no, status, basis_code, evidence_note, reviewer_id) select id, version_id, content_hash, canon_version, 1, 'clear', 'staff_original_check', 'A correct, freshly recorded clearance.', %L from app.submissions where id = %L$$, pg_temp.u(5), pg_temp.sid('chain')));
select is(pg_temp.owner_val(format($q$select pg_catalog.array_to_string(app_review.approval_blockers(%L, %L), ',')$q$, pg_temp.sid('chain'), pg_temp.u(5))), '', 'while a correct newer clearance leaves nothing in the way');

-- ===================================================================================================================
-- I. unfrozen content cannot be reviewed; the queue paginates deterministically
-- ===================================================================================================================
reset role;
select pg_temp.as_member(1);
create temp table t_draft as select pg_temp.call('authenticated', 'select api.create_draft()') as r;
grant all on t_draft to public;
select pg_temp.as_staff(5);
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''PUBLISH'', null, null, null)::text', (select r ->> 'version_id' from t_draft), repeat('a', 64))), 'PT404|not_found|%', 'a draft''s version id is not a submission: there is nothing to approve');
select pg_temp.lk(pg_temp.err('authenticated', format('select api.start_review(%L, %L)::text', (select r ->> 'version_id' from t_draft), repeat('a', 64))), 'PT404|not_found|%', 'and it cannot be put under review');
create temp table t_all as select pg_temp.call('authenticated', 'select api.list_submissions_for_review(50)') as r;
grant all on t_all to public;
create temp table t_p1 as select pg_temp.call('authenticated', 'select api.list_submissions_for_review(3)') as r;
grant all on t_p1 to public;
select is((select jsonb_array_length(r) from t_p1), 3, 'page 1 holds 3');
create temp table t_p2 as select pg_temp.call('authenticated', format('select api.list_submissions_for_review(3, array[''submitted'', ''under_review'']::text[], %L, %L)', (select r -> 2 ->> 'submitted_at' from t_p1), (select r -> 2 ->> 'submission_id' from t_p1))) as r;
grant all on t_p2 to public;
select is((select jsonb_array_length(r) from t_p2), least(3, (select jsonb_array_length(r) - 3 from t_all)), 'page 2 holds the next 3 (or what remains) of the same filter');
select is((select count(*)::int from jsonb_array_elements((select r from t_p1)) a join jsonb_array_elements((select r from t_p2)) b on a ->> 'submission_id' = b ->> 'submission_id'), 0, 'with no overlap between pages');
select is((select jsonb_agg(e ->> 'submission_id' order by o) from (select e, o from jsonb_array_elements((select r from t_p1)) with ordinality x(e, o) union all select e, o + 3 from jsonb_array_elements((select r from t_p2)) with ordinality y(e, o)) z),
          (select jsonb_agg(e ->> 'submission_id' order by o) from jsonb_array_elements((select r from t_all)) with ordinality w(e, o) where o <= 3 + (select jsonb_array_length(r) from t_p2)), 'and the two pages are exactly the first entries of the full, ordered queue');
select pg_temp.lk(pg_temp.err('authenticated', 'select api.list_submissions_for_review(3, array[''bogus'']::text[])::text'), 'PT422|invalid_content|p_states', 'an unknown state filter is refused');
select pg_temp.lk(pg_temp.err('authenticated', format('select api.list_submissions_for_review(3, array[''submitted'']::text[], %L, null)::text', now())), 'PT422|invalid_content|cursor', 'half a cursor is refused');

-- ===================================================================================================================
-- J. global invariants
-- ===================================================================================================================
reset role;
select is(pg_temp.owner_val($q$select count(*)::text from (select submission_id from app.moderation_decisions group by submission_id having max(seq) <> count(*) or min(seq) <> 1) x$q$), '0', 'every submission''s decision seqs are contiguous from 1');
select is(pg_temp.owner_val($q$select count(*)::text from app.moderation_decisions d left join app.moderation_decisions p on p.id = d.supersedes_id where (d.seq = 1 and d.supersedes_id is not null) or (d.seq > 1 and (p.id is null or p.seq <> d.seq - 1 or p.submission_id <> d.submission_id))$q$), '0', 'and each decision supersedes exactly the previous one of the same submission');
select is(pg_temp.owner_val($q$select count(*)::text from app.moderation_decisions d join app.submissions s on s.id = d.submission_id where d.content_hash <> s.content_hash or d.version_id <> s.version_id$q$), '0', 'every decision is bound to its submission''s exact hash and version');

select * from finish();
rollback;
