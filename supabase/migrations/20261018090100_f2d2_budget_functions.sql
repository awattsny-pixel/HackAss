-- F2-D2 (2/2): the budget rules and the internal functions (contract: docs/db/f2d2-ai-budgets.md). All in schema app_budget, owner-only, SECURITY DEFINER,
-- search_path empty. LOCK ORDER: counter rows (global, then the operation) for the reservation's day -> the reservation row. mark_unknown moves no money and
-- takes only the reservation row. No submission lock is ever taken (the target is an immutable row).

set local role hackass_owner;

-- ---- guards ---------------------------------------------------------------------------------------------------------------------------
create function app_budget.guard_append_only() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'record_immutable' using errcode = 'PT409';
end
$$;
create trigger ai_ledger_append_only before update or delete on app.ai_ledger for each row execute function app_budget.guard_append_only();
create trigger ai_ledger_no_truncate before truncate on app.ai_ledger for each statement execute function app_content.guard_truncate();
create trigger ai_reservations_no_truncate before truncate on app.ai_reservations for each statement execute function app_content.guard_truncate();
create trigger ai_budget_days_no_truncate before truncate on app.ai_budget_days for each statement execute function app_content.guard_truncate();
create trigger ai_operation_types_no_truncate before truncate on app.ai_operation_types for each statement execute function app_content.guard_truncate();
create trigger ai_budget_global_no_truncate before truncate on app.ai_budget_global for each statement execute function app_content.guard_truncate();

-- a reservation: immutable identity, and only the lawful status moves
create function app_budget.guard_reservation() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then raise exception 'record_immutable' using errcode = 'PT409'; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'reserved' or new.actual_micros is not null or new.overrun_micros <> 0 or new.resolved_at is not null then
      raise exception 'invalid_state' using errcode = 'PT409', detail = 'a reservation is born reserved';
    end if;
    return new;
  end if;
  if (new.id, new.idempotency_key, new.op_type, new.target_kind, new.submission_id, new.version_id, new.content_hash, new.canon_version, new.max_charge_micros, new.budget_day, new.reserved_at)
     is distinct from (old.id, old.idempotency_key, old.op_type, old.target_kind, old.submission_id, old.version_id, old.content_hash, old.canon_version, old.max_charge_micros, old.budget_day, old.reserved_at) then
    raise exception 'identity_immutable' using errcode = 'PT409';
  end if;
  if old.status in ('settled', 'cancelled') then raise exception 'record_immutable' using errcode = 'PT409', detail = 'terminal reservation'; end if;
  if old.status = 'reserved' and new.status not in ('reserved', 'unknown', 'settled', 'cancelled') then raise exception 'invalid_state' using errcode = 'PT409'; end if;
  if old.status = 'unknown' and new.status not in ('unknown', 'settled', 'cancelled') then raise exception 'invalid_state' using errcode = 'PT409', detail = 'unknown -> ' || new.status; end if;
  return new;
end
$$;
create trigger ai_reservations_guard before insert or update or delete on app.ai_reservations for each row execute function app_budget.guard_reservation();

-- the ledger is the only source of the totals: every entry is applied to the global scope and the operation scope of ITS day. Rows are ensured and then locked
-- global first, then the operation (the functions already hold them in that order). A reserve is refused if it would exceed either limit (backstop for any writer).
create function app_budget.apply_ledger() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  g app.ai_budget_global;
  o app.ai_operation_types;
  d app.ai_budget_days;
begin
  if new.reserved_delta = 0 and new.spent_delta = 0 then return null; end if;           -- an 'unknown' marker moves no money
  perform app_budget.lock_scopes(new.budget_day, new.op_type);
  if new.kind = 'reserve' then
    select * into g from app.ai_budget_global; select * into o from app.ai_operation_types where op_type = new.op_type;
    select * into d from app.ai_budget_days where budget_day = new.budget_day and scope = 'global';
    if g.id is null or not g.enabled or d.reserved_micros + d.spent_micros + new.reserved_delta > g.daily_limit_micros then
      raise exception 'budget_refused' using errcode = 'PT409', detail = 'global_budget_exhausted';
    end if;
    select * into d from app.ai_budget_days where budget_day = new.budget_day and scope = new.op_type;
    if o.op_type is null or not o.enabled or d.reserved_micros + d.spent_micros + new.reserved_delta > o.daily_limit_micros then
      raise exception 'budget_refused' using errcode = 'PT409', detail = 'operation_budget_exhausted';
    end if;
  end if;
  update app.ai_budget_days set reserved_micros = reserved_micros + new.reserved_delta, spent_micros = spent_micros + new.spent_delta,
         overrun_micros = overrun_micros + new.overrun_micros, updated_at = pg_catalog.clock_timestamp()
   where budget_day = new.budget_day and scope in ('global', new.op_type);
  return null;
end
$$;
create trigger ai_ledger_apply after insert on app.ai_ledger for each row execute function app_budget.apply_ledger();

-- ---- helpers --------------------------------------------------------------------------------------------------------------------------
create function app_budget.today() returns date
  language sql security definer set search_path = ''
as $$ select (pg_catalog.clock_timestamp() at time zone 'UTC')::date $$;

-- ensure and lock the two counter rows of a day: global first, then the operation. Everything that moves money goes through here before touching a reservation.
create function app_budget.lock_scopes(p_day date, p_op text) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  insert into app.ai_budget_days (budget_day, scope) values (p_day, 'global') on conflict do nothing;
  insert into app.ai_budget_days (budget_day, scope) values (p_day, p_op) on conflict do nothing;
  perform 1 from app.ai_budget_days where budget_day = p_day and scope = 'global' for update;
  perform 1 from app.ai_budget_days where budget_day = p_day and scope = p_op for update;
end
$$;

create function app_budget.reservation_json(r app.ai_reservations, p_replayed boolean) returns jsonb
  language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('reservation_id', r.id, 'status', r.status, 'op_type', r.op_type, 'max_charge_micros', r.max_charge_micros, 'budget_day', r.budget_day,
    'actual_micros', r.actual_micros, 'overrun_micros', r.overrun_micros, 'replayed', p_replayed)
$$;

-- ---- reserve ----------------------------------------------------------------------------------------------------------------------------
create function app_budget.reserve_for_day(p_key text, p_op text, p_submission_id uuid, p_content_hash text, p_max bigint, p_day date) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  s app.submissions;
  r app.ai_reservations;
  g app.ai_budget_global;
  o app.ai_operation_types;
  d app.ai_budget_days;
begin
  if p_key is null or p_key !~ '^[A-Za-z0-9._:-]{8,128}$' then raise exception 'invalid_content' using errcode = 'PT422', detail = 'idempotency_key'; end if;
  if p_op is null or p_op !~ '^[a-z][a-z0-9_]{2,39}$' then raise exception 'invalid_content' using errcode = 'PT422', detail = 'op_type'; end if;
  if p_max is null or p_max < 1 or p_max > 1000000000000 then raise exception 'invalid_amount' using errcode = 'PT422'; end if;
  if p_day is null or p_day < app_budget.today() - 1 or p_day > app_budget.today() + 1 then raise exception 'invalid_content' using errcode = 'PT422', detail = 'day'; end if;
  select * into s from app.submissions x where x.id = p_submission_id;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  perform app_review.verify_binding(s, p_content_hash);                                  -- the named hash = the frozen hash = the recomputed hash
  -- idempotency, before the locks (a replay moves no money and needs no budget)
  select * into r from app.ai_reservations x where x.idempotency_key = p_key;
  if found then return app_budget.replay_or_conflict(r, p_op, s, p_max); end if;
  perform app_budget.lock_scopes(p_day, p_op);
  select * into r from app.ai_reservations x where x.idempotency_key = p_key;            -- again, under the locks: a concurrent twin has committed by now
  if found then return app_budget.replay_or_conflict(r, p_op, s, p_max); end if;
  select * into g from app.ai_budget_global;
  if g.id is null then raise exception 'budget_refused' using errcode = 'PT409', detail = 'global_unconfigured'; end if;
  if not g.enabled then raise exception 'budget_refused' using errcode = 'PT409', detail = 'global_disabled'; end if;
  select * into o from app.ai_operation_types x where x.op_type = p_op;
  if o.op_type is null then raise exception 'budget_refused' using errcode = 'PT409', detail = 'operation_unconfigured'; end if;
  if not o.enabled then raise exception 'budget_refused' using errcode = 'PT409', detail = 'operation_disabled'; end if;
  if p_max > o.max_charge_micros then raise exception 'budget_refused' using errcode = 'PT409', detail = 'amount_over_cap'; end if;
  select * into d from app.ai_budget_days x where x.budget_day = p_day and x.scope = 'global';
  if d.reserved_micros + d.spent_micros + p_max > g.daily_limit_micros then raise exception 'budget_refused' using errcode = 'PT409', detail = 'global_budget_exhausted'; end if;
  select * into d from app.ai_budget_days x where x.budget_day = p_day and x.scope = p_op;
  if d.reserved_micros + d.spent_micros + p_max > o.daily_limit_micros then raise exception 'budget_refused' using errcode = 'PT409', detail = 'operation_budget_exhausted'; end if;
  begin
    insert into app.ai_reservations (idempotency_key, op_type, submission_id, version_id, content_hash, canon_version, max_charge_micros, budget_day)
      values (p_key, p_op, s.id, s.version_id, s.content_hash, s.canon_version, p_max, p_day) returning * into r;
  exception when unique_violation then
    select * into r from app.ai_reservations x where x.idempotency_key = p_key;
    return app_budget.replay_or_conflict(r, p_op, s, p_max);
  end;
  insert into app.ai_ledger (reservation_id, kind, budget_day, op_type, reserved_delta, spent_delta) values (r.id, 'reserve', p_day, p_op, p_max, 0);
  return app_budget.reservation_json(r, false);
end
$$;

create function app_budget.replay_or_conflict(r app.ai_reservations, p_op text, s app.submissions, p_max bigint) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
begin
  if (r.op_type, r.submission_id, r.version_id, r.content_hash, r.canon_version, r.max_charge_micros) is distinct from (p_op, s.id, s.version_id, s.content_hash, s.canon_version, p_max) then
    raise exception 'idempotency_conflict' using errcode = 'PT409';
  end if;
  return app_budget.reservation_json(r, true);
end
$$;

create function app_budget.reserve(p_key text, p_op text, p_submission_id uuid, p_content_hash text, p_max bigint) returns jsonb
  language sql security definer set search_path = ''
as $$ select app_budget.reserve_for_day(p_key, p_op, p_submission_id, p_content_hash, p_max, app_budget.today()) $$;

-- ---- settle / unknown / cancel ----------------------------------------------------------------------------------------------------------
create function app_budget.settle(p_reservation_id uuid, p_actual bigint) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  r app.ai_reservations;
begin
  if p_actual is null or p_actual < 0 or p_actual > 1000000000000 then raise exception 'invalid_amount' using errcode = 'PT422'; end if;
  select * into r from app.ai_reservations x where x.id = p_reservation_id;           -- unlocked: the day and type are immutable
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  perform app_budget.lock_scopes(r.budget_day, r.op_type);
  select * into r from app.ai_reservations x where x.id = p_reservation_id for update;
  if r.status = 'settled' then
    if r.actual_micros <> p_actual then raise exception 'settlement_conflict' using errcode = 'PT409'; end if;
    return app_budget.reservation_json(r, true);
  end if;
  if r.status = 'cancelled' then raise exception 'invalid_state' using errcode = 'PT409', detail = 'cancelled'; end if;
  insert into app.ai_ledger (reservation_id, kind, budget_day, op_type, reserved_delta, spent_delta, overrun_micros, released_micros)
    values (r.id, 'settle', r.budget_day, r.op_type, -r.max_charge_micros, p_actual, greatest(p_actual - r.max_charge_micros, 0), greatest(r.max_charge_micros - p_actual, 0));
  update app.ai_reservations set status = 'settled', actual_micros = p_actual, overrun_micros = greatest(p_actual - r.max_charge_micros, 0), resolved_at = pg_catalog.clock_timestamp()
   where id = r.id returning * into r;
  return app_budget.reservation_json(r, false);
end
$$;

create function app_budget.mark_unknown(p_reservation_id uuid, p_reason text) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  r app.ai_reservations;
begin
  if p_reason is null or p_reason not in ('timeout', 'lease_expired', 'process_crash', 'provider_unreachable', 'other') then raise exception 'invalid_content' using errcode = 'PT422', detail = 'reason'; end if;
  select * into r from app.ai_reservations x where x.id = p_reservation_id for update;   -- moves no money: only the reservation row
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  if r.status = 'unknown' then return app_budget.reservation_json(r, true); end if;
  if r.status <> 'reserved' then raise exception 'invalid_state' using errcode = 'PT409', detail = r.status; end if;
  insert into app.ai_ledger (reservation_id, kind, budget_day, op_type, reserved_delta, spent_delta, basis) values (r.id, 'unknown', r.budget_day, r.op_type, 0, 0, p_reason);
  update app.ai_reservations set status = 'unknown', unknown_reason = p_reason, unknown_at = pg_catalog.clock_timestamp() where id = r.id returning * into r;
  return app_budget.reservation_json(r, false);
end
$$;

create function app_budget.cancel(p_reservation_id uuid, p_basis text) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  r app.ai_reservations;
begin
  if p_basis is null or p_basis not in ('provider_confirmed_no_charge', 'never_dispatched') then raise exception 'charge_not_ruled_out' using errcode = 'PT422'; end if;
  select * into r from app.ai_reservations x where x.id = p_reservation_id;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  perform app_budget.lock_scopes(r.budget_day, r.op_type);
  select * into r from app.ai_reservations x where x.id = p_reservation_id for update;
  if r.status = 'cancelled' then return app_budget.reservation_json(r, true); end if;
  if r.status = 'settled' then raise exception 'invalid_state' using errcode = 'PT409', detail = 'settled'; end if;
  insert into app.ai_ledger (reservation_id, kind, budget_day, op_type, reserved_delta, spent_delta, released_micros, basis)
    values (r.id, 'cancel', r.budget_day, r.op_type, -r.max_charge_micros, 0, r.max_charge_micros, p_basis);
  update app.ai_reservations set status = 'cancelled', cancel_basis = p_basis, resolved_at = pg_catalog.clock_timestamp() where id = r.id returning * into r;
  return app_budget.reservation_json(r, false);
end
$$;

-- ---- reading: reconciliation and outstanding obligations ----------------------------------------------------------------------------------
create function app_budget.reconcile_report(p_day date) returns jsonb
  language sql stable security definer set search_path = ''
as $$
  with v_ledger_scope as (
    select l.budget_day, 'global'::text as scope, sum(l.reserved_delta) as r, sum(l.spent_delta) as s, sum(l.overrun_micros) as o from app.ai_ledger l group by l.budget_day
    union all
    select l.budget_day, l.op_type, sum(l.reserved_delta), sum(l.spent_delta), sum(l.overrun_micros) from app.ai_ledger l group by l.budget_day, l.op_type),
  v_counter_bad as (
    select c.budget_day, c.scope, c.reserved_micros, c.spent_micros, c.overrun_micros, coalesce(x.r, 0) as ledger_reserved, coalesce(x.s, 0) as ledger_spent, coalesce(x.o, 0) as ledger_overrun
      from app.ai_budget_days c left join v_ledger_scope x on x.budget_day = c.budget_day and x.scope = c.scope
     where (p_day is null or c.budget_day = p_day)
       and (c.reserved_micros <> coalesce(x.r, 0) or c.spent_micros <> coalesce(x.s, 0) or c.overrun_micros <> coalesce(x.o, 0))),
  v_res_bad as (
    select r.id, r.status, r.max_charge_micros, r.actual_micros,
           coalesce((select sum(l.reserved_delta) from app.ai_ledger l where l.reservation_id = r.id), 0) as ledger_reserved,
           coalesce((select sum(l.spent_delta) from app.ai_ledger l where l.reservation_id = r.id), 0) as ledger_spent
      from app.ai_reservations r
     where (p_day is null or r.budget_day = p_day)
       and (coalesce((select sum(l.reserved_delta) from app.ai_ledger l where l.reservation_id = r.id), 0) <> case when r.status in ('reserved', 'unknown') then r.max_charge_micros else 0 end
         or coalesce((select sum(l.spent_delta) from app.ai_ledger l where l.reservation_id = r.id), 0) <> case when r.status = 'settled' then r.actual_micros else 0 end)),
  v_over as (select r.id, r.overrun_micros from app.ai_reservations r where r.overrun_micros > 0 and (p_day is null or r.budget_day = p_day))
  select pg_catalog.jsonb_build_object(
    'ok', not exists (select 1 from v_counter_bad) and not exists (select 1 from v_res_bad),
    'counter_mismatches', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c)) from v_counter_bad c), '[]'::jsonb),
    'reservation_mismatches', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(b)) from v_res_bad b), '[]'::jsonb),
    'overruns', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v)) from v_over v), '[]'::jsonb))
$$;

create function app_budget.outstanding() returns jsonb
  language sql stable security definer set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('reservation_id', r.id, 'status', r.status, 'op_type', r.op_type, 'budget_day', r.budget_day,
           'max_charge_micros', r.max_charge_micros, 'unknown_reason', r.unknown_reason) order by r.budget_day, r.reserved_at), '[]'::jsonb)
    from app.ai_reservations r where r.status in ('reserved', 'unknown')
$$;

revoke all on function app_budget.guard_append_only(), app_budget.guard_reservation(), app_budget.apply_ledger(), app_budget.today(), app_budget.lock_scopes(date, text),
  app_budget.reservation_json(app.ai_reservations, boolean), app_budget.reserve_for_day(text, text, uuid, text, bigint, date),
  app_budget.replay_or_conflict(app.ai_reservations, text, app.submissions, bigint), app_budget.reserve(text, text, uuid, text, bigint),
  app_budget.settle(uuid, bigint), app_budget.mark_unknown(uuid, text), app_budget.cancel(uuid, text), app_budget.reconcile_report(date), app_budget.outstanding() from public;

reset role;
