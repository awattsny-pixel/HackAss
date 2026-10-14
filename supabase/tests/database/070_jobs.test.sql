-- F2-D1: durable jobs and the publication-eligibility recheck. The worker functions are thin wrappers that check the LOGIN (session_user), which a pgTAP
-- session cannot become; so the logic is exercised here through the owner-only app_review.job_* functions, and the real worker login, parallel claims and
-- races are in scripts/local-f2d1-checks.mjs.
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

-- ---- fixtures ----------------------------------------------------------------------------------------------------------------------------
insert into t_s select k, pg_temp.submit_as(1, pg_temp.doc('Submission ' || k)) from unnest(array['e1', 'noexp', 'e2', 'e3', 'e4', 'sup1', 'wd', 'bk']) k;
create function pg_temp.sid(k text) returns text language sql as $$ select r ->> 'submission_id' from t_s where t_s.k = $1 $$;
create function pg_temp.vid(k text) returns text language sql as $$ select r ->> 'version_id' from t_s where t_s.k = $1 $$;
create function pg_temp.hid(k text) returns text language sql as $$ select r ->> 'hack_id' from t_s where t_s.k = $1 $$;
create function pg_temp.hash(k text) returns text language sql as $$ select r ->> 'hash' from t_s where t_s.k = $1 $$;

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

-- ---- job helpers (all through the owner-only logic; the real worker login is exercised in scripts/local-f2d1-checks.mjs) ----------------------------------
create function pg_temp.jid(k text) returns text language sql as $$
  select pg_temp.q(format($q$select id::text from app.jobs where target_publication_id = %L order by (status in ('queued', 'leased')) desc, created_at desc limit 1$q$, pg_temp.pid(k))) $$;
create function pg_temp.jcol(k text, c text) returns text language sql as $$ select pg_temp.q(format('select %s::text from app.jobs where id = %L', c, pg_temp.jid(k))) $$;
create function pg_temp.due(k text) returns void language sql as $$
  select pg_temp.owner_run(format($q$update app.jobs set available_at = now() - interval '1 minute' where id = %L and status = 'queued'$q$, pg_temp.jid(k))) $$;
create function pg_temp.claim() returns text language sql as $$ select pg_temp.owner_val($q$select app_review.job_claim('publication_recheck')::text$q$) $$;
create function pg_temp.j(k text, fn text, ep bigint) returns text language sql as $$
  select pg_temp.owner_do(format($q$select app_review.%s(%L, %s)$q$, fn, pg_temp.jid(k), coalesce(ep::text, 'null'))) $$;
-- the rights review of the (single) claim of k lapses by the calendar: no review write happens, only time passes
create function pg_temp.lapse(k text) returns void language sql as $$
  select pg_temp.owner_run(format($q$alter table app.rights_reviews disable trigger rights_reviews_append_only;
    update app.rights_reviews set expires_on = current_date - 1 where id = any (app_review.effective_rights(%L));
    alter table app.rights_reviews enable trigger rights_reviews_append_only$q$, pg_temp.sid(k))) $$;
create function pg_temp.wdrow(k text) returns text language sql as $$
  select pg_temp.q(format($q$select coalesce((select cause || '|' || coalesce(trigger_table, '-') || '|' || array_to_string(blockers, ',') || '|' || coalesce(withdrawn_by::text, 'system') from app.publication_withdrawals where publication_id = %L), 'none')$q$, pg_temp.pid(k))) $$;

-- ===================================================================================================================
-- F. the evidence-note-hash backstop (F2-C2 review follow-up). FIRST in the file: SET CONSTRAINTS IMMEDIATE would also fire the pending commit-time checks of
-- publications made earlier in this transaction, and later sections deliberately tamper with time (rights lapse) behind those publications.
-- ===================================================================================================================
insert into t_dec values ('bk', pg_temp.ready(3, 'bk'));
create function pg_temp.bad_child(k text, p_hash text) returns text language plpgsql as $$
declare t text;
begin
  t := pg_temp.owner_val(format($f$select app_review.snapshot_text(s.hack_id, s.version_id, s.id, s.content_hash, 1::smallint, d.id, a.id, %L, 'reviewer', app_review.effective_rights(s.id))
      from app.submissions s, lateral (select id from app.moderation_decisions where submission_id = s.id order by seq desc limit 1) d, lateral (select id from app.version_assessments where submission_id = s.id order by seq desc limit 1) a
     where s.id = %L$f$, pg_temp.u(3), pg_temp.sid(k)));
  return pg_temp.owner_do(format($f$do $x$ declare pid uuid; begin
      insert into app.publications (hack_id, version_id, submission_id, content_hash, canon_version, decision_id, assessment_id, published_by, publisher_role, snapshot_format, snapshot_text, snapshot_hash)
        select s.hack_id, s.version_id, s.id, s.content_hash, 1, d.id, a.id, %L, 'reviewer', 'HACKASS-PUB-1', %L, sha256(convert_to(%L, 'UTF8'))
          from app.submissions s, lateral (select id from app.moderation_decisions where submission_id = s.id order by seq desc limit 1) d, lateral (select id from app.version_assessments where submission_id = s.id order by seq desc limit 1) a
         where s.id = %L returning id into pid;
      insert into app.publication_rights (publication_id, submission_id, claim_no, rights_review_id, claim_hash, evidence_note_hash)
        select pid, rr.submission_id, rr.claim_no, rr.id, rr.claim_hash, %s from app.rights_reviews rr where rr.id = any (app_review.effective_rights(%L));
      set constraints all immediate;
    end $x$ $f$, pg_temp.u(3), t, t, pg_temp.sid(k), p_hash, pg_temp.sid(k)));
end $$;
select is(pg_temp.bad_child('bk', $$decode(repeat('00', 32), 'hex')$$), 'PT409|snapshot_mismatch', 'a child row whose evidence_note_hash is not the hash of the referenced review''s actual note cannot commit');
set constraints all deferred;
select is(pg_temp.bad_child('bk', $$sha256(convert_to(rr.evidence_note || 'x', 'UTF8'))$$), 'PT409|snapshot_mismatch', 'nor can one that hashes a different note');
set constraints all deferred;
select is(pg_temp.bad_child('bk', $$sha256(convert_to(rr.evidence_note, 'UTF8'))$$), 'ok', 'control: the correct hash passes the same path');
set constraints all deferred;

-- ===================================================================================================================
-- A. privileges: owner-only table; the worker holds EXECUTE on exactly the five job functions and the health check, nothing else
-- ===================================================================================================================
select is(
  (select coalesce(string_agg(r.role_name || ' ' || o.op, E'\n'), '') from (values ('authenticated'), ('anon'), ('service_role')) r(role_name)
     cross join (values ('select 1 from app.jobs limit 1'), ('insert into app.jobs default values'), ('update app.jobs set status = ''queued'''), ('delete from app.jobs'), ('truncate app.jobs')) o(op)
    where pg_temp.err(r.role_name, o.op) not like '42501|%'),
  '', 'authenticated, anon and service_role are denied SELECT/INSERT/UPDATE/DELETE/TRUNCATE on app.jobs');
select is((select count(*)::int from (select has_table_privilege('hackass_worker', 'app.jobs', p.priv) h from (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) p(priv)) x where h), 0, 'the worker role holds no privilege on app.jobs');
select is((select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p where has_function_privilege('hackass_worker', p.oid, 'execute') and p.pronamespace::regnamespace::text in ('worker', 'api', 'app_review', 'app_guard', 'app_content', 'app_bridge')),
  'worker.claim_job(text), worker.complete_job(uuid,bigint), worker.fail_job(uuid,bigint,text), worker.get_job_subject(uuid,bigint), worker.healthcheck(), worker.heartbeat_job(uuid,bigint)',
  'the worker can execute exactly the five job functions and the health check; no api, guard, content or review function');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'worker'::regnamespace and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))), 0, 'and no one else can execute any worker function (authenticated, anon, service_role, PUBLIC)');
select is((select coalesce(string_agg(f, ', '), '') from unnest(array['claim_job(''publication_recheck'')', 'heartbeat_job(null, null)', 'get_job_subject(null, null)', 'complete_job(null, null)', 'fail_job(null, null, ''transient'')']) f
            where pg_temp.owner_do('select worker.' || f) <> '42501|not_worker'), '', 'called by any login other than hackass_worker, every worker function refuses first (42501 not_worker), even for the owner role');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'worker'::regnamespace and p.proname <> 'healthcheck' and not (p.prosrc ~ '^\s*begin\s+if session_user <> ''hackass_worker'' then raise exception ''not_worker'' using errcode = ''42501''; end if;')), 0, 'every worker function begins with the worker-login check');
select is((select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' order by p.proname) from pg_proc p where p.pronamespace = 'worker'::regnamespace and p.proname <> 'healthcheck'),
  'claim_job(p_job_type text), complete_job(p_job_id uuid, p_lease_epoch bigint), fail_job(p_job_id uuid, p_lease_epoch bigint, p_error_code text), get_job_subject(p_job_id uuid, p_lease_epoch bigint), heartbeat_job(p_job_id uuid, p_lease_epoch bigint)',
  'no worker function takes a target, a lease length or free text: only a job id, its lease epoch, a type filter (claim) and an allowlisted error code (fail)');

-- ===================================================================================================================
-- B. scheduling: a publication whose rights can lapse gets a recheck at the first lapse; one without expiry gets none
-- ===================================================================================================================
insert into t_dec values ('e1', pg_temp.ready(3, 'e1', 'low', current_date + 10)), ('noexp', pg_temp.ready(3, 'noexp'));
select pg_temp.publish(3, 'e1', 'job-e1');
select pg_temp.publish(3, 'noexp', 'job-noexp');
select is(pg_temp.q(format($$select count(*)::text from app.jobs where target_publication_id = %L$$, pg_temp.pid('noexp'))), '0', 'a publication whose rights never expire gets no recheck job');
select is(pg_temp.q(format($$select count(*)::text from app.jobs where target_publication_id = %L and status = 'queued' and job_type = 'publication_recheck' and lease_epoch = 0 and retry_count = 0$$, pg_temp.pid('e1'))), '1', 'one queued job at epoch 0 is created in the same transaction as the publication');
select is(pg_temp.jcol('e1', 'available_at'), pg_temp.q('select (((current_date + 11)::timestamp) at time zone ''UTC'')::text'), 'due the day after the earliest expiry (UTC midnight)');
select pg_temp.as_staff(3);
select api.record_rights_review(pg_temp.sid('e1')::uuid, pg_temp.hash('e1'), 1, 'clear', 'source_page_checked', 'Re-checked, earlier expiry.', current_date + 3);
select is(pg_temp.jcol('e1', 'available_at'), pg_temp.q('select (((current_date + 4)::timestamp) at time zone ''UTC'')::text'), 'a later review with an EARLIER expiry pulls the queued job earlier');
select api.record_rights_review(pg_temp.sid('e1')::uuid, pg_temp.hash('e1'), 1, 'clear', 'source_page_checked', 'Re-checked, later expiry.', current_date + 30);
select is(pg_temp.jcol('e1', 'available_at'), pg_temp.q('select (((current_date + 4)::timestamp) at time zone ''UTC'')::text'), 'a later expiry never pushes it later (a recheck that comes early is harmless)');
select is(pg_temp.q(format($$select count(*)::text from app.jobs where target_publication_id = %L$$, pg_temp.pid('e1'))), '1', 'and there is still exactly one job');

-- ===================================================================================================================
-- C. claim, lease, epoch
-- ===================================================================================================================
select is(pg_temp.claim(), 'NULL', 'nothing is due: claim returns nothing (the job is queued for the future)');
select is(pg_temp.owner_do($$select app_review.job_claim('other_type')$$), 'PT422|invalid_content', 'an unknown job type is refused');
select pg_temp.due('e1');
create temp table t_c1 as select pg_temp.claim()::jsonb as r;
grant all on t_c1 to public;
select is((select r ->> 'job_id' from t_c1), pg_temp.jid('e1'), 'claim returns the due job');
select is((select r ->> 'lease_epoch' from t_c1), '1', 'at lease epoch 1');
select is((select (r ? 'target_publication_id' or r ? 'publication_id')::text from t_c1), 'false', 'and does not hand the worker the target');
select is(pg_temp.jcol('e1', 'status') || '/' || pg_temp.jcol('e1', 'retry_count'), 'leased/0', 'the job is leased, no retry yet');
select is(pg_temp.q(format($$select (lease_expires_at > now() + interval '4 minutes' and lease_expires_at <= now() + interval '5 minutes')::text from app.jobs where id = %L$$, pg_temp.jid('e1'))), 'true', 'the lease is five minutes, chosen by the database');
select is(pg_temp.claim(), 'NULL', 'a second claim finds nothing: an active lease is not claimable');
select is(pg_temp.owner_val(format($$select (select string_agg(k, ',' order by k) from jsonb_object_keys(app_review.job_subject(%L, 1)) k)$$, pg_temp.jid('e1'))),
  'hack_id,is_current,job_id,job_type,lease_epoch,next_rights_expiry,publication_id,version_id', 'get_job_subject returns exactly the allowlisted keys for this job type (ids, a flag, a date: no content, notes, hashes, names)');
select is(pg_temp.owner_val(format($$select (app_review.job_subject(%L, 1) ->> 'is_current')$$, pg_temp.jid('e1'))), 'true', 'and tells the worker whether the publication is still current');
select is((select string_agg(distinct pg_temp.j('e1', fn, ep), ',') from unnest(array['job_subject', 'job_heartbeat', 'job_complete']) fn cross join unnest(array[0::bigint, 2, 99, -1, null]) ep), 'PT409|lease_lost', 'subject, heartbeat and complete refuse any epoch other than the live one with the same error');
select is(pg_temp.owner_do(format($$select app_review.job_fail(%L, 2, 'transient')$$, pg_temp.jid('e1'))), 'PT409|lease_lost', 'so does fail');
select is(pg_temp.owner_do($$select app_review.job_heartbeat('00000000-0000-4000-8000-0000000000aa', 1)$$), 'PT409|lease_lost', 'and an unknown job id (no existence oracle)');
select pg_temp.owner_run(format($$update app.jobs set lease_expires_at = now() + interval '10 seconds' where id = %L$$, pg_temp.jid('e1')));
select is(pg_temp.owner_val(format($$select ((app_review.job_heartbeat(%L, 1) ->> 'lease_expires_at')::timestamptz > now() + interval '4 minutes')::text$$, pg_temp.jid('e1'))), 'true', 'heartbeat extends the lease to five minutes from now');
select is(pg_temp.owner_do(format($$select app_review.job_fail(%L, 1, 'whatever')$$, pg_temp.jid('e1'))), 'PT422|invalid_content', 'fail takes only an allowlisted error code');
select is((pg_temp.owner_val(format($$select app_review.job_fail(%L, 1, 'transient')::text$$, pg_temp.jid('e1')))::jsonb) ->> 'status', 'queued', 'a failed attempt goes back to queued while attempts remain');
select is(pg_temp.jcol('e1', 'retry_count') || '/' || (pg_temp.q(format($$select (available_at > now() + interval '20 seconds')::text from app.jobs where id = %L$$, pg_temp.jid('e1')))), '1/true', 'with the retry counted and a back-off before it is available again');
select is(pg_temp.j('e1', 'job_complete', 1), 'PT409|lease_lost', 'the old lease is dead once the job is queued again');
select is(pg_temp.claim(), 'NULL', 'and it is not claimable during the back-off');
select pg_temp.due('e1');
select is((pg_temp.claim()::jsonb) ->> 'lease_epoch', '2', 'the next claim is epoch 2 (the epoch never repeats)');
select is(pg_temp.j('e1', 'job_heartbeat', 1), 'PT409|lease_lost', 'epoch 1 can no longer do anything');
select pg_temp.owner_run(format($$update app.jobs set lease_expires_at = now() - interval '1 second' where id = %L$$, pg_temp.jid('e1')));
select is((select string_agg(distinct pg_temp.j('e1', fn, 2), ',') from unnest(array['job_subject', 'job_heartbeat', 'job_complete']) fn), 'PT409|lease_lost', 'an EXPIRED lease fails closed for subject, heartbeat and complete even at the right epoch');
select is(pg_temp.owner_do(format($$select app_review.job_fail(%L, 2, 'transient')$$, pg_temp.jid('e1'))), 'PT409|lease_lost', 'and for fail');
create temp table t_c3 as select pg_temp.claim()::jsonb as r;
grant all on t_c3 to public;
select is((select r ->> 'lease_epoch' from t_c3) || '/' || (select r ->> 'attempt' from t_c3) || '/' || pg_temp.jcol('e1', 'retry_count'), '3/3/2', 'reclaiming an expired lease: epoch 3, the expiry counted as an attempt (retry_count 2)');
select is((select string_agg(distinct pg_temp.j('e1', fn, 2), ',') from unnest(array['job_subject', 'job_heartbeat', 'job_complete']) fn), 'PT409|lease_lost', 'every operation from the earlier epoch is rejected after the reclaim');
select is(pg_temp.owner_do(format($$select app_review.job_fail(%L, 2, 'internal')$$, pg_temp.jid('e1'))), 'PT409|lease_lost', 'including fail');
select is(pg_temp.q(format($$select status || '/' || lease_epoch from app.jobs where id = %L$$, pg_temp.jid('e1'))), 'leased/3', 'and the job is untouched by those attempts');

-- ===================================================================================================================
-- D. the effect: complete rechecks the current publication under the lock protocol, withdraws on lost eligibility, keeps history
-- ===================================================================================================================
create temp table t_d1 as select pg_temp.owner_val(format($$select app_review.job_complete(%L, 3)::text$$, pg_temp.jid('e1')))::jsonb as r;
grant all on t_d1 to public;
select is((select r ->> 'outcome' from t_d1), 'still_eligible', 'a recheck of an eligible publication reports still_eligible');
select is(pg_temp.cur('e1'), pg_temp.pid('e1'), 'and leaves the pointer alone');
select is(pg_temp.q(format($$select status || '/' || outcome from app.jobs where id = %L$$, (select r ->> 'job_id' from t_d1))), 'succeeded/still_eligible', 'the job is succeeded');
select is(pg_temp.q(format($$select count(*)::text from app.jobs where target_publication_id = %L and status = 'queued'$$, pg_temp.pid('e1'))), '1', 'and exactly one new job is queued');
select is(pg_temp.jcol('e1', 'available_at'), pg_temp.q('select (((current_date + 31)::timestamp) at time zone ''UTC'')::text'), 'for the day after the next expiry');
select is(pg_temp.owner_do(format($$select app_review.job_complete(%L, 3)$$, (select r ->> 'job_id' from t_d1))), 'PT409|lease_lost', 'duplicate delivery of the same completion is refused');
select is(pg_temp.q(format($$select count(*)::text from app.jobs where target_publication_id = %L$$, pg_temp.pid('e1'))), '2', 'with no extra job from the duplicate');
select pg_temp.lapse('e1');
select is(pg_temp.cur('e1'), pg_temp.pid('e1'), 'time passing alone does not touch the publication (that is why the recheck exists)');
select pg_temp.due('e1');
create temp table t_d2 as select pg_temp.claim()::jsonb as r;
grant all on t_d2 to public;
select is((select r ->> 'lease_epoch' from t_d2), '1', 'the new job starts at epoch 1');
create temp table t_snap as select snapshot_hash, snapshot_text from app.publications where id = pg_temp.pid('e1')::uuid;
grant all on t_snap to public;
create temp table t_d3 as select pg_temp.owner_val(format($$select app_review.job_complete(%L, 1)::text$$, pg_temp.jid('e1')))::jsonb as r;
grant all on t_d3 to public;
select is((select r ->> 'outcome' from t_d3), 'withdrawn', 'the recheck withdraws a publication whose rights lapsed');
select is(pg_temp.cur('e1'), 'none', 'the pointer is cleared');
select is(pg_temp.wdrow('e1'), 'recheck|jobs|rights_not_clear:1|system', 'history: cause recheck, naming the jobs table and the blocker, no staff actor');
select is(pg_temp.q(format($$select (trigger_id = %L)::text from app.publication_withdrawals where publication_id = %L$$, (select r ->> 'job_id' from t_d3), pg_temp.pid('e1'))), 'true', 'and the exact job that did it');
select is(pg_temp.state('e1'), 'under_review', 'the version returns to review');
select is(pg_temp.q(format($$select (snapshot_hash = (select snapshot_hash from t_snap) and snapshot_text = (select snapshot_text from t_snap))::text from app.publications where id = %L$$, pg_temp.pid('e1'))), 'true', 'the publication record and its snapshot are untouched');
-- retries and duplicates
select pg_temp.owner_run(format($$insert into app.jobs (job_type, target_publication_id, available_at) values ('publication_recheck', %L, now() - interval '1 minute')$$, pg_temp.pid('e1')));
select is((pg_temp.claim()::jsonb) ->> 'lease_epoch', '1', 'a duplicate job for the same publication is claimed');
select is(pg_temp.owner_val(format($$select (app_review.job_complete(%L, 1)::jsonb) ->> 'outcome'$$, pg_temp.jid('e1'))), 'not_current', 'its recheck finds nothing current and does nothing');
select is(pg_temp.cur('e1') || '/' || (select count(*)::text from app.publication_withdrawals where publication_id = pg_temp.pid('e1')::uuid), 'none/1', 'the pointer stays cleared and the withdrawal history has not changed');
-- fixed and published again
select pg_temp.as_staff(3);
select api.record_rights_review(pg_temp.sid('e1')::uuid, pg_temp.hash('e1'), 1, 'clear', 'source_page_checked', 'Re-cleared after the lapse.', current_date + 60);
insert into t_dec values ('e1b', (api.record_decision(pg_temp.sid('e1')::uuid, pg_temp.hash('e1'), 'PUBLISH', null, null, (select d::uuid from t_dec where k = 'e1')) ->> 'decision_id'));
create temp table t_e1a as select pg_temp.pid('e1') as p;
grant all on t_e1a to public;
delete from t_pub where k = 'e1';
insert into t_pub select 'e1', api.publish_version(pg_temp.sid('e1')::uuid, pg_temp.hash('e1'), (select d::uuid from t_dec where k = 'e1b'), null);
select isnt(pg_temp.pid('e1'), (select p from t_e1a), 'the version is published again as a NEW publication');
select pg_temp.owner_run(format($$insert into app.jobs (job_type, target_publication_id, available_at) values ('publication_recheck', %L, now() - interval '1 minute')$$, (select p from t_e1a)));
select is((pg_temp.claim()::jsonb) ->> 'lease_epoch', '1', 'a stale job for the OLD publication is delivered again');
select is(pg_temp.owner_val(format($$select (app_review.job_complete(id, 1)::jsonb) ->> 'outcome' from app.jobs where target_publication_id = %L and status = 'leased'$$, (select p from t_e1a))), 'not_current', 'it reports not_current');
select is(pg_temp.cur('e1'), pg_temp.pid('e1'), 'the NEW publication is still the current one: the old job neither withdrew it nor replaced the pointer');
-- target binding
insert into t_dec values ('e2', pg_temp.ready(3, 'e2', 'low', current_date + 10)), ('e3', pg_temp.ready(3, 'e3', 'low', current_date + 10));
select pg_temp.publish(3, 'e2', 'job-e2');
select pg_temp.publish(3, 'e3', 'job-e3');
select pg_temp.lapse('e2');
select pg_temp.lapse('e3');
select pg_temp.due('e2');
select is((pg_temp.claim()::jsonb) ->> 'job_id', pg_temp.jid('e2'), 'job A is claimed (B is not due)');
select is(pg_temp.owner_do(format($$select app_review.job_complete(%L, 1)$$, pg_temp.jid('e3'))), 'PT409|lease_lost', 'A''s epoch cannot complete B''s job');
select is(pg_temp.owner_val(format($$select (app_review.job_complete(%L, 1)::jsonb) ->> 'outcome'$$, pg_temp.jid('e2'))), 'withdrawn', 'A completes and withdraws A');
select is(pg_temp.cur('e2') || '/' || (case when pg_temp.cur('e3') = pg_temp.pid('e3') then 'B-current' else 'B-changed' end), 'none/B-current', 'B is NOT affected, although B is just as ineligible');
select is(pg_temp.jcol('e3', 'status'), 'queued', 'and B''s job is untouched');
select pg_temp.due('e3');
select is(pg_temp.claim() is not null, true, 'B is claimed later');
select is(pg_temp.owner_val(format($$select (app_review.job_complete(%L, 1)::jsonb) ->> 'outcome'$$, pg_temp.jid('e3'))), 'withdrawn', 'and B''s own job withdraws B');
-- superseding and manual withdrawal
insert into t_dec values ('sup1', pg_temp.ready(3, 'sup1', 'low', current_date + 10));
select pg_temp.publish(3, 'sup1', 'job-sup');
select pg_temp.as_member(1);
insert into t_s values ('sup2', pg_temp.submit_as(1, pg_temp.doc('Second version') || jsonb_build_object('summary', 'Changed.'), pg_temp.hid('sup1')::uuid));
insert into t_dec values ('sup2', pg_temp.ready(5, 'sup2', 'low', current_date + 10));
select pg_temp.publish(3, 'sup2', null);
select is(pg_temp.wdrow('sup1'), 'superseded|-||' || pg_temp.u(3)::text, 'version 1 was superseded by publishing version 2');
select pg_temp.due('sup1');
select is(pg_temp.claim() is not null, true, 'its recheck job is still delivered');
select is(pg_temp.owner_val(format($$select (app_review.job_complete(%L, 1)::jsonb) ->> 'outcome'$$, pg_temp.jid('sup1'))), 'not_current', 'and finds it not current');
select is(pg_temp.wdrow('sup1') || '/' || (case when pg_temp.cur('sup2') = pg_temp.pid('sup2') then 'v2-current' else 'v2-changed' end), 'superseded|-||' || pg_temp.u(3)::text || '/v2-current', 'the superseded history is unchanged and version 2 is still current');
insert into t_dec values ('wd', pg_temp.ready(3, 'wd', 'low', current_date + 10));
select pg_temp.publish(3, 'wd', 'job-wd');
select pg_temp.as_staff(5);
select api.withdraw_publication(pg_temp.pid('wd')::uuid, 'quality', 'Manually withdrawn.');
select pg_temp.due('wd');
select is(pg_temp.claim() is not null, true, 'the recheck of a manually withdrawn publication is still delivered');
select is(pg_temp.owner_val(format($$select (app_review.job_complete(%L, 1)::jsonb) ->> 'outcome'$$, pg_temp.jid('wd'))), 'not_current', 'and does nothing');
select is(pg_temp.wdrow('wd'), 'staff|-||' || pg_temp.u(5)::text, 'the staff withdrawal stays exactly as it was');
select is(pg_temp.state('wd'), 'withdrawn', 'with its version state');
-- attempts run out
insert into t_dec values ('e4', pg_temp.ready(3, 'e4', 'low', current_date + 10));
select pg_temp.publish(3, 'e4', 'job-e4');
select pg_temp.due('e4');
select pg_temp.claim() is not null as claimed;
select pg_temp.owner_run(format($$update app.jobs set retry_count = 4, lease_expires_at = now() - interval '1 second' where id = %L$$, pg_temp.jid('e4')));
select is(pg_temp.claim(), 'NULL', 'an expired lease on the last attempt is not reclaimed');
select is(pg_temp.jcol('e4', 'status') || '/' || pg_temp.jcol('e4', 'last_error_code') || '/' || (pg_temp.jcol('e4', 'completed_at') <> 'NULL')::text, 'failed/lease_expired/true', 'it is failed for good (lease_expired)');
select is(pg_temp.cur('e4'), pg_temp.pid('e4'), 'a failed job changes nothing about the publication');
select is(pg_temp.owner_do(format($$update app.jobs set status = 'queued', lease_expires_at = null where id = %L$$, pg_temp.jid('e4'))), 'PT409|record_immutable', 'a finished job cannot be revived');

-- ===================================================================================================================
-- E. the job table's own guards
-- ===================================================================================================================
select pg_temp.owner_run(format($$insert into app.jobs (job_type, target_publication_id, available_at) values ('publication_recheck', %L, now() + interval '1 day')$$, pg_temp.pid('noexp')));
create temp table t_g as select id from app.jobs where target_publication_id = pg_temp.pid('noexp')::uuid;
grant all on t_g to public;
select is(pg_temp.owner_do(format($$insert into app.jobs (job_type, target_publication_id) values ('publication_recheck', %L)$$, pg_temp.pid('noexp'))), '23505|duplicate key value violates unique constraint "jobs_one_active"', 'a second ACTIVE job for the same target is refused');
select is(pg_temp.owner_do(format($$insert into app.jobs (job_type, target_publication_id) values ('other', %L)$$, pg_temp.pid('noexp'))), '23514|new row for relation "jobs" violates check constraint "jobs_job_type_check"', 'an unknown job type is refused');
select is(pg_temp.owner_do($$insert into app.jobs (job_type, target_publication_id) values ('publication_recheck', '99999999-9999-4999-8999-999999999999')$$), '23503|insert or update on table "jobs" violates foreign key constraint "jobs_target_publication_id_fkey"', 'a job must target an existing publication');
select is(pg_temp.owner_do(format($$insert into app.jobs (job_type, target_publication_id, status, lease_epoch, lease_expires_at) values ('publication_recheck', %L, 'leased', 5, now())$$, pg_temp.pid('wd'))), 'PT409|invalid_state', 'a job is born queued at epoch 0');
select is(pg_temp.owner_do(format($$update app.jobs set target_publication_id = %L where id = %L$$, pg_temp.pid('wd'), (select id from t_g))), 'PT409|identity_immutable', 'a job''s target cannot be changed');
select is(pg_temp.owner_do(format($$update app.jobs set status = 'leased', lease_epoch = 2, lease_expires_at = now() where id = %L$$, (select id from t_g))), 'PT409|epoch_monotonic', 'the epoch moves by exactly one, and only with a lease');
select is(pg_temp.owner_do(format($$update app.jobs set lease_epoch = 1 where id = %L$$, (select id from t_g))), 'PT409|epoch_monotonic', 'it cannot be bumped without a lease');
select is(pg_temp.owner_do(format($$update app.jobs set status = 'leased', lease_epoch = 1, lease_expires_at = now() + interval '1 minute' where id = %L$$, (select id from t_g))), 'ok', 'control: a legitimate lease');
select is(pg_temp.owner_do(format($$update app.jobs set status = 'queued', lease_expires_at = null, lease_epoch = 0 where id = %L$$, (select id from t_g))), 'PT409|epoch_monotonic', 'the epoch cannot go back');
select is(pg_temp.owner_do(format($$delete from app.jobs where id = %L$$, (select id from t_g))), 'PT409|record_immutable', 'jobs cannot be deleted');
select is(pg_temp.owner_do('truncate app.jobs'), 'PT409|truncate_forbidden', 'or truncated');
select is(pg_temp.owner_do(format($$insert into app.publication_withdrawals (publication_id, cause, trigger_table, trigger_id, withdrawn_by) values (%L, 'recheck', 'jobs', gen_random_uuid(), %L)$$, pg_temp.pid('noexp'), pg_temp.u(3))), '23514|new row for relation "publication_withdrawals" violates check constraint "withdrawals_actor_unless_recheck"', 'a recheck withdrawal cannot carry a staff actor');
select is(pg_temp.owner_do(format($$insert into app.publication_withdrawals (publication_id, cause, reason_code) values (%L, 'staff', 'other')$$, pg_temp.pid('noexp'))), '23514|new row for relation "publication_withdrawals" violates check constraint "withdrawals_actor_unless_recheck"', 'and a staff withdrawal must have one');
select is(pg_temp.owner_do(format($$insert into app.publication_withdrawals (publication_id, cause) values (%L, 'recheck')$$, pg_temp.pid('noexp'))), '23514|new row for relation "publication_withdrawals" violates check constraint "withdrawals_recheck_names_job"', 'a recheck withdrawal must name the job that made it');

-- ===================================================================================================================
-- G. global invariants
-- ===================================================================================================================
select is(pg_temp.q($$select count(*)::text from app.jobs j where j.status = 'succeeded' and j.outcome = 'withdrawn' and not exists (select 1 from app.publication_withdrawals w where w.trigger_id = j.id and w.cause = 'recheck' and w.publication_id = j.target_publication_id)$$), '0', 'every job that reports withdrawn has its withdrawal row, for ITS target only');
select is(pg_temp.q($$select count(*)::text from app.publication_withdrawals w where w.cause = 'recheck' and not exists (select 1 from app.jobs j where j.id = w.trigger_id and j.target_publication_id = w.publication_id and j.status = 'succeeded' and j.outcome = 'withdrawn')$$), '0', 'and every recheck withdrawal has exactly such a job');
select is(pg_temp.q($$select count(*)::text from app.hacks h join app.publication_withdrawals w on w.publication_id = h.current_publication_id$$), '0', 'no hack points at a withdrawn publication');

select * from finish();
rollback;
