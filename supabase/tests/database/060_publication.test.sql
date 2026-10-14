-- F2-C2: human publication records and withdrawal, exercised through the exposed api functions as the real Supabase roles (claims in
-- request.jwt.claims, as PostgREST provides them) and through direct DML as the owner role. Real signed JWTs and genuine concurrency are in
-- scripts/local-f2c2-checks.mjs.
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
insert into t_s select k, pg_temp.submit_as(1, pg_temp.doc('Submission ' || k)) from unnest(array['a', 'hi', 'fk', 'multi', 'old1', 'stale', 'tamper', 'exp', 'rvk', 'rej', 'hold', 'rev', 'pro', 'highlater', 'benign', 'wd', 'sup1', 'solo']) k;
insert into t_s values
  ('two',  pg_temp.submit_as(1, pg_temp.doc('Two claims') || jsonb_build_object('source_claims', jsonb_build_array(jsonb_build_object('kind', 'original_work'), jsonb_build_object('kind', 'third_party_reuse', 'canonical_url', 'https://example.test/src', 'license_spdx', 'MIT', 'permission_note', 'The author says it is MIT.'))))) on conflict (k) do update set r = excluded.r;
insert into t_s values
  ('refs', pg_temp.submit_as(1, pg_temp.doc('Has references') || jsonb_build_object('attributions', jsonb_build_array(jsonb_build_object('role', 'author', 'profile_id', pg_temp.u(2))), 'assets', jsonb_build_array(jsonb_build_object('asset_id', '30000000-0000-4000-8000-000000000001', 'sha256', repeat('ab', 32)))))),
  ('own6', pg_temp.submit_as(6, pg_temp.doc('Staff member''s own work'))),
  ('own6b', pg_temp.submit_as(6, pg_temp.doc('Approved by its own author')));
create function pg_temp.sid(k text) returns text language sql as $$ select r ->> 'submission_id' from t_s where t_s.k = $1 $$;
create function pg_temp.vid(k text) returns text language sql as $$ select r ->> 'version_id' from t_s where t_s.k = $1 $$;
create function pg_temp.hid(k text) returns text language sql as $$ select r ->> 'hack_id' from t_s where t_s.k = $1 $$;
create function pg_temp.hash(k text) returns text language sql as $$ select r ->> 'hash' from t_s where t_s.k = $1 $$;
select is((select count(*)::int from app.submissions), 22, 'fixtures: twenty-two frozen submissions, each of its own hack');

-- review a submission to "ready to publish" as staff n (assessment, every claim cleared, PUBLISH decision); returns the decision id
create function pg_temp.ready(n integer, k text, p_risk text default 'low') returns text language plpgsql as $$
declare sid uuid := pg_temp.sid(k)::uuid; h text := pg_temp.hash(k); c integer; i integer; d jsonb;
begin
  perform pg_temp.as_staff(n);
  perform api.start_review(sid, h);
  perform api.record_risk_assessment(sid, h, p_risk, 'Rationale that is long enough.');
  select count(*) into c from app.source_claims where version_id = pg_temp.vid(k)::uuid;
  for i in 1..c loop
    perform api.record_rights_review(sid, h, i, 'clear', 'source_page_checked', 'Evidence that is long enough.', null);
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

-- ===================================================================================================================
-- A. direct JWT calls: the three staff functions are guarded like every other staff function
-- ===================================================================================================================
create temp table t_calls as select * from (values
  ('publish_version', 'select api.publish_version(''99999999-9999-4999-8999-999999999999'', repeat(''0'', 64), ''99999999-9999-4999-8999-999999999998'', ''a-slug'')::text'),
  ('withdraw_publication', 'select api.withdraw_publication(''99999999-9999-4999-8999-999999999999'', ''other'', null)::text'),
  ('get_publication', 'select api.get_publication(''99999999-9999-4999-8999-999999999999'')::text')) v(fn, sql);
grant all on t_calls to public;
create function pg_temp.guard_failures(p_role text, p_expect text) returns text language sql as $$
  select coalesce(string_agg(fn || ' -> ' || split_part(pg_temp.err(p_role, sql), '|', 1) || ':' || split_part(pg_temp.err(p_role, sql), '|', 2), E'\n' order by fn), '')
    from t_calls where pg_temp.err(p_role, sql) not like p_expect $$;
select pg_temp.set_claims('anon', null, null, null, null);
select is(pg_temp.guard_failures('anon', '42501|%'), '', 'anon: EXECUTE denied on all three');
select pg_temp.set_claims('service_role', null, null, null, null);
select is(pg_temp.guard_failures('service_role', '42501|%'), '', 'service_role: EXECUTE denied on all three');
select set_config('request.jwt.claims', '', true);
select is(pg_temp.guard_failures('authenticated', '28000|not_authenticated|%'), '', 'no verified claims: all three refuse (not_authenticated)');
delete from auth.sessions where id = pg_temp.s(7);
select pg_temp.set_claims('authenticated', pg_temp.u(7), pg_temp.s(7), 'aal2', pg_temp.amr(interval '30 seconds'));
select is(pg_temp.guard_failures('authenticated', '28000|session_invalid|%'), '', 'a signed-out session with aal2 claims: all three refuse (session_invalid)');
insert into auth.sessions (id, user_id) values (pg_temp.s(7), pg_temp.u(7));
select pg_temp.as_member(2);
select is(pg_temp.guard_failures('authenticated', '42501|not_staff|%'), '', 'a member who is not staff: all three refuse (not_staff)');
select pg_temp.as_member(3);
select is(pg_temp.guard_failures('authenticated', '42501|mfa_required|%'), '', 'staff with an aal1 session: all three refuse (mfa_required)');
select pg_temp.as_staff(3, interval '16 minutes');
select is(pg_temp.guard_failures('authenticated', '42501|mfa_stale|%'), '', 'MFA 16 minutes old: all three refuse (mfa_stale)');
select pg_temp.as_staff(3, interval '-1 second');
select is(pg_temp.guard_failures('authenticated', '42501|mfa_stale|%'), '', 'MFA timestamp in the future: refused (mfa_stale)');
select pg_temp.as_staff(3, interval '14 minutes');
select is((select string_agg(distinct split_part(pg_temp.err('authenticated', sql), '|', 2), ',') from t_calls), 'not_found', 'MFA 14 minutes old passes the guard (dummy ids give not_found)');
select pg_temp.owner_run(format($$update app.staff_assignments set revoked_at = now(), revoked_by = 'test' where user_id = %L and revoked_at is null$$, pg_temp.u(5)));
select pg_temp.as_staff(5);
select is(pg_temp.guard_failures('authenticated', '42501|not_staff|%'), '', 'staff role removed: the SAME valid session and fresh-MFA token is refused by all three (not_staff)');
select pg_temp.owner_run(format($$insert into app.staff_assignments (user_id, role, granted_by) values (%L, 'reviewer', 'fixture')$$, pg_temp.u(5)));
select pg_temp.as_staff(3);
select is((select coalesce(string_agg(f, ', '), '') from unnest(array[
    'app_review.snapshot_text(null, null, null, null, null, null, null, null, null, null)', 'app_review.effective_rights(''99999999-9999-4999-8999-999999999999'')',
    'app_review.publication_blockers(''99999999-9999-4999-8999-999999999999'', ''99999999-9999-4999-8999-999999999999'')']) f
    where pg_temp.err('authenticated', 'select ' || f || '::text') not like '42501|%'), '', 'staff cannot call the internal publication functions directly');
select is(pg_temp.err('authenticated', 'select count(*) from app.publications'), '42501|permission denied for schema app|', 'staff have no direct table access');

-- ===================================================================================================================
-- B. nobody but the owner touches the publication tables; the worker has no privilege
-- ===================================================================================================================
select is(
  (select coalesce(string_agg(r.role_name || ' ' || t.tbl || ' ' || o.op, E'\n'), '') from (values ('authenticated'), ('anon'), ('service_role')) r(role_name)
     cross join (values ('publications'), ('publication_rights'), ('publication_withdrawals')) t(tbl)
     cross join (values ('select 1 from app.%s limit 1'), ('insert into app.%s default values'), ('update app.%s set cause = null'), ('delete from app.%s'), ('truncate app.%s')) o(op)
    where pg_temp.err(r.role_name, format(o.op, t.tbl)) not like '42501|%'),
  '', 'authenticated, anon and service_role are denied SELECT/INSERT/UPDATE/DELETE/TRUNCATE on all three publication tables');
select is(pg_temp.err('authenticated', 'update app.hacks set current_publication_id = null'), '42501|permission denied for schema app|', 'members cannot move the pointer');
select is(pg_temp.err('service_role', 'update app.hacks set current_publication_id = null'), '42501|permission denied for schema app|', 'service_role cannot move the pointer');
select is((select count(*)::int from (select has_table_privilege('hackass_worker', c.oid, p.priv) h from pg_class c cross join (values ('select'), ('insert'), ('update'), ('delete')) p(priv)
            where c.oid in ('app.publications'::regclass, 'app.publication_rights'::regclass, 'app.publication_withdrawals'::regclass, 'app.hacks'::regclass)) x where h), 0, 'the worker role holds no privilege on the publication tables or hacks');
select is((select count(*)::int from information_schema.routine_privileges where grantee in ('hackass_worker', 'PUBLIC', 'anon', 'service_role') and routine_schema in ('api', 'app_review') and routine_name in ('publish_version', 'withdraw_publication', 'get_publication')), 0, 'and no EXECUTE on the publication functions');

-- ===================================================================================================================
-- C. the happy path: review, publish, snapshot
-- ===================================================================================================================
insert into t_dec values ('a', pg_temp.ready(3, 'a'));
select is(pg_temp.state('a'), 'approved', 'a reviewed submission is approved');
select is(pg_temp.cur('a'), 'none', 'and nothing is published yet');
-- before publishing: wrong hash / bad slug / member
select pg_temp.as_staff(3);
select pg_temp.lk(pg_temp.err('authenticated', pg_temp.pubsql('a', (select d from t_dec where k = 'a'), 'tip-a', repeat('a', 64))), 'PT409|hash_mismatch|%', 'a wrong content hash cannot publish (hash_mismatch)');
select pg_temp.lk(pg_temp.err('authenticated', pg_temp.pubsql('a', (select d from t_dec where k = 'a'), 'tip-a', 'NOT-HEX')), 'PT422|invalid_content|expected_hash', 'a malformed hash is refused');
select pg_temp.lk(pg_temp.err('authenticated', pg_temp.pubsql('a', null, 'tip-a')), 'PT422|invalid_content|p_expected_decision_id', 'the decision must be named');
select pg_temp.lk(pg_temp.err('authenticated', pg_temp.pubsql('a', null, null)), 'PT422|invalid_content|p_expected_decision_id', 'also with no slug');
select pg_temp.lk(pg_temp.err('authenticated', pg_temp.pubsql('a', (select d from t_dec where k = 'a'), null)), 'PT422|invalid_content|p_slug', 'the first publication of a hack needs a slug');
select pg_temp.lk(pg_temp.err('authenticated', pg_temp.pubsql('a', (select d from t_dec where k = 'a'), 'Not A Slug')), 'PT422|invalid_content|p_slug', 'a malformed slug is refused');
select pg_temp.lk(pg_temp.err('authenticated', pg_temp.pubsql('a', '00000000-0000-4000-8000-0000000000aa', 'tip-a')), 'PT409|decision_conflict|%', 'naming a decision that is not the latest is a conflict');
select is(pg_temp.cur('a'), 'none', 'none of those published anything');
select pg_temp.publish(3, 'a', 'tip-a');
select is(pg_temp.cur('a'), pg_temp.pid('a'), 'publishing sets hacks.current_publication_id to the new publication');
select is(pg_temp.q(format($$select slug from app.hacks where id = %L$$, pg_temp.hid('a'))), 'tip-a', 'and assigns the slug');
select is(pg_temp.state('a'), 'approved', 'the version stays approved (publication is the pointer, not a lifecycle state)');
select is((select r ->> 'superseded_publication_id' from t_pub where k = 'a'), null, 'nothing was superseded');
select is(pg_temp.q(format($$select (p.hack_id = %L and p.version_id = %L and p.submission_id = %L and p.content_hash = s.content_hash and p.canon_version = 1 and p.decision_id = %L
                                   and p.published_by = %L and p.publisher_role = 'reviewer' and p.snapshot_format = 'HACKASS-PUB-1')::text
                               from app.publications p join app.submissions s on s.id = p.submission_id where p.id = %L$$,
              pg_temp.hid('a'), pg_temp.vid('a'), pg_temp.sid('a'), (select d from t_dec where k = 'a'), pg_temp.u(3), pg_temp.pid('a'))), 'true', 'the record names the hack, version, submission, frozen hash, decision and publisher');
select is(pg_temp.q(format($$select (p.assessment_id = (select id from app.version_assessments where submission_id = p.submission_id order by seq desc limit 1))::text from app.publications p where p.id = %L$$, pg_temp.pid('a'))), 'true', 'and the current risk assessment');
select is(pg_temp.q(format($$select count(*)::text from app.publication_rights pr join app.rights_reviews rr on rr.id = pr.rights_review_id
                              where pr.publication_id = %L and rr.status = 'clear' and pr.claim_hash = rr.claim_hash and pr.evidence_note_hash = sha256(convert_to(rr.evidence_note, 'UTF8'))$$, pg_temp.pid('a'))), '1', 'the rights-review ids with their claim and evidence-note hashes are listed (1 claim)');
-- the snapshot text, rebuilt here by an independent formula (the documented HACKASS-PUB-1 format), equals the stored text; its hash is SHA-256 of its UTF-8 bytes
select is(pg_temp.q(format($q$
  with p as (select * from app.publications where id = %L),
       d as (select * from app.moderation_decisions where id = (select decision_id from p)),
       a as (select * from app.version_assessments where id = (select assessment_id from p)),
       r as (select * from app.rights_reviews where id = (select rights_review_id from app.publication_rights where publication_id = (select id from p) and claim_no = 1)),
       f as (select 'x' as x)
  select (p.snapshot_text =
     'HACKASS-PUB-1' || E'\n'
     || 'target;' || octet_length(p.hack_id::text) || ':' || p.hack_id || ';' || octet_length(p.version_id::text) || ':' || p.version_id || ';' || octet_length(p.submission_id::text) || ':' || p.submission_id
        || ';64:' || encode(p.content_hash, 'hex') || ';1:1' || E'\n'
     || 'decision;' || octet_length(d.id::text) || ':' || d.id || ';' || octet_length(d.seq::text) || ':' || d.seq || ';7:PUBLISH;' || octet_length(d.actor_id::text) || ':' || d.actor_id || E'\n'
     || 'assessment;' || octet_length(a.id::text) || ':' || a.id || ';' || octet_length(a.seq::text) || ':' || a.seq || ';' || octet_length(a.risk_class) || ':' || a.risk_class || E'\n'
     || 'publisher;' || octet_length(p.published_by::text) || ':' || p.published_by || ';' || octet_length(p.publisher_role) || ':' || p.publisher_role || E'\n'
     || 'rights;1;' || octet_length(r.id::text) || ':' || r.id || ';' || octet_length(r.seq::text) || ':' || r.seq || ';64:' || encode(r.claim_hash, 'hex') || ';5:clear;'
        || octet_length(r.basis_code) || ':' || r.basis_code || ';-:;64:' || encode(sha256(convert_to(r.evidence_note, 'UTF8')), 'hex') || E'\n')::text
  from p, d, a, r$q$, pg_temp.pid('a'))), 'true', 'the stored snapshot equals the documented HACKASS-PUB-1 text, rebuilt independently');
select is(pg_temp.q(format($$select (snapshot_hash = sha256(convert_to(snapshot_text, 'UTF8')))::text from app.publications where id = %L$$, pg_temp.pid('a'))), 'true', 'and snapshot_hash is the SHA-256 of its UTF-8 bytes');
select is(api.get_publication(pg_temp.pid('a')::uuid) ->> 'is_current', 'true', 'get_publication reports it current');
select is(api.get_publication(pg_temp.pid('a')::uuid) -> 'withdrawal', 'null'::jsonb, 'with no withdrawal');
select is(api.get_publication(pg_temp.pid('a')::uuid) ->> 'snapshot_text', (select snapshot_text from app.publications where id = pg_temp.pid('a')::uuid), 'and serves the stored snapshot');
select pg_temp.lk(pg_temp.err('authenticated', pg_temp.pubsql('a', (select d from t_dec where k = 'a'), 'tip-a')), 'PT409|invalid_state|decision_already_published', 'publishing the same decision again is refused');
-- the pointer move is the only effect of a refused call: still exactly one publication
select is((select count(*)::int from app.publications where hack_id = pg_temp.hid('a')::uuid), 1, 'still exactly one publication for the hack');

-- ===================================================================================================================
-- D. everything that must NOT publish
-- ===================================================================================================================
-- not yet approved
select pg_temp.as_staff(3);
select pg_temp.lk(pg_temp.err('authenticated', pg_temp.pubsql('solo', '00000000-0000-4000-8000-0000000000aa', 'solo-slug')), 'PT409|invalid_state|submitted', 'a submission that was never reviewed cannot publish (invalid_state)');
-- stale / superseded decisions
insert into t_dec values ('stale', pg_temp.ready(3, 'stale'));
select pg_temp.as_staff(3);
create temp table t_stale as select api.record_decision(pg_temp.sid('stale')::uuid, pg_temp.hash('stale'), 'HOLD', array['needs_evidence'], null, (select d::uuid from t_dec where k = 'stale')) as r;
grant all on t_stale to public;
select pg_temp.lk(pg_temp.err('authenticated', pg_temp.pubsql('stale', (select d from t_dec where k = 'stale'), 'stale-slug')), 'PT409|invalid_state|under_review', 'after a HOLD the old PUBLISH decision cannot publish (the version is back under review)');
create temp table t_stale2 as select api.record_decision(pg_temp.sid('stale')::uuid, pg_temp.hash('stale'), 'PUBLISH', null, null, (select (r ->> 'decision_id')::uuid from t_stale)) as r;
grant all on t_stale2 to public;
select pg_temp.lk(pg_temp.err('authenticated', pg_temp.pubsql('stale', (select d from t_dec where k = 'stale'), 'stale-slug')), 'PT409|decision_conflict|%', 'a superseded PUBLISH decision cannot publish even though a newer PUBLISH exists (decision_conflict)');
select pg_temp.lk(pg_temp.err('authenticated', pg_temp.pubsql('stale', (select r ->> 'decision_id' from t_stale), 'stale-slug')), 'PT409|decision_conflict|%', 'nor can the HOLD that came between');
select is(pg_temp.cur('stale'), 'none', 'nothing was published by the refused calls');
insert into t_dec values ('stale2', (select r ->> 'decision_id' from t_stale2));
select is((select (pg_temp.err('authenticated', format('select api.publish_version(%L, %L, %L, %L)::text', pg_temp.sid('stale'), pg_temp.hash('stale'), (select d from t_dec where k = 'stale2'), 'stale-slug')) like 'OK:%')::text), 'true', 'the latest PUBLISH decision publishes');
-- tampered content
insert into t_dec values ('tamper', pg_temp.ready(3, 'tamper'));
select pg_temp.owner_run('alter table app.hack_steps disable trigger hack_steps_guard');
select pg_temp.owner_run(format($$update app.hack_steps set body = 'Tampered step.' where version_id = %L$$, pg_temp.vid('tamper')));
select pg_temp.owner_run('alter table app.hack_steps enable trigger hack_steps_guard');
select pg_temp.as_staff(3);
select pg_temp.lk(pg_temp.err('authenticated', pg_temp.pubsql('tamper', (select d from t_dec where k = 'tamper'), 'tamper-slug')), 'PT409|hash_mismatch|%', 'content that no longer hashes to the frozen hash cannot publish (hash_mismatch)');
select is(pg_temp.cur('tamper'), 'none', 'and nothing is current');
-- expired rights (recorded as the owner with yesterday''s date: the RPC refuses such dates)
insert into t_dec values ('exp', pg_temp.ready(3, 'exp'));
select pg_temp.owner_run(format($$insert into app.rights_reviews (submission_id, version_id, content_hash, canon_version, claim_no, status, basis_code, evidence_note, expires_on, reviewer_id) select id, version_id, content_hash, canon_version, 1, 'clear', 'staff_original_check', 'An already expired clearance.', current_date - 1, %L from app.submissions where id = %L$$, pg_temp.u(3), pg_temp.sid('exp')));
select pg_temp.as_staff(3);
select is(pg_temp.err('authenticated', pg_temp.pubsql('exp', (select d from t_dec where k = 'exp'), 'exp-slug')), 'PT409|approval_blocked|rights_not_clear:1', 'expired rights cannot publish (rights_not_clear:1)');
-- revoked rights
insert into t_dec values ('rvk', pg_temp.ready(3, 'rvk'));
select pg_temp.as_staff(3);
select api.record_rights_review(pg_temp.sid('rvk')::uuid, pg_temp.hash('rvk'), 1, 'revoked', null, null, null);
select is(pg_temp.err('authenticated', pg_temp.pubsql('rvk', (select d from t_dec where k = 'rvk'), 'rvk-slug')), 'PT409|approval_blocked|rights_not_clear:1', 'revoked rights cannot publish (rights_not_clear:1)');
-- unresolved references: no PUBLISH decision can exist for them, so one is forced in as the owner with the guard disabled
select pg_temp.as_staff(3);
select api.start_review(pg_temp.sid('refs')::uuid, pg_temp.hash('refs'));
select api.record_risk_assessment(pg_temp.sid('refs')::uuid, pg_temp.hash('refs'), 'low', 'Rationale that is long enough.');
select api.record_rights_review(pg_temp.sid('refs')::uuid, pg_temp.hash('refs'), 1, 'clear', 'staff_original_check', 'Evidence that is long enough.', null);
select pg_temp.lk(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''PUBLISH'', null, null, null)::text', pg_temp.sid('refs'), pg_temp.hash('refs'))), 'PT409|approval_blocked|unresolved_references:asset_id,unresolved_references:profile_id', 'the decision itself is already blocked for unresolved references');
select pg_temp.owner_run('alter table app.moderation_decisions disable trigger decisions_guard');
select pg_temp.owner_run(format($$insert into app.moderation_decisions (submission_id, version_id, content_hash, canon_version, seq, decision, actor_id) select id, version_id, content_hash, canon_version, 1, 'PUBLISH', %L from app.submissions where id = %L$$, pg_temp.u(3), pg_temp.sid('refs')));
select pg_temp.owner_run('alter table app.moderation_decisions enable trigger decisions_guard');
select pg_temp.owner_run(format($$update app.version_lifecycle set state = 'approved' where version_id = %L$$, pg_temp.vid('refs')));
insert into t_dec values ('refs', pg_temp.q(format($$select id::text from app.moderation_decisions where submission_id = %L$$, pg_temp.sid('refs'))));
select pg_temp.as_staff(3);
select is(pg_temp.err('authenticated', pg_temp.pubsql('refs', (select d from t_dec where k = 'refs'), 'refs-slug')), 'PT409|approval_blocked|unresolved_references:asset_id,unresolved_references:profile_id', 'even with a forced PUBLISH decision, unresolved references cannot publish');
-- self approval
insert into t_dec values ('own6', pg_temp.ready(3, 'own6'));
select pg_temp.as_staff(6);
select is(pg_temp.err('authenticated', pg_temp.pubsql('own6', (select d from t_dec where k = 'own6'), 'own6-slug')), '42501|self_review|', 'the submitter (a staff member) cannot publish their own work (self_review)');
select is(pg_temp.cur('own6'), 'none', 'and it is not current');
select pg_temp.as_staff(1);
select is(pg_temp.err('authenticated', pg_temp.pubsql('own6', (select d from t_dec where k = 'own6'), 'own6-slug')), '42501|not_staff|', 'the same author as an ordinary member: not_staff');
-- the approving decision itself was made by the submitter (forced in as the owner with the guard disabled): publication refuses it again
select pg_temp.as_staff(3);
select api.start_review(pg_temp.sid('own6b')::uuid, pg_temp.hash('own6b'));
select api.record_risk_assessment(pg_temp.sid('own6b')::uuid, pg_temp.hash('own6b'), 'low', 'Rationale that is long enough.');
select api.record_rights_review(pg_temp.sid('own6b')::uuid, pg_temp.hash('own6b'), 1, 'clear', 'staff_original_check', 'Evidence that is long enough.', null);
select pg_temp.owner_run('alter table app.moderation_decisions disable trigger decisions_guard');
select pg_temp.owner_run(format($$insert into app.moderation_decisions (submission_id, version_id, content_hash, canon_version, seq, decision, actor_id) select id, version_id, content_hash, canon_version, 1, 'PUBLISH', %L from app.submissions where id = %L$$, pg_temp.u(6), pg_temp.sid('own6b')));
select pg_temp.owner_run('alter table app.moderation_decisions enable trigger decisions_guard');
select pg_temp.owner_run(format($$update app.version_lifecycle set state = 'approved' where version_id = %L$$, pg_temp.vid('own6b')));
insert into t_dec values ('own6b', pg_temp.q(format($$select id::text from app.moderation_decisions where submission_id = %L$$, pg_temp.sid('own6b'))));
select pg_temp.as_staff(3);
select is(pg_temp.err('authenticated', pg_temp.pubsql('own6b', (select d from t_dec where k = 'own6b'), 'own6b-slug')), 'PT409|approval_blocked|decision_self_review', 'a PUBLISH decision made by the submitter cannot be published even by another staff member (decision_self_review)');
-- insufficient authority: high risk needs an admin
insert into t_dec values ('hi', pg_temp.ready(4, 'hi', 'high'));
select pg_temp.as_staff(3);
select is(pg_temp.err('authenticated', pg_temp.pubsql('hi', (select d from t_dec where k = 'hi'), 'hi-slug')), 'PT409|approval_blocked|risk_high_needs_admin', 'a reviewer cannot publish a high-risk version (risk_high_needs_admin)');
select is(pg_temp.cur('hi'), 'none', 'it stays unpublished');
select pg_temp.publish(4, 'hi', 'hi-slug');
select is(pg_temp.q(format($$select publisher_role from app.publications where id = %L$$, pg_temp.pid('hi'))), 'admin', 'an admin publishes it, and the record says admin');
-- slug rules
insert into t_dec values ('two', pg_temp.ready(3, 'two'));
select pg_temp.as_staff(3);
select is(pg_temp.err('authenticated', pg_temp.pubsql('two', (select d from t_dec where k = 'two'), 'tip-a')), 'PT409|slug_taken|', 'a slug already used by another hack is refused (slug_taken)');
select is(pg_temp.cur('two'), 'none', 'and the failed publish left nothing behind');
select pg_temp.publish(3, 'two', 'two-claims');
select is((select count(*)::int from app.publication_rights where publication_id = pg_temp.pid('two')::uuid), 2, 'a two-claim version lists both rights reviews');
select is(pg_temp.q(format($$select count(*)::text from app.publication_rights pr join app.rights_reviews rr on rr.id = pr.rights_review_id where pr.publication_id = %L and rr.status = 'clear'$$, pg_temp.pid('two'))), '2', 'both clear');

-- ===================================================================================================================
-- E. the database itself refuses wrong-hack links
-- ===================================================================================================================
insert into t_dec values ('fk', pg_temp.ready(3, 'fk'));
select is(pg_temp.owner_do(format($$update app.hacks set current_publication_id = %L where id = %L$$, pg_temp.pid('a'), pg_temp.hid('fk'))), '23503|insert or update on table "hacks" violates foreign key constraint "hacks_current_publication_of_hack"', 'pointing a hack at ANOTHER hack''s publication fails at the database (composite foreign key)');
select is(pg_temp.cur('fk'), 'none', 'and the pointer is untouched');
create function pg_temp.insert_pub(p_hack uuid, p_version uuid, p_sub uuid, p_hash bytea, p_dec uuid, p_ass uuid, p_by uuid) returns text language plpgsql as $$
declare t text;
begin
  t := pg_temp.owner_val(format($f$select app_review.snapshot_text(%L, %L, %L, %L::bytea, 1::smallint, %L, %L, %L, 'reviewer', app_review.effective_rights(%L))$f$, p_hack, p_version, p_sub, p_hash, p_dec, p_ass, p_by, p_sub));
  return pg_temp.owner_do(format($f$insert into app.publications (hack_id, version_id, submission_id, content_hash, canon_version, decision_id, assessment_id, published_by, publisher_role, snapshot_format, snapshot_text, snapshot_hash)
    values (%L, %L, %L, %L::bytea, 1, %L, %L, %L, 'reviewer', 'HACKASS-PUB-1', %L, sha256(convert_to(%L, 'UTF8')))$f$, p_hack, p_version, p_sub, p_hash, p_dec, p_ass, p_by, t, t));
end $$;
create function pg_temp.fkparts(k text) returns table (h uuid, v uuid, s uuid, ch bytea, d uuid, a uuid) language sql as $$
  select s.hack_id, s.version_id, s.id, s.content_hash, (select id from app.moderation_decisions where submission_id = s.id order by seq desc limit 1),
         (select id from app.version_assessments where submission_id = s.id order by seq desc limit 1) from app.submissions s where s.id = pg_temp.sid($1)::uuid $$;
-- version of one hack under another hack's id
select pg_temp.lk((select pg_temp.insert_pub(pg_temp.hid('hi')::uuid, f.v, f.s, f.ch, f.d, f.a, pg_temp.u(3)) from pg_temp.fkparts('fk') f), '23503|insert or update on table "publications" violates foreign key constraint "publications_version_of_hack"', 'a publication whose version belongs to a different hack fails at the database');
-- a hash that is not the submission's frozen hash (FK on the binding)
select pg_temp.lk((select pg_temp.insert_pub(f.h, f.v, f.s, decode(repeat('00', 32), 'hex'), f.d, f.a, pg_temp.u(3)) from pg_temp.fkparts('fk') f), '23503|insert or update on table "publications" violates foreign key constraint "publications_bound_to_submission"', 'a publication quoting another hash fails at the database (binding foreign key)');
-- the decision / assessment of another submission (the trigger and the keys both refuse; the trigger answers first)
select pg_temp.lk((select pg_temp.insert_pub(f.h, f.v, f.s, f.ch, (select id from app.moderation_decisions where submission_id = pg_temp.sid('hi')::uuid limit 1), f.a, pg_temp.u(3)) from pg_temp.fkparts('fk') f), 'PT409|decision_conflict', 'a decision of another submission is refused');
select pg_temp.lk((select pg_temp.insert_pub(f.h, f.v, f.s, f.ch, f.d, (select id from app.version_assessments where submission_id = pg_temp.sid('hi')::uuid limit 1), pg_temp.u(3)) from pg_temp.fkparts('fk') f), 'PT409|approval_blocked', 'an assessment of another submission is refused');
-- the three keys themselves, with the triggers out of the way (pending commit-time checks are flushed first)
set constraints all immediate;
set constraints all deferred;
select pg_temp.owner_run('alter table app.publications disable trigger publications_guard');
select pg_temp.owner_run('alter table app.publications disable trigger publications_children_check');
select pg_temp.lk((select pg_temp.insert_pub(f.h, f.v, f.s, f.ch, (select id from app.moderation_decisions where submission_id = pg_temp.sid('rvk')::uuid limit 1), f.a, pg_temp.u(3)) from pg_temp.fkparts('fk') f), '23503|insert or update on table "publications" violates foreign key constraint "publications_decision"', 'key: a decision of another submission');
select pg_temp.lk((select pg_temp.insert_pub(f.h, f.v, f.s, f.ch, f.d, (select id from app.version_assessments where submission_id = pg_temp.sid('hi')::uuid limit 1), pg_temp.u(3)) from pg_temp.fkparts('fk') f), '23503|insert or update on table "publications" violates foreign key constraint "publications_assessment"', 'key: an assessment of another submission');
select pg_temp.lk((select pg_temp.insert_pub(f.h, f.v, f.s, f.ch, f.d, f.a, pg_temp.u(3)) from pg_temp.fkparts('a') f), '23505|duplicate key value violates unique constraint "publications_one_per_decision"', 'key: a PUBLISH decision authorizes at most one publication');
select is(pg_temp.owner_do(format($$insert into app.publication_rights (publication_id, submission_id, claim_no, rights_review_id, claim_hash, evidence_note_hash) select %L, p.submission_id, 3, rr.id, rr.claim_hash, rr.claim_hash from app.publications p, app.rights_reviews rr where p.id = %L and rr.submission_id = p.submission_id and rr.claim_no = 1 limit 1$$, pg_temp.pid('a'), pg_temp.pid('a'))), '23503|insert or update on table "publication_rights" violates foreign key constraint "publication_rights_review"', 'key: a rights row naming a different claim than the review it cites');
select is(pg_temp.owner_do(format($$insert into app.publication_rights (publication_id, submission_id, claim_no, rights_review_id, claim_hash, evidence_note_hash) select %L, p.submission_id, 3, (select id from app.rights_reviews where submission_id = %L limit 1), decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex') from app.publications p where p.id = %L$$, pg_temp.pid('a'), pg_temp.sid('hi'), pg_temp.pid('a'))), '23503|insert or update on table "publication_rights" violates foreign key constraint "publication_rights_review"', 'key: a rights review of another submission');
select pg_temp.owner_run('alter table app.publications enable trigger publications_guard');
select pg_temp.owner_run('alter table app.publications enable trigger publications_children_check');
-- the guard itself (direct insert of an ineligible publication)
create temp table t_fk as select * from pg_temp.fkparts('fk');
grant all on t_fk to public;
select pg_temp.owner_run(format($$update app.version_lifecycle set state = 'under_review' where version_id = %L$$, pg_temp.vid('fk')));
select pg_temp.lk((select pg_temp.insert_pub(f.h, f.v, f.s, f.ch, f.d, f.a, pg_temp.u(3)) from t_fk f), 'PT409|invalid_state', 'the insert guard refuses a version that is not approved');
select pg_temp.owner_run(format($$update app.version_lifecycle set state = 'approved' where version_id = %L$$, pg_temp.vid('fk')));
select pg_temp.lk((select pg_temp.insert_pub(f.h, f.v, f.s, f.ch, f.d, f.a, pg_temp.u(2)) from t_fk f), '42501|not_staff', 'and a publisher who is not staff');
select pg_temp.lk((select pg_temp.insert_pub(f.h, f.v, f.s, f.ch, f.d, f.a, pg_temp.u(3)) from pg_temp.fkparts('rvk') f), 'PT409|approval_blocked', 'and the insert guard repeats the eligibility rules itself (revoked rights, inserted directly)');
select is(pg_temp.owner_val(format($$select count(*)::text from app.publications where submission_id = %L$$, pg_temp.sid('rvk'))), '0', 'and nothing was inserted');

-- snapshot text must be the canonical text; the children must be complete
select is(pg_temp.owner_do(format($f$insert into app.publications (hack_id, version_id, submission_id, content_hash, canon_version, decision_id, assessment_id, published_by, publisher_role, snapshot_format, snapshot_text, snapshot_hash)
    select h, v, s, ch, 1, d, a, %L, 'reviewer', 'HACKASS-PUB-1', 'forged', sha256(convert_to('forged', 'UTF8')) from t_fk$f$, pg_temp.u(3))), 'PT409|snapshot_mismatch', 'a forged snapshot text is refused by the insert guard');
select is(pg_temp.owner_do(format($f$set constraints all immediate; insert into app.publications (hack_id, version_id, submission_id, content_hash, canon_version, decision_id, assessment_id, published_by, publisher_role, snapshot_format, snapshot_text, snapshot_hash)
    select h, v, s, ch, 1, d, a, %L, 'reviewer', 'HACKASS-PUB-1', app_review.snapshot_text(h, v, s, ch, 1::smallint, d, a, %L, 'reviewer', app_review.effective_rights(s)),
           sha256(convert_to(app_review.snapshot_text(h, v, s, ch, 1::smallint, d, a, %L, 'reviewer', app_review.effective_rights(s)), 'UTF8')) from t_fk$f$, pg_temp.u(3), pg_temp.u(3), pg_temp.u(3))), 'PT409|snapshot_mismatch', 'a publication without its rights rows cannot commit (checked at commit; immediate here)');
set constraints all deferred;
select is((select count(*)::int from app.publications where hack_id = pg_temp.hid('fk')::uuid), 0, 'no publication of that hack exists after the refused inserts');
-- pointer rules
select is(pg_temp.owner_do(format($$update app.hacks set current_publication_id = null where id = %L$$, pg_temp.hid('hi'))), 'PT409|withdrawal_required', 'the pointer cannot be cleared without a withdrawal record');
select is(pg_temp.owner_do(format($$update app.hacks set current_publication_id = %L where id = %L$$, pg_temp.pid('two'), pg_temp.hid('two'))), 'ok', 'control: setting the pointer to its own value is a no-op');
select is(pg_temp.owner_do(format($$update app.hacks set slug = 'changed' where id = %L$$, pg_temp.hid('hi'))), 'PT409|slug_immutable', 'a slug cannot be changed once set');
select is(pg_temp.owner_do(format($$update app.hacks set created_by = %L where id = %L$$, pg_temp.u(2), pg_temp.hid('hi'))), 'PT409|identity_immutable', 'a hack''s identity is immutable');
set constraints all deferred;
select is(pg_temp.owner_do(format($f$set constraints all immediate; insert into app.publication_withdrawals (publication_id, cause, reason_code, withdrawn_by) values (%L, 'staff', 'other', %L)$f$, pg_temp.pid('hi'), pg_temp.u(3))), 'PT409|withdrawal_incomplete', 'a withdrawal that leaves the pointer set cannot commit');
set constraints all deferred;
-- immutability
select is(pg_temp.owner_do(format($$update app.publications set decision_id = decision_id where id = %L$$, pg_temp.pid('a'))), 'PT409|record_immutable', 'a publication cannot be updated');
select is(pg_temp.owner_do(format($$delete from app.publications where id = %L$$, pg_temp.pid('a'))), 'PT409|record_immutable', 'or deleted');
select is(pg_temp.owner_do('truncate app.publications'), '0A000|cannot truncate a table referenced in a foreign key constraint', 'or truncated (refused: other tables reference it)');
select is(pg_temp.owner_do(format($$update app.publication_rights set claim_no = 1 where publication_id = %L$$, pg_temp.pid('a'))), 'PT409|record_immutable', 'its rights rows cannot be updated');
select is(pg_temp.owner_do(format($$delete from app.publication_rights where publication_id = %L$$, pg_temp.pid('a'))), 'PT409|record_immutable', 'or deleted');
select is(pg_temp.owner_do('truncate app.publication_rights'), 'PT409|truncate_forbidden', 'or truncated');
select is(pg_temp.owner_do('truncate app.publication_withdrawals'), 'PT409|truncate_forbidden', 'withdrawals cannot be truncated');

-- ===================================================================================================================
-- F. later review work withdraws an ineligible publication in the same transaction
-- ===================================================================================================================
create function pg_temp.wd(k text) returns text language sql as $$
  select pg_temp.q(format($q$select cause || '|' || coalesce(trigger_table, '-') || '|' || array_to_string(blockers, ',') from app.publication_withdrawals where publication_id = %L$q$, pg_temp.pid($1))) $$;
-- rejection
insert into t_dec values ('rej', pg_temp.ready(3, 'rej'));
select pg_temp.publish(3, 'rej', 'rej-slug');
select pg_temp.as_staff(5);
select api.record_decision(pg_temp.sid('rej')::uuid, pg_temp.hash('rej'), 'REJECT', array['quality'], 'Second look found problems.', (select d::uuid from t_dec where k = 'rej'));
select is(pg_temp.cur('rej'), 'none', 'a later REJECT clears the pointer');
select is(pg_temp.wd('rej'), 'review_change|moderation_decisions|decision_not_publish', 'and records why (review_change, the decision table, decision_not_publish)');
select is(pg_temp.state('rej'), 'rejected', 'the lifecycle ends rejected');
select is(pg_temp.q(format($$select count(*)::text from app.publications where id = %L$$, pg_temp.pid('rej'))), '1', 'the publication record is still there');
-- HOLD, then re-approve and publish again with the new decision
insert into t_dec values ('hold', pg_temp.ready(3, 'hold'));
select pg_temp.publish(3, 'hold', 'hold-slug');
select pg_temp.as_staff(5);
create temp table t_h as select api.record_decision(pg_temp.sid('hold')::uuid, pg_temp.hash('hold'), 'HOLD', array['needs_evidence'], null, (select d::uuid from t_dec where k = 'hold')) as r;
grant all on t_h to public;
select is(pg_temp.cur('hold'), 'none', 'a later HOLD clears the pointer');
select is(pg_temp.wd('hold'), 'review_change|moderation_decisions|decision_not_publish', 'recorded the same way');
select is(pg_temp.state('hold'), 'under_review', 'and the version is back under review');
select api.record_decision(pg_temp.sid('hold')::uuid, pg_temp.hash('hold'), 'PUBLISH', null, null, (select (r ->> 'decision_id')::uuid from t_h));
select is((select (pg_temp.err('authenticated', pg_temp.pubsql('hold', (select d from t_dec where k = 'hold'), null)) like 'PT409|decision_conflict|%')::text), 'true', 'the old decision still cannot publish');
insert into t_dec select 'hold2', (select id::text from app.moderation_decisions where submission_id = pg_temp.sid('hold')::uuid order by seq desc limit 1);
create temp table t_hold_old as select pg_temp.pid('hold') as p;
grant all on t_hold_old to public;
delete from t_pub where k = 'hold';
select pg_temp.as_staff(3);
insert into t_pub select 'hold', api.publish_version(pg_temp.sid('hold')::uuid, pg_temp.hash('hold'), (select d::uuid from t_dec where k = 'hold2'), null);
select is(pg_temp.cur('hold'), pg_temp.pid('hold'), 'a fresh PUBLISH decision lets the same version be published again');
select isnt(pg_temp.pid('hold'), (select p from t_hold_old), 'as a NEW publication record');
select is(pg_temp.q(format($$select count(*)::text from app.publications where hack_id = %L$$, pg_temp.hid('hold'))), '2', 'the earlier record is kept');
-- rights revoked after publication
insert into t_dec values ('rev', pg_temp.ready(3, 'rev'));
select pg_temp.publish(3, 'rev', 'rev-slug');
select pg_temp.as_staff(5);
select api.record_rights_review(pg_temp.sid('rev')::uuid, pg_temp.hash('rev'), 1, 'revoked', null, null, null);
select is(pg_temp.cur('rev'), 'none', 'rights revoked after publication clear the pointer');
select is(pg_temp.wd('rev'), 'review_change|rights_reviews|rights_not_clear:1', 'with the rights blocker and the rights table named');
select is(pg_temp.state('rev'), 'under_review', 'the version returns to review (it can be fixed and re-approved)');
-- prohibited assessment after publication
insert into t_dec values ('pro', pg_temp.ready(3, 'pro'));
select pg_temp.publish(3, 'pro', 'pro-slug');
select pg_temp.as_staff(5);
select api.record_risk_assessment(pg_temp.sid('pro')::uuid, pg_temp.hash('pro'), 'prohibited', 'On reflection this is not allowed.');
select is(pg_temp.cur('pro'), 'none', 'a prohibited assessment after publication clears the pointer');
select is(pg_temp.wd('pro'), 'review_change|version_assessments|risk_prohibited', 'recorded as risk_prohibited');
-- a high assessment withdraws a publication a reviewer made (a high risk needs an admin's publication)
insert into t_dec values ('highlater', pg_temp.ready(3, 'highlater'));
select pg_temp.publish(3, 'highlater', 'highlater-slug');
select pg_temp.as_staff(5);
select api.record_risk_assessment(pg_temp.sid('highlater')::uuid, pg_temp.hash('highlater'), 'high', 'Reassessed as high risk.');
select is(pg_temp.wd('highlater'), 'review_change|version_assessments|risk_high_needs_admin', 'a high assessment withdraws a reviewer''s publication (risk_high_needs_admin)');
-- harmless later review work leaves it published
insert into t_dec values ('benign', pg_temp.ready(3, 'benign'));
select pg_temp.publish(3, 'benign', 'benign-slug');
select pg_temp.as_staff(5);
select api.record_risk_assessment(pg_temp.sid('benign')::uuid, pg_temp.hash('benign'), 'medium', 'A calmer second assessment.');
select api.record_rights_review(pg_temp.sid('benign')::uuid, pg_temp.hash('benign'), 1, 'clear', 'staff_original_check', 'Checked again, still fine.', current_date + 365);
select api.record_decision(pg_temp.sid('benign')::uuid, pg_temp.hash('benign'), 'PUBLISH', null, 'Re-affirmed.', (select d::uuid from t_dec where k = 'benign'));
select is(pg_temp.cur('benign'), pg_temp.pid('benign'), 'a new medium assessment, a fresh clear review and a re-affirming PUBLISH leave the publication current');
select is(pg_temp.q(format($$select count(*)::text from app.publication_withdrawals where publication_id = %L$$, pg_temp.pid('benign'))), '0', 'with no withdrawal');
-- the snapshot survives all of it
select is(pg_temp.q(format($$select (snapshot_hash = sha256(convert_to(snapshot_text, 'UTF8')) and snapshot_text like '%%decision;%%' )::text from app.publications where id = %L$$, pg_temp.pid('benign'))), 'true', 'the benign publication''s snapshot is unchanged and still hashes correctly');
select is(pg_temp.q(format($$select (decision_id = %L)::text from app.publications where id = %L$$, (select d from t_dec where k = 'benign'), pg_temp.pid('benign'))), 'true', 'and still names the decision it was published under (not the later re-affirmation)');
select is(pg_temp.owner_val(format($q$select (p.snapshot_text = app_review.snapshot_text(p.hack_id, p.version_id, p.submission_id, p.content_hash, p.canon_version, p.decision_id, p.assessment_id, p.published_by, p.publisher_role,
       (select array_agg(rights_review_id order by claim_no) from app.publication_rights where publication_id = p.id)))::text from app.publications p where p.id = %L$q$, pg_temp.pid('benign'))), 'true', 'recomputing the snapshot from its recorded ids still reproduces it exactly, after later reviews changed what is effective');
select is(pg_temp.q(format($$select (snapshot_text like '%%risk%%' or snapshot_text like '%%medium%%')::text from app.publications where id = %L$$, pg_temp.pid('benign'))), 'false', 'while the new medium assessment is not in the old snapshot (it names the assessment it was made under)');

-- the effective rights review is the LATEST one per claim, and the snapshot names that review
select pg_temp.as_staff(3);
select api.start_review(pg_temp.sid('multi')::uuid, pg_temp.hash('multi'));
select api.record_risk_assessment(pg_temp.sid('multi')::uuid, pg_temp.hash('multi'), 'low', 'Rationale that is long enough.');
select api.record_rights_review(pg_temp.sid('multi')::uuid, pg_temp.hash('multi'), 1, 'needs_evidence', null, null, null);
select api.record_rights_review(pg_temp.sid('multi')::uuid, pg_temp.hash('multi'), 1, 'clear', 'source_page_checked', 'Evidence that is long enough.', null);
insert into t_dec values ('multi', (api.record_decision(pg_temp.sid('multi')::uuid, pg_temp.hash('multi'), 'PUBLISH', null, null, null)) ->> 'decision_id');
select pg_temp.publish(3, 'multi', 'multi-slug');
select is(pg_temp.q(format($$select rr.seq::text || ':' || rr.status from app.publication_rights pr join app.rights_reviews rr on rr.id = pr.rights_review_id where pr.publication_id = %L$$, pg_temp.pid('multi'))), '2:clear', 'a claim reviewed twice is published under its latest review (seq 2, clear)');
select pg_temp.lk(pg_temp.q(format($$select snapshot_text from app.publications where id = %L$$, pg_temp.pid('multi'))), '%rights;1;%;1:2;%', 'and the snapshot says seq 2');

-- ===================================================================================================================
-- G. a newer version supersedes the current publication, atomically
-- ===================================================================================================================
insert into t_dec values ('sup1', pg_temp.ready(3, 'sup1'));
select pg_temp.publish(3, 'sup1', 'sup-hack');
select pg_temp.as_member(1);
insert into t_s values ('sup2', pg_temp.submit_as(1, pg_temp.doc('Second version') || jsonb_build_object('summary', 'Changed.'), pg_temp.hid('sup1')::uuid));
select is(pg_temp.hid('sup2'), pg_temp.hid('sup1'), 'the second version belongs to the same hack');
insert into t_dec values ('sup2', pg_temp.ready(5, 'sup2'));
select pg_temp.as_staff(3);
select pg_temp.publish(3, 'sup2', null);
select is(pg_temp.cur('sup2'), pg_temp.pid('sup2'), 'publishing version 2 moves the one pointer to it');
select is((select r ->> 'superseded_publication_id' from t_pub where k = 'sup2'), pg_temp.pid('sup1'), 'and reports the superseded publication');
select is(pg_temp.wd('sup1'), 'superseded|-|', 'version 1''s publication is ended as superseded');
select is(pg_temp.state('sup1'), 'superseded', 'and its lifecycle is superseded');
select is(pg_temp.q(format($$select count(*)::text from app.publications where hack_id = %L$$, pg_temp.hid('sup1'))), '2', 'both publication records exist');
select is(pg_temp.q(format($$select count(*)::text from app.hacks where current_publication_id is not null and id = %L$$, pg_temp.hid('sup1'))), '1', 'one hack, one current publication');
select is(pg_temp.err('authenticated', format('select api.publish_version(%L, %L, %L, null)::text', pg_temp.sid('sup1'), pg_temp.hash('sup1'), (select d from t_dec where k = 'sup1'))), 'PT409|invalid_state|superseded', 'the superseded version cannot be published again');

-- an older approved version cannot replace a newer one that is current
insert into t_dec values ('old1', pg_temp.ready(3, 'old1'));
select pg_temp.as_member(1);
insert into t_s values ('old2', pg_temp.submit_as(1, pg_temp.doc('Newer version') || jsonb_build_object('summary', 'Changed.'), pg_temp.hid('old1')::uuid));
insert into t_dec values ('old2', pg_temp.ready(5, 'old2'));
select pg_temp.publish(3, 'old2', 'old-hack');
select is(pg_temp.err('authenticated', pg_temp.pubsql('old1', (select d from t_dec where k = 'old1'), null)), 'PT409|invalid_state|newer_version_is_current', 'the older version cannot replace the newer current one (withdraw it first)');
select is(pg_temp.cur('old2'), pg_temp.pid('old2'), 'the newer publication is untouched');
select is(pg_temp.state('old1'), 'approved', 'and the older version stays approved');

-- ===================================================================================================================
-- H. withdrawal
-- ===================================================================================================================
insert into t_dec values ('wd', pg_temp.ready(3, 'wd'));
select pg_temp.publish(3, 'wd', 'wd-slug');
select pg_temp.as_staff(5);
select is(pg_temp.err('authenticated', format('select api.withdraw_publication(%L, %L, null)::text', pg_temp.pid('wd'), 'because')), 'PT422|invalid_content|p_reason_code', 'an unknown reason code is refused');
select is(pg_temp.err('authenticated', format('select api.withdraw_publication(%L, null, null)::text', pg_temp.pid('wd'))), 'PT422|invalid_content|p_reason_code', 'a missing reason is refused');
select is(pg_temp.err('authenticated', 'select api.withdraw_publication(''99999999-9999-4999-8999-999999999999'', ''other'', null)::text'), 'PT404|not_found|', 'an unknown publication is not_found');
select pg_temp.as_member(1);
select is(pg_temp.err('authenticated', format('select api.withdraw_publication(%L, ''other'', null)::text', pg_temp.pid('wd'))), '42501|not_staff|', 'the author, as a member, cannot withdraw');
select is(pg_temp.cur('wd'), pg_temp.pid('wd'), 'still published');
select pg_temp.as_staff(5);
select is(api.withdraw_publication(pg_temp.pid('wd')::uuid, 'quality', 'Not good enough after all.') ->> 'state', 'withdrawn', 'staff withdraw it');
select is(pg_temp.cur('wd'), 'none', 'the pointer is cleared');
select is(pg_temp.state('wd'), 'withdrawn', 'the version is withdrawn');
select is(pg_temp.wd('wd'), 'staff|-|', 'recorded: cause staff');
select is(pg_temp.q(format($$select reason_code || '|' || withdrawn_by::text from app.publication_withdrawals where publication_id = %L$$, pg_temp.pid('wd'))), 'quality|' || pg_temp.u(5)::text, 'with the reason and the withdrawing staff member');
select is(api.get_publication(pg_temp.pid('wd')::uuid) ->> 'is_current', 'false', 'get_publication: not current');
select is(api.get_publication(pg_temp.pid('wd')::uuid) -> 'withdrawal' ->> 'cause', 'staff', 'with its withdrawal');
select is(api.get_publication(pg_temp.pid('wd')::uuid) ->> 'snapshot_hash', pg_temp.q(format($$select encode(snapshot_hash, 'hex') from app.publications where id = %L$$, pg_temp.pid('wd'))), 'and the snapshot, untouched by the withdrawal');
select is(pg_temp.err('authenticated', format('select api.withdraw_publication(%L, ''other'', null)::text', pg_temp.pid('wd'))), 'PT409|invalid_state|not_current', 'withdrawing twice is refused');
select is(pg_temp.err('authenticated', format('select api.publish_version(%L, %L, %L, null)::text', pg_temp.sid('wd'), pg_temp.hash('wd'), (select d from t_dec where k = 'wd'))), 'PT409|invalid_state|withdrawn', 'a withdrawn version cannot be published again');
select is(pg_temp.err('authenticated', format('select api.record_decision(%L, %L, ''HOLD'', array[''other''], null, null)::text', pg_temp.sid('wd'), pg_temp.hash('wd'))), 'PT409|invalid_state|withdrawn', 'nor reviewed further (a new version is the way back)');
select is(pg_temp.owner_do(format($$update app.publication_withdrawals set cause = 'staff' where publication_id = %L$$, pg_temp.pid('wd'))), 'PT409|record_immutable', 'withdrawal rows are immutable too');
select is(pg_temp.owner_do(format($$update app.hacks set current_publication_id = %L where id = %L$$, pg_temp.pid('wd'), pg_temp.hid('wd'))), 'PT409|publication_withdrawn', 'a withdrawn publication cannot be made current again');

-- ===================================================================================================================
-- I. global invariants
-- ===================================================================================================================
select is(pg_temp.q($$select count(*)::text from app.hacks h join app.publication_withdrawals w on w.publication_id = h.current_publication_id$$), '0', 'no hack points at a withdrawn publication');
select is(pg_temp.q($$select count(*)::text from app.hacks h join app.publications p on p.id = h.current_publication_id where p.hack_id <> h.id$$), '0', 'every pointer targets a publication of its own hack');
select is(pg_temp.owner_val($$select count(*)::text from app.hacks h where h.current_publication_id is not null and cardinality(app_review.publication_blockers((select submission_id from app.publications where id = h.current_publication_id), (select published_by from app.publications where id = h.current_publication_id))) > 0$$), '0', 'every publication that is current is eligible right now');
select is(pg_temp.q($$select count(*)::text from app.publications p where not exists (select 1 from app.publication_withdrawals w where w.publication_id = p.id) and not exists (select 1 from app.hacks h where h.current_publication_id = p.id)$$), '0', 'every publication is either current or withdrawn (never neither)');
select is(pg_temp.q($$select count(*)::text from app.publications p where p.snapshot_hash <> sha256(convert_to(p.snapshot_text, 'UTF8'))$$), '0', 'every snapshot hashes correctly');
select is(pg_temp.owner_val($$select count(*)::text from app.publications p where p.snapshot_text <> app_review.snapshot_text(p.hack_id, p.version_id, p.submission_id, p.content_hash, p.canon_version, p.decision_id, p.assessment_id, p.published_by, p.publisher_role, (select array_agg(rights_review_id order by claim_no) from app.publication_rights where publication_id = p.id))$$), '0', 'every snapshot equals its recomputation from the recorded ids');
select is(pg_temp.q($$select count(*)::text from app.publications p where (select count(*) from app.publication_rights r where r.publication_id = p.id) <> (select count(*) from app.source_claims c where c.version_id = p.version_id)$$), '0', 'every publication lists a rights review for every claim of its version');
select is(pg_temp.q($$select count(*)::text from app.publications p join app.moderation_decisions d on d.id = p.decision_id where d.decision <> 'PUBLISH' or d.decided_by_kind <> 'human'$$), '0', 'every publication rests on a human PUBLISH decision');

select * from finish();
rollback;
