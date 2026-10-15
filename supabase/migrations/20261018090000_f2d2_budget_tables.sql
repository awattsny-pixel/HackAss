-- F2-D2 (1/2): AI spending controls, the records. Everything is owner-only: RLS on, no grant to any role. The contract is docs/db/f2d2-ai-budgets.md.
-- Currency USD, amounts are integers in micro-USD (1 unit = 0.000001 USD), 0 .. 1e12. The budget day is the UTC calendar day.
-- The ledger is append-only and the ONLY source of the running totals (ai_budget_days is maintained by a trigger on the ledger).

create schema app_budget authorization hackass_owner;

set local role hackass_owner;

revoke all on schema app_budget from public;
comment on schema app_budget is 'F2-D2: internal AI budget functions. Owner-only; no role but hackass_owner has USAGE.';

-- ---- configuration -------------------------------------------------------------------------------------------------------------------
create table app.ai_budget_global (
  id                 boolean     primary key default true check (id),                     -- exactly one row can exist
  currency           text        not null default 'USD' check (currency = 'USD'),
  enabled            boolean     not null default false,
  daily_limit_micros bigint      not null check (daily_limit_micros between 0 and 1000000000000),
  updated_at         timestamptz not null default pg_catalog.clock_timestamp()
);
comment on table app.ai_budget_global is 'The global daily AI budget (micro-USD per UTC day). No row, or enabled = false, refuses every reservation.';

create table app.ai_operation_types (
  op_type            text        primary key check (op_type ~ '^[a-z][a-z0-9_]{2,39}$'),
  enabled            boolean     not null default false,
  daily_limit_micros bigint      not null check (daily_limit_micros between 0 and 1000000000000),
  max_charge_micros  bigint      not null check (max_charge_micros between 1 and 1000000000000),
  updated_at         timestamptz not null default pg_catalog.clock_timestamp()
);
comment on table app.ai_operation_types is 'The allowlist of AI operation types, each with its own daily limit and per-reservation cap. Missing or disabled = refused.';

-- ---- reservations ---------------------------------------------------------------------------------------------------------------------
create table app.ai_reservations (
  id               uuid        primary key default pg_catalog.gen_random_uuid(),
  idempotency_key  text        not null unique check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  op_type          text        not null references app.ai_operation_types (op_type) on delete restrict,
  target_kind      text        not null default 'content' check (target_kind = 'content'),
  submission_id    uuid        not null,
  version_id       uuid        not null,
  content_hash     bytea       not null,
  canon_version    smallint    not null,
  max_charge_micros bigint     not null check (max_charge_micros between 1 and 1000000000000),
  budget_day       date        not null,
  status           text        not null default 'reserved' check (status in ('reserved', 'settled', 'cancelled', 'unknown')),
  actual_micros    bigint      check (actual_micros between 0 and 1000000000000),
  overrun_micros   bigint      not null default 0 check (overrun_micros >= 0),
  unknown_reason   text        check (unknown_reason in ('timeout', 'lease_expired', 'process_crash', 'provider_unreachable', 'other')),
  cancel_basis     text        check (cancel_basis in ('provider_confirmed_no_charge', 'never_dispatched')),
  reserved_at      timestamptz not null default pg_catalog.clock_timestamp(),
  unknown_at       timestamptz,
  resolved_at      timestamptz,
  constraint ai_reservations_bound_to_submission foreign key (submission_id, version_id, content_hash, canon_version)
    references app.submissions (id, version_id, content_hash, canon_version) on delete restrict,
  constraint ai_reservations_settled_shape check ((status = 'settled') = (actual_micros is not null)),
  constraint ai_reservations_cancel_shape check ((status = 'cancelled') = (cancel_basis is not null)),
  constraint ai_reservations_resolved_shape check ((status in ('settled', 'cancelled')) = (resolved_at is not null)),
  constraint ai_reservations_unknown_shape check (unknown_reason is null or unknown_at is not null)
);
create index ai_reservations_open on app.ai_reservations (budget_day, op_type) where status in ('reserved', 'unknown');
comment on table app.ai_reservations is 'One logical AI operation: immutable key, type, target (exact frozen submission) and maximum charge; a lifecycle of reserved -> settled | cancelled | unknown.';

-- ---- the ledger (append-only) --------------------------------------------------------------------------------------------------------
create table app.ai_ledger (
  id              uuid        primary key default pg_catalog.gen_random_uuid(),
  seq             bigint      generated always as identity unique,
  reservation_id  uuid        not null references app.ai_reservations (id) on delete restrict,
  kind            text        not null check (kind in ('reserve', 'settle', 'cancel', 'unknown')),
  budget_day      date        not null,
  op_type         text        not null references app.ai_operation_types (op_type) on delete restrict,
  reserved_delta  bigint      not null,
  spent_delta     bigint      not null,
  overrun_micros  bigint      not null default 0 check (overrun_micros >= 0),
  released_micros bigint      not null default 0 check (released_micros >= 0),
  basis           text,
  occurred_at     timestamptz not null default pg_catalog.clock_timestamp(),
  constraint ai_ledger_shape check (
       (kind = 'reserve' and reserved_delta > 0 and spent_delta = 0 and overrun_micros = 0 and released_micros = 0)
    or (kind = 'settle'  and reserved_delta < 0 and spent_delta >= 0 and released_micros = greatest(-reserved_delta - spent_delta, 0) and overrun_micros = greatest(spent_delta + reserved_delta, 0))
    or (kind = 'cancel'  and reserved_delta < 0 and spent_delta = 0 and released_micros = -reserved_delta and overrun_micros = 0)
    or (kind = 'unknown' and reserved_delta = 0 and spent_delta = 0 and overrun_micros = 0 and released_micros = 0))
);
create unique index ai_ledger_one_reserve on app.ai_ledger (reservation_id) where kind = 'reserve';
create unique index ai_ledger_one_terminal on app.ai_ledger (reservation_id) where kind in ('settle', 'cancel');     -- no double charge, no double release
create unique index ai_ledger_one_unknown on app.ai_ledger (reservation_id) where kind = 'unknown';
create index ai_ledger_day on app.ai_ledger (budget_day, op_type);
comment on table app.ai_ledger is 'Append-only accounting events. The running totals are derived from this table only.';

-- ---- running totals per (UTC day, scope) ---------------------------------------------------------------------------------------------
create table app.ai_budget_days (
  budget_day      date        not null,
  scope           text        not null check (scope = 'global' or scope ~ '^[a-z][a-z0-9_]{2,39}$'),
  reserved_micros bigint      not null default 0 check (reserved_micros >= 0),
  spent_micros    bigint      not null default 0 check (spent_micros >= 0),
  overrun_micros  bigint      not null default 0 check (overrun_micros >= 0),
  updated_at      timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (budget_day, scope)
);
comment on table app.ai_budget_days is 'Running totals per UTC day and scope (global or op type). Maintained only by the trigger on ai_ledger.';

alter table app.ai_budget_global   enable row level security;
alter table app.ai_operation_types enable row level security;
alter table app.ai_reservations    enable row level security;
alter table app.ai_ledger          enable row level security;
alter table app.ai_budget_days     enable row level security;

reset role;
