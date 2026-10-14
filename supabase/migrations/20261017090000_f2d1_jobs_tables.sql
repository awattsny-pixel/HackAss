-- F2-D1 (1/3): durable jobs. One owner-only table, app.jobs: an explicit job type, its target, a status, a retry count, an availability time, a lease
-- expiry and a monotonically increasing LEASE EPOCH. Nothing here is granted to any role. The restricted worker reaches it only through the five
-- functions of the third migration, which take a job id and an epoch and never a target or a type.
-- The only job type is 'publication_recheck' (target: one publication). A new type adds its own target column, its own check and its own effect.
-- Also: publication withdrawals learn a fourth cause, 'recheck' (made by the system, so no staff actor), and the history rows keep their meaning.
-- (The rollback leaves those relaxed constraints in place: withdrawal rows made by a recheck must keep their history.)

set local role hackass_owner;

create table app.jobs (
  id                    uuid        primary key default pg_catalog.gen_random_uuid(),
  job_type              text        not null check (job_type in ('publication_recheck')),
  target_publication_id uuid        not null references app.publications (id) on delete restrict,
  status                text        not null default 'queued' check (status in ('queued', 'leased', 'succeeded', 'failed')),
  retry_count           integer     not null default 0 check (retry_count >= 0),
  max_attempts          integer     not null default 5 check (max_attempts between 1 and 20),
  available_at          timestamptz not null default pg_catalog.now(),
  lease_expires_at      timestamptz,
  lease_epoch           bigint      not null default 0 check (lease_epoch >= 0),
  last_error_code       text        check (last_error_code in ('transient', 'internal', 'lease_expired')),
  outcome               text        check (outcome in ('withdrawn', 'still_eligible', 'not_current')),
  created_at            timestamptz not null default pg_catalog.now(),
  updated_at            timestamptz not null default pg_catalog.now(),
  completed_at          timestamptz,
  constraint jobs_lease_shape check ((status = 'leased') = (lease_expires_at is not null)),
  constraint jobs_leased_has_epoch check (status <> 'leased' or lease_epoch >= 1),
  constraint jobs_outcome_only_when_succeeded check ((status = 'succeeded') = (outcome is not null)),
  constraint jobs_completed_when_terminal check ((status in ('succeeded', 'failed')) = (completed_at is not null))
);
-- at most one ACTIVE job per (type, target): duplicate scheduling is a no-op, duplicate delivery is handled by the epoch
create unique index jobs_one_active on app.jobs (job_type, target_publication_id) where status in ('queued', 'leased');
create index jobs_claim_queued on app.jobs (job_type, available_at) where status = 'queued';
create index jobs_claim_expired on app.jobs (job_type, lease_expires_at) where status = 'leased';
comment on table app.jobs is 'Durable jobs for the restricted worker. Owner-only. lease_epoch only ever grows; every worker operation names (job id, epoch) and fails closed on any mismatch or expiry.';
alter table app.jobs enable row level security;

-- the system can end a publication (a recheck), so a withdrawal row may have no staff actor
-- Re-runnable: after the F2-D1 rollback these four constraints are still there (deliberately retained), so each is dropped if it exists and added again.
alter table app.publication_withdrawals drop constraint if exists publication_withdrawals_cause_check;
alter table app.publication_withdrawals drop constraint if exists publication_withdrawals_trigger_table_check;
alter table app.publication_withdrawals drop constraint if exists withdrawals_recheck_names_job;
alter table app.publication_withdrawals drop constraint if exists withdrawals_actor_unless_recheck;
alter table app.publication_withdrawals alter column withdrawn_by drop not null;
alter table app.publication_withdrawals add constraint publication_withdrawals_cause_check check (cause in ('staff', 'superseded', 'review_change', 'recheck'));
alter table app.publication_withdrawals add constraint publication_withdrawals_trigger_table_check check (trigger_table in ('moderation_decisions', 'version_assessments', 'rights_reviews', 'jobs'));
alter table app.publication_withdrawals add constraint withdrawals_recheck_names_job check (cause <> 'recheck' or (trigger_table = 'jobs' and trigger_id is not null));
alter table app.publication_withdrawals add constraint withdrawals_actor_unless_recheck check ((cause = 'recheck') = (withdrawn_by is null));

reset role;
