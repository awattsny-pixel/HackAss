-- F2-D2: AI budgets, reservations and usage accounting. Everything is owner-only: the functions of schema app_budget are exercised as the owner role.
-- Fifty-way concurrency, races and the rollback rehearsal are in scripts/local-f2d2-checks.mjs.
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

-- ---- fixtures: one frozen submission (and a second for argument-change tests) ---------------------------------------------------------------
insert into t_s select k, pg_temp.submit_as(1, pg_temp.doc('Submission ' || k)) from unnest(array['s1', 's2']) k;
create function pg_temp.sid(k text) returns text language sql as $$ select r ->> 'submission_id' from t_s where t_s.k = $1 $$;
create function pg_temp.hash(k text) returns text language sql as $$ select r ->> 'hash' from t_s where t_s.k = $1 $$;
-- ---- helpers --------------------------------------------------------------------------------------------------------------------------
create function pg_temp.bv(p_sql text) returns text language sql as $$ select pg_temp.owner_val(p_sql) $$;
-- errors with detail: 'SQLSTATE|message|detail'
create function pg_temp.bd(p_sql text) returns text language plpgsql as $$
declare m text; d text; c text;
begin
  perform set_config('role', 'hackass_owner', true);
  begin execute p_sql;
  exception when others then get stacked diagnostics m = message_text, d = pg_exception_detail, c = returned_sqlstate;
    perform set_config('role', 'none', true); return c || '|' || m || '|' || coalesce(d, '');
  end;
  perform set_config('role', 'none', true); return 'ok';
end $$;
create function pg_temp.res(k text, op text, sub text, mx bigint, p_day text default null) returns text language sql as $$
  select case when p_day is null then format('select app_budget.reserve(%L, %L, %L, %L, %s)', k, op, pg_temp.sid(sub), pg_temp.hash(sub), mx)
              else format('select app_budget.reserve_for_day(%L, %L, %L, %L, %s, %L)', k, op, pg_temp.sid(sub), pg_temp.hash(sub), mx, p_day) end $$;
create function pg_temp.rid(k text) returns text language sql as $$ select pg_temp.q(format('select id::text from app.ai_reservations where idempotency_key = %L', k)) $$;
create function pg_temp.cnt(p_scope text, p_col text, p_day text default null) returns text language sql as $$
  select pg_temp.q(format('select coalesce((select %s::text from app.ai_budget_days where scope = %L and budget_day = coalesce(%L::date, (clock_timestamp() at time zone ''UTC'')::date)), ''0'')', p_col, p_scope, p_day)) $$;
create function pg_temp.recon() returns text language sql as $$ select pg_temp.bv('select (app_budget.reconcile_report(null) ->> ''ok'')') $$;

-- ===================================================================================================================
-- A. owner-only: no table, function or schema access for anyone else
-- ===================================================================================================================
select is(
  (select coalesce(string_agg(r.role_name || ' ' || t.tbl || ' ' || o.op, E'\n'), '') from (values ('authenticated'), ('anon'), ('service_role')) r(role_name)
     cross join (values ('ai_budget_global'), ('ai_operation_types'), ('ai_reservations'), ('ai_ledger'), ('ai_budget_days')) t(tbl)
     cross join (values ('select 1 from app.%s limit 1'), ('insert into app.%s default values'), ('update app.%s set updated_at = now()'), ('delete from app.%s'), ('truncate app.%s')) o(op)
    where pg_temp.err(r.role_name, format(o.op, t.tbl)) not like '42501|%'),
  '', 'authenticated, anon and service_role are denied SELECT/INSERT/UPDATE/DELETE/TRUNCATE on all five budget tables');
select is((select count(*)::int from pg_class c cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) p(priv)
            where c.relname in ('ai_budget_global', 'ai_operation_types', 'ai_reservations', 'ai_ledger', 'ai_budget_days') and c.relnamespace = 'app'::regnamespace and has_table_privilege('hackass_worker', c.oid, p.priv)), 0, 'the worker role holds no privilege on any budget table');
select is((select count(*)::int from pg_class where relname in ('ai_budget_global', 'ai_operation_types', 'ai_reservations', 'ai_ledger', 'ai_budget_days') and relnamespace = 'app'::regnamespace and relrowsecurity), 5, 'RLS is enabled on all five');
select is((select count(*)::int from pg_proc p cross join (values ('authenticated'), ('anon'), ('service_role'), ('hackass_worker'), ('postgres'), ('public')) r(role_name)
            where p.pronamespace = 'app_budget'::regnamespace and has_function_privilege(r.role_name, p.oid, 'execute')), 0, 'no role but the owner can execute any app_budget function (members, anon, service_role, worker, postgres, PUBLIC)');
select is((select count(*)::int from (values ('authenticated'), ('anon'), ('service_role'), ('hackass_worker'), ('public')) r(role_name) where has_schema_privilege(r.role_name, 'app_budget', 'usage')), 0, 'and nobody has USAGE on the schema');
select is((select count(*)::int from pg_proc p where p.pronamespace in ('api'::regnamespace, 'worker'::regnamespace) and p.prosrc like '%app_budget%'), 0, 'no api or worker function reaches the budget functions (not wired to any capability in this slice)');
select is(pg_temp.err('authenticated', 'select app_budget.today()'), '42501|permission denied for schema app_budget|', 'a member calling a budget function is refused at the schema');

-- ===================================================================================================================
-- B. refusals: missing configuration, disabled, invalid amounts and arguments
-- ===================================================================================================================
select is(pg_temp.bd(pg_temp.res('key-b-0001', 'summarize', 's1', 100)), 'PT409|budget_refused|global_unconfigured', 'no global budget row: refused (global_unconfigured)');
select pg_temp.owner_run($$insert into app.ai_budget_global (enabled, daily_limit_micros) values (false, 1000)$$);
select is(pg_temp.bd(pg_temp.res('key-b-0002', 'summarize', 's1', 100)), 'PT409|budget_refused|global_disabled', 'global budget disabled: refused');
select pg_temp.owner_run($$update app.ai_budget_global set enabled = true$$);
select is(pg_temp.bd(pg_temp.res('key-b-0003', 'summarize', 's1', 100)), 'PT409|budget_refused|operation_unconfigured', 'operation not on the allowlist: refused (operation_unconfigured)');
select pg_temp.owner_run($$insert into app.ai_operation_types (op_type, enabled, daily_limit_micros, max_charge_micros) values ('summarize', false, 600, 300), ('classify', true, 900, 500)$$);
select is(pg_temp.bd(pg_temp.res('key-b-0004', 'summarize', 's1', 100)), 'PT409|budget_refused|operation_disabled', 'operation disabled: refused');
select pg_temp.owner_run($$update app.ai_operation_types set enabled = true where op_type = 'summarize'$$);
select is(pg_temp.bd(pg_temp.res('key-b-0005', 'summarize', 's1', 301)), 'PT409|budget_refused|amount_over_cap', 'above the operation''s per-reservation cap: refused');
select is((select string_agg(pg_temp.bd(pg_temp.res('key-b-0006', 'summarize', 's1', a)), ',') from unnest(array[0::bigint, -5, 1000000000001]) a), 'PT422|invalid_amount|,PT422|invalid_amount|,PT422|invalid_amount|', 'zero, negative and oversized amounts are invalid');
select is(pg_temp.bd(format('select app_budget.reserve(%L, %L, %L, %L, null)', 'key-b-0007', 'summarize', pg_temp.sid('s1'), pg_temp.hash('s1'))), 'PT422|invalid_amount|', 'a NULL amount is invalid');
select is(pg_temp.bd(pg_temp.res('short', 'summarize', 's1', 100)), 'PT422|invalid_content|idempotency_key', 'a malformed idempotency key is refused');
select is(pg_temp.bd(pg_temp.res('key-b-0008', 'Bad Op!', 's1', 100)), 'PT422|invalid_content|op_type', 'a malformed operation type is refused');
select is(pg_temp.bd(format('select app_budget.reserve(%L, %L, %L, %L, 100)', 'key-b-0009', 'summarize', pg_temp.sid('s1'), repeat('0', 64))), 'PT409|hash_mismatch|the reviewed hash is not the submission''s frozen hash', 'a content hash that is not the frozen hash is refused');
select is(pg_temp.bd(format('select app_budget.reserve(%L, %L, %L, %L, 100)', 'key-b-0010', 'summarize', '99999999-9999-4999-8999-999999999999', pg_temp.hash('s1'))), 'PT404|not_found|', 'an unknown submission is refused');
select is(pg_temp.bd(pg_temp.res('key-b-0011', 'summarize', 's1', 100, (current_date + 5)::text)), 'PT422|invalid_content|day', 'a budget day more than one day from today is refused');
select is(pg_temp.q('select count(*)::text from app.ai_reservations'), '0', 'none of the refusals created a reservation');
select is(pg_temp.q('select count(*)::text from app.ai_ledger'), '0', 'or a ledger entry');

-- ===================================================================================================================
-- C. both limits hold: global 1000; summarize limit 600 (cap 300); classify limit 900 (cap 500)
-- ===================================================================================================================
select is(pg_temp.bd(pg_temp.res('key-c-0001', 'summarize', 's1', 300)), 'ok', 'summarize 300 reserved');
select is(pg_temp.bd(pg_temp.res('key-c-0002', 'summarize', 's1', 300)), 'ok', 'summarize 300 more (operation at 600 of 600)');
select is(pg_temp.bd(pg_temp.res('key-c-0003', 'summarize', 's1', 1)), 'PT409|budget_refused|operation_budget_exhausted', 'the OPERATION limit binds while the global budget still has room (600 of 1000)');
select is(pg_temp.bd(pg_temp.res('key-c-0004', 'classify', 's1', 400)), 'ok', 'classify 400 reserved (global now 1000 of 1000)');
select is(pg_temp.bd(pg_temp.res('key-c-0005', 'classify', 's1', 1)), 'PT409|budget_refused|global_budget_exhausted', 'the GLOBAL limit binds while the operation (400 of 900) has room');
select is(pg_temp.cnt('global', 'reserved_micros') || '/' || pg_temp.cnt('summarize', 'reserved_micros') || '/' || pg_temp.cnt('classify', 'reserved_micros'), '1000/600/400', 'the running totals are 1000 global, 600 summarize, 400 classify');
select is(pg_temp.q('select count(*)::text from app.ai_reservations'), '3', 'and exactly the three accepted reservations exist');
select is(pg_temp.recon(), 'true', 'the ledger reconciles with the totals and the reservations');

-- ===================================================================================================================
-- D. idempotency
-- ===================================================================================================================
select is(pg_temp.bv(pg_temp.res('key-c-0001', 'summarize', 's1', 300)::text) like '%"replayed": true%', true, 'the same request again returns the existing reservation, replayed');
select is(pg_temp.bv('select (' || trim(trailing ';' from pg_temp.res('key-c-0001', 'summarize', 's1', 300)) || ') ->> ''reservation_id'''), pg_temp.rid('key-c-0001'), 'and it is the SAME reservation id');
select is(pg_temp.cnt('global', 'reserved_micros'), '1000', 'a replay consumes no budget (still 1000)');
select is(pg_temp.q('select count(*)::text from app.ai_ledger'), '3', 'and writes no ledger entry');
select is(pg_temp.bd(pg_temp.res('key-c-0001', 'summarize', 's1', 299)), 'PT409|idempotency_conflict|', 'the same key with a different maximum is refused');
select is(pg_temp.bd(pg_temp.res('key-c-0001', 'classify', 's1', 300)), 'PT409|idempotency_conflict|', 'with a different operation type');
select is(pg_temp.bd(pg_temp.res('key-c-0001', 'summarize', 's2', 300)), 'PT409|idempotency_conflict|', 'with a different target submission');
select is(pg_temp.bd(pg_temp.res('key-c-0001', 'summarize', 's1', 300, (current_date - 1)::text)), 'ok', 'a different DAY does not change the identity of the request (the existing reservation is returned)');
select is(pg_temp.cnt('global', 'reserved_micros') || '/' || pg_temp.q('select count(*)::text from app.ai_reservations'), '1000/3', 'still nothing new');
select is(pg_temp.bd(pg_temp.res('key-c-0004', 'classify', 's1', 400)), 'ok', 'a replay of an exhausted-budget request still returns the existing reservation (no budget needed)');

-- ===================================================================================================================
-- E. settlement: actual cost, only the unused part released, once, on the reservation's day
-- ===================================================================================================================
select is(pg_temp.bv(format('select (app_budget.settle(%L, 120)) ->> ''status''', pg_temp.rid('key-c-0001'))), 'settled', 'settling 300 reserved at an actual of 120');
select is(pg_temp.cnt('summarize', 'reserved_micros') || '/' || pg_temp.cnt('summarize', 'spent_micros'), '300/120', 'the hold of 300 ends: 120 spent, the other reservation''s 300 still held');
select is(pg_temp.cnt('global', 'reserved_micros') || '/' || pg_temp.cnt('global', 'spent_micros'), '700/120', 'global: 700 held, 120 spent');
select is(pg_temp.q(format($$select released_micros::text || '/' || spent_delta::text || '/' || overrun_micros::text || '/' || reserved_delta::text from app.ai_ledger where reservation_id = %L and kind = 'settle'$$, pg_temp.rid('key-c-0001'))), '180/120/0/-300', 'the ledger records released 180 (the unused part), spent 120, no overrun');
select is(pg_temp.bv(format('select (app_budget.settle(%L, 120)) ->> ''replayed''', pg_temp.rid('key-c-0001'))), 'true', 'settling again with the same amount returns the existing settlement');
select is(pg_temp.bd(format('select app_budget.settle(%L, 121)', pg_temp.rid('key-c-0001'))), 'PT409|settlement_conflict|', 'a different amount is a settlement conflict');
select is(pg_temp.cnt('global', 'spent_micros') || '/' || pg_temp.q(format($$select count(*)::text from app.ai_ledger where reservation_id = %L and kind in ('settle', 'cancel')$$, pg_temp.rid('key-c-0001'))), '120/1', 'never charged twice: spent is still 120 and there is one terminal entry');
select is(pg_temp.bd(format($$select app_budget.cancel(%L, 'never_dispatched')$$, pg_temp.rid('key-c-0001'))), 'PT409|invalid_state|settled', 'a settled reservation cannot be cancelled');
select is(pg_temp.bd(format($$select app_budget.mark_unknown(%L, 'timeout')$$, pg_temp.rid('key-c-0001'))), 'PT409|invalid_state|settled', 'nor marked unknown');
select is(pg_temp.bd(format('select app_budget.settle(%L, -1)', pg_temp.rid('key-c-0001'))), 'PT422|invalid_amount|', 'a negative actual cost is invalid');
select is(pg_temp.bd('select app_budget.settle(''99999999-9999-4999-8999-999999999999'', 1)'), 'PT404|not_found|', 'an unknown reservation is not found');
select is(pg_temp.q(format('select (resolved_at is not null and budget_day = (clock_timestamp() at time zone ''UTC'')::date)::text from app.ai_reservations where id = %L', pg_temp.rid('key-c-0001'))), 'true', 'the settlement time is recorded and the budget day is the reservation''s');
-- the freed budget is usable again (only the UNUSED part came back)
select is(pg_temp.bd(pg_temp.res('key-e-0001', 'summarize', 's1', 180)), 'ok', 'the released 180 can be reserved again (summarize: 300 held + 120 spent + 180 = 600)');
select is(pg_temp.bd(pg_temp.res('key-e-0002', 'summarize', 's1', 1)), 'PT409|budget_refused|global_budget_exhausted', 'but not a unit more: the spent 120 stays spent (here the global total, 700 held + 180 + 120 spent, is full as well)');

-- ===================================================================================================================
-- F. overrun: the full cost is recorded, flagged, and the budget refuses more
-- ===================================================================================================================
select is(pg_temp.bv(format('select (app_budget.settle(%L, 500)) ->> ''overrun_micros''', pg_temp.rid('key-c-0004'))), '100', 'a classify reservation of 400 that actually cost 500: overrun 100');
select is(pg_temp.cnt('classify', 'spent_micros') || '/' || pg_temp.cnt('classify', 'overrun_micros') || '/' || pg_temp.cnt('classify', 'reserved_micros'), '500/100/0', 'the FULL 500 is recorded as spent (nothing clipped), the overrun is flagged, the hold is gone');
select is(pg_temp.q(format($$select overrun_micros::text || '/' || released_micros::text from app.ai_ledger where reservation_id = %L and kind = 'settle'$$, pg_temp.rid('key-c-0004'))), '100/0', 'the ledger entry flags the overrun and releases nothing');
select is(pg_temp.cnt('global', 'spent_micros') || '/' || pg_temp.cnt('global', 'overrun_micros'), '620/100', 'global spent 620 (120 + 500), overrun 100');
select is(pg_temp.bd(pg_temp.res('key-f-0001', 'classify', 's1', 1)), 'PT409|budget_refused|global_budget_exhausted', 'further reservations are refused: global used 1100 + the held 480... is beyond 1000');
select is(pg_temp.bv('select (app_budget.reconcile_report(null) -> ''overruns'' -> 0 ->> ''overrun_micros'')'), '100', 'and the report lists the overrun');
select is(pg_temp.recon(), 'true', 'the ledger still reconciles after an overrun');

-- ===================================================================================================================
-- G. unknown outcomes keep the money reserved until someone confirms
-- ===================================================================================================================
select is(pg_temp.bv(format($$select (app_budget.mark_unknown(%L, 'timeout')) ->> 'status'$$, pg_temp.rid('key-c-0002'))), 'unknown', 'a timed-out operation is marked unknown');
select is(pg_temp.cnt('summarize', 'reserved_micros'), '480', 'its 300 is STILL reserved (480 = 300 + the re-reserved 180)');
select is(pg_temp.bv(format($$select (app_budget.mark_unknown(%L, 'lease_expired')) ->> 'replayed'$$, pg_temp.rid('key-c-0002'))), 'true', 'marking it unknown again is a no-op (the first reason stands)');
select is(pg_temp.q(format($$select unknown_reason from app.ai_reservations where id = %L$$, pg_temp.rid('key-c-0002'))), 'timeout', 'the original reason is kept');
select is(pg_temp.bd(format('select app_budget.cancel(%L, null)', pg_temp.rid('key-c-0002'))), 'PT422|charge_not_ruled_out|', 'cancel without a confirmation basis is refused');
select is(pg_temp.bd(format($$select app_budget.cancel(%L, 'it_was_probably_fine')$$, pg_temp.rid('key-c-0002'))), 'PT422|charge_not_ruled_out|', 'and so is a basis that is not an allowlisted confirmation');
select is(pg_temp.cnt('summarize', 'reserved_micros') || '/' || pg_temp.q(format('select status from app.ai_reservations where id = %L', pg_temp.rid('key-c-0002'))), '480/unknown', 'a refused cancel leaves the reservation unknown and the money held');
select is((select jsonb_array_length(pg_temp.bv('select app_budget.outstanding()')::jsonb)), 2, 'outstanding() lists the unknown reservation and the still-reserved one');
select is(pg_temp.bd(format($$select app_budget.mark_unknown(%L, 'because')$$, pg_temp.rid('key-e-0001'))), 'PT422|invalid_content|reason', 'an unknown-outcome reason must be allowlisted');
-- recovery path 1: the provider confirms it was charged -> settle
create temp table t_u1 as select pg_temp.rid('key-c-0002') as id;
grant all on t_u1 to public;
select is(pg_temp.bv(format('select (app_budget.settle(%L, 250)) ->> ''status''', (select id from t_u1))), 'settled', 'recovery: an unknown reservation the provider charged is settled at the actual cost');
select is(pg_temp.cnt('summarize', 'reserved_micros') || '/' || pg_temp.cnt('summarize', 'spent_micros'), '180/370', 'summarize: 180 held, 370 spent (120 + 250); the 300 hold ended with only the unused 50 released');
-- recovery path 2: confirmed no charge -> cancel releases the full hold
select is(pg_temp.bv(format($$select (app_budget.mark_unknown(%L, 'process_crash')) ->> 'status'$$, pg_temp.rid('key-e-0001'))), 'unknown', 'another operation: process crash -> unknown');
select is(pg_temp.bv(format($$select (app_budget.cancel(%L, 'provider_confirmed_no_charge')) ->> 'status'$$, pg_temp.rid('key-e-0001'))), 'cancelled', 'recovery: confirmed not charged -> cancelled');
select is(pg_temp.cnt('summarize', 'reserved_micros') || '/' || pg_temp.cnt('global', 'reserved_micros'), '0/0', 'the full 180 hold is released');
select is(pg_temp.bv(format($$select (app_budget.cancel(%L, 'never_dispatched')) ->> 'replayed'$$, pg_temp.rid('key-e-0001'))), 'true', 'cancelling again releases nothing more');
select is(pg_temp.bd(format('select app_budget.settle(%L, 10)', pg_temp.rid('key-e-0001'))), 'PT409|invalid_state|cancelled', 'a cancelled reservation cannot be settled');
select is(pg_temp.q(format($$select count(*)::text from app.ai_ledger where reservation_id = %L and kind in ('settle', 'cancel')$$, pg_temp.rid('key-e-0001'))), '1', 'one terminal entry');
select is(pg_temp.recon(), 'true', 'reconciles after the recoveries');

-- ===================================================================================================================
-- H. UTC rollover: yesterday's obligations stay on yesterday's books; today starts with its own counters
-- ===================================================================================================================
select pg_temp.owner_run($$update app.ai_budget_global set daily_limit_micros = 5000$$);
select pg_temp.owner_run($$update app.ai_operation_types set daily_limit_micros = 5000, max_charge_micros = 1000 where op_type = 'summarize'$$);
select is(pg_temp.bd(pg_temp.res('key-h-0001', 'summarize', 's1', 700, (current_date - 1)::text)), 'ok', 'an operation reserved yesterday (UTC)');
select pg_temp.owner_run(format($$select app_budget.mark_unknown(%L, 'timeout')$$, pg_temp.rid('key-h-0001')));
select is(pg_temp.cnt('global', 'reserved_micros', (current_date - 1)::text), '700', 'yesterday''s counters carry it');
select is(pg_temp.cnt('global', 'reserved_micros', (current_date)::text), '0', 'today''s counters start clean (it is not forgotten, it is on yesterday''s day)');
select is(pg_temp.bd(pg_temp.res('key-h-0002', 'summarize', 's1', 1000)), 'ok', 'today has its own full budget');
select is(pg_temp.bv(format($$select (app_budget.settle(%L, 650)) ->> 'budget_day'$$, pg_temp.rid('key-h-0001'))), (current_date - 1)::text, 'settling today charges the reservation''s day (yesterday)');
select is(pg_temp.cnt('global', 'spent_micros', (current_date - 1)::text) || '/' || pg_temp.cnt('global', 'reserved_micros', (current_date - 1)::text), '650/0', 'yesterday: 650 spent, nothing held');
select is(pg_temp.cnt('global', 'reserved_micros', (current_date)::text) || '/' || pg_temp.cnt('global', 'spent_micros', (current_date)::text), '1000/870', 'today: only today''s own movements (1000 held; 870 = 120 + 500 + 250 settled earlier today); yesterday''s settlement did not touch today');
select is(pg_temp.q(format($$select (resolved_at::date >= budget_day)::text from app.ai_reservations where id = %L$$, pg_temp.rid('key-h-0001'))), 'true', 'the settlement time and the original budget day are both on record');
select is((select jsonb_array_length(pg_temp.bv('select app_budget.outstanding()')::jsonb)), 1, 'outstanding() spans days: only today''s still-held reservation remains');
select is(pg_temp.recon(), 'true', 'reconciles across days');

-- ===================================================================================================================
-- I. immutability and the ledger as the only source of totals
-- ===================================================================================================================
select is(pg_temp.owner_do(format($$update app.ai_reservations set max_charge_micros = 1 where id = %L$$, pg_temp.rid('key-h-0002'))), 'PT409|identity_immutable', 'a reservation''s maximum charge is immutable');
select is(pg_temp.owner_do(format($$update app.ai_reservations set op_type = 'classify' where id = %L$$, pg_temp.rid('key-h-0002'))), 'PT409|identity_immutable', 'and its type');
select is(pg_temp.owner_do(format($$update app.ai_reservations set content_hash = decode(repeat('00', 32), 'hex') where id = %L$$, pg_temp.rid('key-h-0002'))), 'PT409|identity_immutable', 'and its target hash');
select is(pg_temp.owner_do(format($$update app.ai_reservations set status = 'settled', actual_micros = 1, resolved_at = now() where id = %L$$, pg_temp.rid('key-c-0001'))), 'PT409|record_immutable', 'a terminal reservation cannot change');
select is(pg_temp.owner_do(format($$delete from app.ai_reservations where id = %L$$, pg_temp.rid('key-h-0002'))), 'PT409|record_immutable', 'a reservation cannot be deleted');
select is(pg_temp.owner_do('update app.ai_ledger set spent_delta = spent_delta'), 'PT409|record_immutable', 'the ledger cannot be updated');
select is(pg_temp.owner_do('delete from app.ai_ledger'), 'PT409|record_immutable', 'or deleted from');
select is((select count(*)::int from unnest(array['ai_ledger', 'ai_reservations', 'ai_budget_days', 'ai_operation_types', 'ai_budget_global']) t where pg_temp.owner_do('truncate app.' || t) not in ('PT409|truncate_forbidden', '0A000|cannot truncate a table referenced in a foreign key constraint')), 0, 'no budget table can be truncated (by the trigger, or by PostgreSQL where other tables reference it)');
select is(pg_temp.owner_do(format($$insert into app.ai_ledger (reservation_id, kind, budget_day, op_type, reserved_delta, spent_delta, released_micros) values (%L, 'cancel', current_date, 'summarize', -1000, 0, 1000)$$, pg_temp.rid('key-c-0001'))), '23505|duplicate key value violates unique constraint "ai_ledger_one_terminal"', 'a second terminal entry for a settled reservation is impossible at the database (no double release)');
select is(pg_temp.owner_do(format($$insert into app.ai_ledger (reservation_id, kind, budget_day, op_type, reserved_delta, spent_delta) values (%L, 'reserve', current_date, 'summarize', 1, 0)$$, pg_temp.rid('key-h-0002'))), '23505|duplicate key value violates unique constraint "ai_ledger_one_reserve"', 'a second reserve entry for one reservation is impossible');
select is(pg_temp.owner_do($$insert into app.ai_ledger (reservation_id, kind, budget_day, op_type, reserved_delta, spent_delta, released_micros) select id, 'settle', budget_day, op_type, -max_charge_micros, 9, 7 from app.ai_reservations where idempotency_key = 'key-h-0002'$$), '23514|new row for relation "ai_ledger" violates check constraint "ai_ledger_shape"', 'a ledger entry whose released amount is not the unused part is refused (shape check)');
-- the totals follow the ledger even for a direct ledger write, and a direct reserve beyond a limit is refused by the trigger
select pg_temp.owner_run($$update app.ai_budget_global set daily_limit_micros = 1500$$);
select is(pg_temp.bd(pg_temp.res('key-i-0001', 'summarize', 's1', 500)), 'PT409|budget_refused|global_budget_exhausted', 'after lowering the global limit below what today used, more is refused');
select pg_temp.owner_run($$update app.ai_budget_global set daily_limit_micros = 5000$$);
-- reconcile_report catches tampering with the totals
select pg_temp.owner_run($$update app.ai_budget_days set spent_micros = spent_micros + 1 where scope = 'global' and budget_day = (clock_timestamp() at time zone 'UTC')::date$$);
select is(pg_temp.recon(), 'false', 'control: tampering with a running total makes the reconciliation report fail');
select is(pg_temp.bv('select jsonb_array_length(app_budget.reconcile_report(null) -> ''counter_mismatches'')::text'), '1', 'and names exactly that counter');
select pg_temp.owner_run($$update app.ai_budget_days set spent_micros = spent_micros - 1 where scope = 'global' and budget_day = (clock_timestamp() at time zone 'UTC')::date$$);
select is(pg_temp.recon(), 'true', 'restored: reconciles');
-- every kind of mismatch is reported: the reserved total, the overrun total, and a reservation's own balance
select pg_temp.owner_run($$update app.ai_budget_days set reserved_micros = reserved_micros + 1 where scope = 'global' and budget_day = (clock_timestamp() at time zone 'UTC')::date$$);
select is(pg_temp.recon() || '/' || pg_temp.bv('select jsonb_array_length(app_budget.reconcile_report(null) -> ''counter_mismatches'')::text'), 'false/1', 'control: a tampered RESERVED total is reported');
select pg_temp.owner_run($$update app.ai_budget_days set reserved_micros = reserved_micros - 1 where scope = 'global' and budget_day = (clock_timestamp() at time zone 'UTC')::date$$);
select pg_temp.owner_run($$update app.ai_budget_days set overrun_micros = overrun_micros + 1 where scope = 'global' and budget_day = (clock_timestamp() at time zone 'UTC')::date$$);
select is(pg_temp.recon() || '/' || pg_temp.bv('select jsonb_array_length(app_budget.reconcile_report(null) -> ''counter_mismatches'')::text'), 'false/1', 'control: a tampered OVERRUN total is reported');
select pg_temp.owner_run($$update app.ai_budget_days set overrun_micros = overrun_micros - 1 where scope = 'global' and budget_day = (clock_timestamp() at time zone 'UTC')::date$$);
select pg_temp.owner_run('alter table app.ai_reservations disable trigger ai_reservations_guard');
select pg_temp.owner_run(format($$update app.ai_reservations set actual_micros = actual_micros + 1 where id = %L$$, pg_temp.rid('key-c-0001')));
select is(pg_temp.recon() || '/' || pg_temp.bv('select jsonb_array_length(app_budget.reconcile_report(null) -> ''reservation_mismatches'')::text') || '/' || pg_temp.bv('select jsonb_array_length(app_budget.reconcile_report(null) -> ''counter_mismatches'')::text'), 'false/1/0', 'control: a reservation whose recorded cost differs from its ledger is reported on its own (the totals still match)');
select pg_temp.owner_run(format($$update app.ai_reservations set actual_micros = actual_micros - 1 where id = %L$$, pg_temp.rid('key-c-0001')));
select pg_temp.owner_run('alter table app.ai_reservations enable trigger ai_reservations_guard');
select is(pg_temp.recon(), 'true', 'all restored: reconciles');
select is(pg_temp.q(format($$select kind || ':' || basis from app.ai_ledger where reservation_id = %L and kind = 'unknown'$$, pg_temp.rid('key-c-0002'))), 'unknown:timeout', 'the unknown outcome and its reason are in the ledger');
select is((select count(*)::int from pg_trigger t where t.tgrelid = 'app.ai_ledger'::regclass and not t.tgisinternal), 3, 'the ledger carries its append-only, truncate and totals triggers');

select * from finish();
rollback;
