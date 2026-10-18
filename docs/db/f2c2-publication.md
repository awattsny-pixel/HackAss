# F2-C2 — human publication records and withdrawal

Branch `f2c2-publication`, from `1744f1d`. Migrations `20261016090000…090200`. Rollback `supabase/rollbacks/20261016090000_f2c2_down.sql`.
**Out of scope and not built:** public projections or reads, caching, automated publication, jobs, budgets, UI. Publication records are **private**: owner-only tables, RLS on, no grant to any
role, reachable only through three staff functions.

## What exists
| Object | Is | Notes |
|---|---|---|
| `app.publications` | one **immutable** publication of one version | `(version_id, hack_id)` → `hack_versions (id, hack_id)`: a publication's version belongs to its hack. `(submission_id, version_id, content_hash, canon_version)` → `submissions`: the exact frozen hash. `(decision_id, submission_id)` → `moderation_decisions`, `(assessment_id, submission_id)` → `version_assessments`. `unique (decision_id)`: a PUBLISH decision authorizes at most one publication. Carries `published_by`, `publisher_role` (`reviewer` / `admin`, the role held when publishing), `snapshot_format`, `snapshot_text`, `snapshot_hash`. |
| `app.publication_rights` | one row per source claim of the version | `(rights_review_id, submission_id, claim_no, claim_hash)` → `rights_reviews`: the rights review that cleared the claim, and the claim hash it was bound to; `evidence_note_hash` is SHA-256 of the review's evidence note. |
| `app.publication_withdrawals` | the **append-only end** of a publication | `cause` = `staff` (a person withdrew it), `superseded` (a newer version replaced it), `review_change` (later review work made it ineligible; then `blockers` lists why and `trigger_table` / `trigger_id` name the record that did it). |
| `app.hacks.current_publication_id` | **the** pointer | composite foreign key `(current_publication_id, id)` → `publications (id, hack_id)`: it cannot point at another hack's publication. NULL = nothing is published. |

`UPDATE`, `DELETE` and `TRUNCATE` are refused on the three new tables (`PT409 record_immutable` / `truncate_forbidden`; PostgreSQL itself refuses TRUNCATE of `publications` because other tables reference it).
**History is never rewritten:** withdrawing clears the pointer and adds a withdrawal row; the publication, its snapshot and its rights rows stay exactly as they were.
A hack row's `id` and `created_by` are immutable and its `slug` is write-once (assigned by the first publication); the pointer moves only `NULL → a not-withdrawn publication` or
`publication → NULL` after its withdrawal row exists (`app_review.guard_hack`). Two commit-time (deferred constraint) checks: a publication must carry exactly the effective rights rows and a snapshot that
recomputes; a withdrawal must leave nothing pointing at its publication.

## The staff functions (schema `api`, `authenticated` only, all start with `require_staff('reviewer', 15 min)`)
* `publish_version(p_submission_id, p_expected_hash, p_expected_decision_id, p_slug)` — publishes the version of a submission.
* `withdraw_publication(p_publication_id, p_reason_code, p_note)` — ends the **current** publication of a hack.
* `get_publication(p_publication_id)` — staff read of the private record (snapshot text, rights rows, withdrawal, whether it is current).

Authority and identity are exactly as in F2-C1: a live session, an active account, a current database-held staff assignment, `aal2` with TOTP verified within 15 minutes and not in the future; the actor is
always the guard's; no function has a user parameter. Any staff member may withdraw (taking content down is the safe direction); publishing and reading a record follow the self-review rule.

### What `publish_version` rechecks, inside the transaction, under the locks
1. the named hash equals the submission's frozen hash **and** the hash recomputed from the committed rows (`hash_mismatch`);
2. the publisher is current staff and not the submitter or a named member author (`self_review`);
3. the version's lifecycle is `approved` (`invalid_state`);
4. the named decision is the **latest** decision of the submission (`decision_conflict` otherwise — a stale or superseded PUBLISH can never publish, nor can a newer HOLD/REJECT's predecessor), it has not
   been used by another publication (`invalid_state: decision_already_published`), and it is a **human** `PUBLISH` (`decision_not_publish`);
5. every other approval rule, from one definition (`app_review.publication_blockers` = F2-C1's `approval_blockers` plus the decision rules): a current assessment that is not `prohibited` and, if `high`, a
   **publisher who is an admin** (`risk_high_needs_admin`); **every** claim has an effective `clear` rights review that is unexpired **today** and whose claim hash still matches
   (`rights_not_clear:<n>`); no unresolved references (`unresolved_references:profile_id` / `:asset_id`); the PUBLISH decision itself was not made by the submitter or a named author (`decision_self_review`);
6. the first publication of a hack needs a valid, unused slug (`p_slug`; `PT422 invalid_content` / `PT409 slug_taken`); afterwards `p_slug` must be NULL or equal;
7. a **newer** version replaces the current publication atomically (the old one is ended as `superseded` and its version becomes `superseded`); an **older** version cannot replace a newer current one
   (`invalid_state: newer_version_is_current`; withdraw first).

The same checks are repeated by the `BEFORE INSERT` trigger on `publications` for any other writer, and the snapshot is recomputed there.

### Later review work: prevent, or withdraw atomically
Every review write already locks the submission first. After it inserts, an `AFTER INSERT` trigger on `moderation_decisions`, `version_assessments` and `rights_reviews` (`app_review.after_review_write`)
re-evaluates `publication_blockers` for the **current** publication of that submission (publisher as the actor). If anything now blocks it — a REJECT/HOLD/REQUEST_CHANGES decision (`decision_not_publish`),
a prohibited assessment (`risk_prohibited`), a high assessment on a reviewer's publication (`risk_high_needs_admin`), revoked or newly unclear rights (`rights_not_clear:<n>`) — the publication is withdrawn
**in the same transaction** as the review record (`cause = review_change`), the pointer is cleared, and the version goes to `under_review` (the C1 RPC then sets `rejected` for a REJECT). Harmless later work
(a newer clear review, a re-affirming PUBLISH, a calmer assessment) leaves it current. A publish that comes **after** such a write is refused by the checks above. Either order is safe because both serialize on the same locks.

A staff withdrawal sets the version to `withdrawn` (terminal for review: a new version is the way back). A review-change withdrawal returns it to `under_review`, where it can be fixed, re-approved with a **new** PUBLISH
decision and published again as a **new** publication record.

## The snapshot — canonical format `HACKASS-PUB-1`
Text, UTF-8, `\n` line endings, ending with a final `\n`. Every field is encoded as in HashCanon-1: `<byte length of the UTF-8 value>:<value>`, or `-:` for NULL (`fv()` below). UUIDs are lowercase hyphenated text,
digests are 64 lowercase hex characters, integers are ASCII decimals, dates are `YYYY-MM-DD`. Lines, in this order:

```
HACKASS-PUB-1
target;fv(hack_id);fv(version_id);fv(submission_id);fv(content_hash hex);fv(canon_version)
decision;fv(decision_id);fv(decision seq);fv('PUBLISH');fv(decision actor_id)
assessment;fv(assessment_id);fv(assessment seq);fv(risk_class)
publisher;fv(published_by);fv(publisher_role)
rights;<claim_no>;fv(rights_review_id);fv(review seq);fv(claim_hash hex);fv(status);fv(basis_code);fv(expires_on or NULL);fv(SHA-256 hex of the evidence note's UTF-8 bytes)     (one line per claim, ascending claim_no)
```
`snapshot_hash` is SHA-256 over the UTF-8 bytes of `snapshot_text`. The text is **derived only from immutable rows, by id**, so it can be recomputed at any time (`app_review.snapshot_text`) and must equal the stored
text; it names the decision, the assessment, every rights review with its claim hash and evidence-note hash, but contains no evidence note, rationale or timestamp. Later reviews, withdrawals and rights revocations
change what is *effective*, never what a snapshot *says*. Checked by pgTAP (an independent re-implementation of the format in the test) and by a real-token check that rebuilds the text from the API data.

## The lock protocol (publish, withdraw and every review write that can change eligibility)
1. the **submission** row `FOR UPDATE`
2. the **hack** row `FOR NO KEY UPDATE`   (1 and 2 are `app_review.lock_submission`, which every review write already calls first; F2-C2 adds step 2)
3. `version_lifecycle` row(s) `FOR UPDATE`, **ascending `version_id`** when two are needed (a publish that supersedes another version)

Nothing takes a lock earlier in this list while holding a later one. Consequences: two publishes of a hack serialize on the hack row; a publish and any review write of one submission serialize on the submission
row (so a publish sees all or none of a concurrent rejection / revocation / assessment, and a review write sees a committed publication and withdraws it); publish and withdraw of one publication serialize on it.
`withdraw_publication` reads the immutable publication row first (no lock), takes steps 1–2 for *its* submission, then **re-checks under the lock** that it is still current. Freeze (F2-B) holds
account → hack → version rows and only **inserts** the new submission row, so it never waits on step 1; no review or publication function takes account, hack or version-row locks before step 1, so no cycle
exists. **Cost:** review writes of two different versions of the same hack serialize (they share the hack row) — fine at review volume.

Errors: `PT404 not_found`; `PT409 hash_mismatch | invalid_state | decision_conflict | approval_blocked (detail = blockers) | slug_taken | snapshot_mismatch | publication_withdrawn | withdrawal_required | pointer_must_be_cleared | slug_immutable`;
`42501 not_staff | self_review | mfa_required | mfa_stale`; `PT422 invalid_content` (detail = the field).

## Rollback
`supabase/rollbacks/20261016090000_f2c2_down.sql` drops the three api functions, the triggers F2-C2 added to F2-C1 tables and `hacks`, the pointer column and its key, the three publication tables, the keys it added
to the review tables, the F2-C2 internals, and **restores the F2-C1 `lock_submission`**; it un-ledgers its three versions. **It destroys every publication record and the pointer.** Slugs assigned at publication stay on
`hacks`. Local: `supabase stop --no-backup`. Linked project afterwards: `supabase migration repair --status reverted 20261016090000 20261016090100 20261016090200`. Rehearsed in rolled-back transactions by check R4
(alone) and R3/R2/R1 (ahead of the F2-C1, F2-B and F2-A rollbacks).

## Not established
Hosted behaviour (bridge/trigger compatibility, pooler). Stale-MFA with a genuinely 15-minute-old real token (covered with fabricated claims). **Rights that expire *after* publication:** nothing sweeps them yet, so such a
publication stays current until a later review write re-evaluates it or a person withdraws it (the check `publication_blockers` is ready for a future job to call). A publisher whose admin role is later revoked is
re-evaluated only on the next review write. Real resolution of profile and asset references; public reads; automated publication.
