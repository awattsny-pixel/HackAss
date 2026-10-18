# F2-D1 — durable jobs and restricted worker execution

Branch `f2d1-jobs`, from `60a4745`. Migrations `20261017090000…090300`. Rollback `supabase/rollbacks/20261017090000_f2d1_down.sql`.
**Out of scope and not built:** AI/provider calls, budgets, automated publication, public projections or reads, UI, a worker *process* (the five functions below are the contract a future process will call).
One job type exists: `publication_recheck`.

## The job record (`app.jobs`: owner-only, RLS on, no grant to any role)
`id`, `job_type` (check: `publication_recheck`), `target_publication_id` (foreign key to `publications`; a new job type adds its own target column and check), `status` (`queued` / `leased` / `succeeded` / `failed`),
`retry_count`, `max_attempts` (5), `available_at`, `lease_expires_at`, **`lease_epoch`** (bigint), `last_error_code` (allowlist: `transient`, `internal`, `lease_expired`), `outcome` (`withdrawn` / `still_eligible` / `not_current`), timestamps.
* At most **one active job** per (type, target) (unique partial index): scheduling twice is a no-op.
* Guard trigger: a job is born `queued` at epoch 0; type, target and `max_attempts` never change; the **epoch only grows, by exactly one, and only when a lease is taken**; `succeeded` / `failed` are terminal and immutable;
  no DELETE, no TRUNCATE.
* **Scheduling is automatic and inside the same transaction as the cause:** publishing a version whose effective rights reviews carry an `expires_on` queues a recheck for **the day after the earliest expiry (UTC midnight)**
  (none if nothing expires); a later rights review that makes the earliest expiry sooner pulls a *queued* job earlier (never later; a leased job reschedules itself when it completes). Publications without expiry get no job.

## The worker functions (schema `worker`; EXECUTE only to `hackass_worker`; the role keeps NO table privilege)
Each starts with `if session_user <> 'hackass_worker' then raise 42501 not_worker` (the *login*, which a SECURITY DEFINER function cannot change) and then calls an owner-only function in `app_review`.
| Function | Arguments | Does |
|---|---|---|
| `claim_job(p_job_type)` | the type to look for | leases one due job (`queued` and due, or `leased` and **expired**), `FOR UPDATE SKIP LOCKED` so parallel workers never wait for or double-claim a job; epoch + 1; lease **5 minutes, fixed by the database**; an expired lease counts as an attempt (at `max_attempts` the job is `failed`, `lease_expired`). Returns `{job_id, job_type, lease_epoch, lease_expires_at, attempt}` or null. **Never returns the target.** |
| `heartbeat_job(job_id, lease_epoch)` | job, epoch | extends the lease by 5 minutes |
| `get_job_subject(job_id, lease_epoch)` | job, epoch | the **allowlisted** subject for the job's type. For `publication_recheck`: `job_id, job_type, lease_epoch, publication_id, hack_id, version_id, is_current, next_rights_expiry` — ids, a flag and a date; never content, notes, rationales, names, snapshot text or hashes |
| `complete_job(job_id, lease_epoch)` | job, epoch | runs **this job's type's effect on this job's target**, then marks it `succeeded`, in one transaction |
| `fail_job(job_id, lease_epoch, error_code)` | job, epoch, `transient` / `internal` | back to `queued` with an exponential back-off (30 s × 2^retries, at most 1 h), or `failed` when attempts run out |

**Binding.** Every operation names (job id, epoch) and nothing else that could redirect it: no function takes a target, a type to act on, a lease length or free text. The effect's target is read from the job row.
**Fail closed.** A wrong, replaced, expired, finished or unknown lease is *one* error for all operations and all causes — `PT409 lease_lost` — which leaks nothing about which (no existence oracle). Expiry is checked at the moment of use, not only at claim.
`complete_job` of a lease that was reclaimed (epoch moved on) does nothing at all.

## The effect: `publication_recheck`
Under the existing lock protocol, extended by one step: **submission row → hack row → lifecycle row(s) → job row** (the job row is *last*). `complete` reads the job without a lock to find its target (a job's type and target never change),
takes the protocol's locks for that target, then locks and re-validates the job's lease, and only then runs the effect:
* the publication is **not the current one** (withdrawn, superseded, or replaced) → `not_current`, **nothing changes** (the effect can only end a publication; it never sets or restores a pointer);
* current and `publication_blockers` is empty (the same definition publication used: rights unexpired *today* and claim-hash bound, assessment, authority, references, decision still PUBLISH, hash) → `still_eligible`, and the next recheck is scheduled from the *effective* rights;
* current and something blocks it (typically rights expired) → `withdraw_locked(…, 'recheck', blockers, 'jobs', job id)`: a `publication_withdrawals` row (cause **`recheck`**, the blockers, the job's id, **no staff actor**), pointer cleared, version back to `under_review`. History is preserved: the publication, its snapshot and rights rows are untouched.
Retries and duplicate delivery are harmless by construction: a finished job rejects replays (`lease_lost`); a duplicate job or a job for an old publication finds it `not_current`; the history of a staff / superseded / review-change withdrawal is never rewritten.
`publication_withdrawals` learns the cause `recheck` and `withdrawn_by` may be NULL exactly for it (`(cause = 'recheck') = (withdrawn_by is null)`).

## Also in this slice: the evidence-note-hash backstop (F2-C2 review follow-up)
`check_publication_children` (commit-time) now also compares every stored `publication_rights.evidence_note_hash` with the hash of the referenced review's actual note. Regression: a child row with a zero hash, and one hashing a different note, cannot commit; the correct hash passes the same path.

## The clock and the UTC day (correction)
* **Leases use the wall clock.** `now()` is frozen at transaction start, so a transaction that began before an expiry and then waited (for a lock, a sleep) would still have passed a `now()` comparison. Every deadline in the job logic —
  lease validation, issuance, heartbeat extension, claim eligibility, retry back-off — uses `clock_timestamp()` at the point of use, and `complete_job` checks the lease **after** it holds its locks. A completion that waited past its expiry
  gets `lease_lost` and has no effect; a refused heartbeat never revives an expired lease.
* **Rights expiry is the UTC calendar day.** Scheduling already used UTC midnight; eligibility used `current_date`, which follows the *session* time zone (UTC+14 saw "expires today" as expired; UTC-12 accepted "today" as future). The approval rule,
  the rights-review input check and the commit-time check now use `app_review.utc_today()`.
* **Re-application.** The up migration drops-if-exists and re-adds the four `publication_withdrawals` constraints the rollback deliberately retains, so `rollback` followed by `supabase migration up` works over existing recheck history
  (check R6 does exactly that, with a committed rollback, on the disposable stack).

## Errors
`PT409 lease_lost | invalid_state | epoch_monotonic | identity_immutable | record_immutable`; `PT422 invalid_content` (unknown job type or error code); `42501 not_worker` (any login but `hackass_worker`).

## Rollback
`supabase/rollbacks/20261017090000_f2d1_down.sql` drops the five worker functions, the schedule trigger, the job functions, the `app.jobs` table (**destroying the job history**) and restores the F2-C1 `approval_blockers` / `record_rights_review` and the F2-C2 `after_review_write` / `check_publication_children`, and drops `utc_today`.
The three constraints F2-D1 relaxed on `publication_withdrawals` are **deliberately left relaxed** so withdrawals a recheck already made keep their history. Local: `supabase stop --no-backup`. Linked project afterwards:
`supabase migration repair --status reverted 20261017090000 20261017090100 20261017090200 20261017090300`. Rehearsed by check R5 (alone) and R4/R3/R2/R1 (ahead of the F2-C2, F2-C1, F2-B, F2-A rollbacks).

## Not established
Hosted behaviour, including the worker login through the pooler. A worker process (none exists). Clock skew between a worker and the database does not matter (the database decides every time), but a database clock jump would move leases and expiry together.
**Gate for the catalog slice:** this recheck is *eventual* — if the worker is down, an expired publication stays current until a recheck runs. Public reads MUST check expiry themselves at read time (publication rights unexpired today) so worker downtime cannot expose expired content.
Nothing sweeps `failed` jobs; a failed recheck needs an operator (or a later monitoring slice). Real resolution of profile/asset references; stale-MFA with a real 15-minute-old token.
