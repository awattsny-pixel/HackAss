# F2-C1 — moderation records and human review decisions

Branch `f2c1-moderation`, from `47410911`. Migrations `20261015090000…090200`. Rollback `supabase/rollbacks/20261015090000_f2c1_down.sql`.
**Out of scope and not built:** publication (an approval is a *record*, nothing becomes public), automated decisions, jobs, budgets, UI.

## Records (all owner-only, RLS on, no grants to any role, append-only)
| Table | One row is | Bound to | Notes |
|---|---|---|---|
| `version_assessments` | a staff risk classification (`low` / `medium` / `high` / `prohibited`) with a rationale | the submission | effective = highest `seq` |
| `rights_reviews` | staff verification of **one source claim** (`clear` / `needs_evidence` / `hold` / `revoked`), basis code, evidence note, optional expiry | the submission **and** the claim (`(version_id, claim_no)` foreign key to `source_claims`) plus `claim_hash`, the SHA-256 of that claim's canonical line | effective = highest `seq` per claim; `clear` needs a basis and a note |
| `moderation_decisions` | a human decision (`PUBLISH` / `REQUEST_CHANGES` / `REJECT` / `HOLD`) with reason codes | the submission | `seq` and `supersedes_id` are assigned by the trigger under the submission lock: one linear chain, no fork (unique successor); non-`PUBLISH` decisions need a reason |

**Binding.** Every record carries `(submission_id, version_id, content_hash, canon_version)` as a composite foreign key to the immutable `submissions` row (new unique key
`submissions_review_binding`), so a review of one hash cannot be attached to another. `UPDATE`, `DELETE` and `TRUNCATE` are refused on all three tables (`PT409 record_immutable` /
`truncate_forbidden`). Authors cannot reach any of this: privileged classification and approval are not content, not hashed, and not writable by members.

## The staff functions (schema `api`, all `authenticated`-executable, all start with `require_staff('reviewer', 15 min)`)
`list_submissions_for_review` (keyset-paginated, oldest first, hides what the caller may not review), `get_submission_for_review` (frozen content, claims and claim hashes, effective
assessment and rights, decision history, unresolved references, the caller's approval blockers), `start_review`, `record_risk_assessment`, `record_rights_review`, `record_decision`.
* **Authority:** a live session, an active account, a **current database-held** staff assignment (reviewer or admin), `aal2` and TOTP verified within 15 minutes and not in the future.
  Removing the assignment, disabling the account or signing out takes effect on the very next call with the same token.
* **Identity:** the reviewer is always the guard's actor. No function has a user or reviewer parameter (a test passes one and gets `42883`).
* **Hash binding:** every write names the content hash the reviewer looked at; it must equal the submission's frozen hash **and** the hash recomputed from the committed rows
  (`PT409 hash_mismatch`, detail says which). Content tampered behind the database's back blocks every review write.
* **Conflict of interest:** the submitter, or anyone named as a member author in the content, cannot read, review or decide that submission (`42501 self_review`); it is also absent from their queue.
* **State:** decisions and reviews need `under_review` (or a later decision state). Lifecycle follows decisions (`PUBLISH`→`approved`, `REJECT`→`rejected`, others keep `under_review`); it is separate from content.
* **Concurrency:** every write locks the submission row first. `record_decision` takes `p_expected_prior_decision_id` (NULL = none yet); if another decision landed, `PT409 decision_conflict`.

## When can a submission be approved? (`app_review.approval_blockers`, one definition used by the RPC, the trigger and the reviewer's view)
`PUBLISH` is refused unless **all** of these hold, and the reason codes are returned: not `self_review`; an assessment exists, is not `prohibited`, and if `high` the caller is an **admin**;
**every** source claim has an effective `clear` rights review that has not expired and whose `claim_hash` still matches (author declarations — even a declared licence — never clear anything);
no **unresolved references**: because profiles and the asset store do not exist yet, any member-profile attribution (`profile_id`) or asset makes a version ineligible
(`unresolved_references:profile_id` / `:asset_id`); a later slice replaces this with real existence checks. The database trigger repeats these rules for any other writer.

Reason codes returned in `approval_blocked` (comma-separated in the error detail) and in `approval_blockers`: `self_review`, `assessment_missing`, `risk_prohibited`,
`risk_high_needs_admin`, `rights_not_clear:<claim_no>` (or `rights_not_clear:none` when a version has no claims), `unresolved_references:profile_id`,
`unresolved_references:asset_id`, `submission_missing`.

## Decisions that are not approvals
`REQUEST_CHANGES`, `REJECT` and `HOLD` need only a reason code and the same authority, hash and conflict checks.

## Rollback
`supabase/rollbacks/20261015090000_f2c1_down.sql` drops the six api functions, the three tables (with their triggers), the binding constraint on `submissions`, schema `app_review`, and the
three ledger rows. **It destroys all assessments, rights reviews and decisions.** Local: `supabase stop --no-backup`. Linked project afterwards: `supabase migration repair --status reverted
20261015090000 20261015090100 20261015090200`. Rehearsed in rolled-back transactions by checks R3 (alone) and R1/R2 (before the F2-B and F2-A rollbacks).

## Not established
Hosted behaviour; stale-MFA with a genuinely 15-minute-old real token (covered with fabricated claims); resolution of profiles and assets; publication, automated decisions, appeals and notifications.
