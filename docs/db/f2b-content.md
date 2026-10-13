# F2-B — content versions, canonical hashing and submission immutability

Branch `f2b-content-versions`, from `5ab723f`. Migrations `20261014090000…090300`. Rollback `supabase/rollbacks/20261014090000_f2b_down.sql`.
The hash contract is `docs/db/hashcanon-1.md`. Out of scope and not built: publication, decisions, risk/rights records, AI jobs, budgets, UI.

## Tables (all owner-only, RLS on, no policies, no grants to any role; members and the worker have no direct table access)
`categories`, `hacks` (identity only; slug null until publication; no publication pointer yet), `hack_versions` (content + seal),
`version_lifecycle` (mutable state), `submissions` (immutable), and the seven hashed children `hack_steps`, `hack_materials`,
`hack_requirements`, `version_tags`, `version_attributions`, `source_claims`, `version_assets`. Privileged classification and approval
fields are not columns anywhere in these tables.

## Functions
| Function | Who | Does |
|---|---|---|
| `api.create_draft(hack_id?)` | member | new hack + version 1, or the next revision of the caller's own hack; one open draft per hack; at most 20 open drafts per member |
| `api.save_draft(version_id, content)` | owner | replaces the whole content of an unfrozen draft atomically; strict keys at every level |
| `api.get_version(version_id)` | owner | content, state, stored and computed hash |
| `api.list_my_versions()` | member | the caller's versions |
| `api.submit_version(version_id, expected_hash)` | owner | lock, validate completeness, hash the committed content, compare with `expected_hash`, freeze, create the submission — one transaction |
| `api.delete_draft(version_id)` | owner | removes an unfrozen draft (and its empty hack) |
Every one starts with `app_guard.require_member()`; the actor is derived from the database guard, never from an argument. A version the
caller does not own is `not_found` (PT404), indistinguishable from a missing one. Errors: PT404 not_found; PT409 version_frozen,
hash_mismatch, open_draft_exists; PT422 invalid_content / incomplete_content (detail names a field or constraint, never a value);
PT429 too_many_drafts (PostgREST maps `PTnnn` to HTTP `nnn`).

## Immutability and lock order
* `hack_versions`: after `frozen_at` is set, UPDATE and DELETE are rejected. The only update of an unfrozen row that touches the seal is the
  one-time freeze: seal NULL → set, nothing else changes, and the trigger **recomputes the hash and refuses a different stored value**.
  Identity columns never change. A version cannot be inserted already frozen. TRUNCATE is refused.
* Each hashed child: INSERT, UPDATE and DELETE are rejected when the parent is frozen; an UPDATE that changes `version_id` judges **both** parents.
* `submissions`: append-only. `version_lifecycle`: ordinary updates (superseding/withdrawing a frozen version touches lifecycle only).
* **One lock rule:** version rows are locked in ascending id order. Draft RPCs and the freeze take `FOR UPDATE` on the version row; every child
  trigger takes `FOR SHARE` on each parent it touches, ascending, and reads `frozen_at` after holding the lock. A child write and a freeze therefore
  serialize: either the write commits first and the freeze hashes it, or the freeze commits first and the write is rejected. The freeze
  computes its hash only after the lock, from committed rows.
* Ownership is checked before locking (so a stranger cannot make an owner's row wait), then re-established under the lock.

## Decisions made in this slice that the CTO should confirm
* Enumerations the contract left open: `difficulty` easy/moderate/hard; `ai_requirement` none/helpful/required; requirement `kind` tool/skill/account/other;
  attribution `role` author/source_author/contributor/variation_parent; claim `kind` as in the design; currency = ISO-4217-shaped `[A-Z]{3}`.
* Limits (approved): title 120, summary 500, outcome 1000, limitations 2000, step 2000, estimate basis 500, list items as in the tables below.
* Required to submit: category, title, summary, outcome, difficulty, ≥ 1 step, ≥ 1 source claim; a claim of kind third_party_reuse/licensed/permission_granted
  needs a source URL; a cost needs a currency. (Rights *clearance* is a separate staff record, F2-C.)
* `version_attributions.profile_id` and `version_assets.asset_id` have no foreign keys until profiles and the asset store exist.
* `variation_of_hack_id` and `current_publication_id` are deferred to the slices that give them meaning.

## Size limits (enforced before anything is replaced)
`app_content.assert_limits` runs **first** in `write_doc`, before the version row is updated or any child is deleted (a test counts UPDATEs/DELETEs with a
non-transactional canary and shows a rejected save performs none). The whole document may not exceed **131072 bytes** of JSON text (multi-byte text counts in
bytes); then each list is capped:
| List | Max items | Also enforced by |
|---|---|---|
| steps | 50 | `position` check |
| materials | 50 | `position` check |
| requirements | 30 | child guard trigger (count) |
| tags | 10 | child guard trigger (count) |
| attributions | 10 | `attribution_no` check |
| source_claims | 10 | `claim_no` check |
| assets | 20 | child guard trigger (count) |
Error: `PT422 limit_exceeded`, detail = `document` or the list name. Boundary tests cover the cap and cap + 1 for every list and for the document size.

## Quota (twenty open drafts per member) is atomic
`create_draft` and `delete_draft` first lock the member's `accounts` row (`FOR NO KEY UPDATE`, which does not conflict with foreign-key checks),
then count. Lock order everywhere: **account row → hack row → version row**. A create therefore waits for an in-flight delete of the same member and sees only
committed deletions; simultaneous creates cannot all pass the count. Check C9/C10 widen the check-to-insert window with a test trigger so an unserialized
quota overshoots on every run (it did, 8 of 8, before the fix).

## Category slugs are immutable
The category slug is part of the hash, so `app.categories.slug` (and `id`) can never change (`PT409 category_slug_immutable`); display names stay editable; a
category referenced by a version cannot be deleted. Test: submit, attempt a rename, stored hash still equals the recomputed hash; check C8 hammers renames
during a submit.

## Roadmap follow-up (not built)
`api.list_my_versions()` returns only the newest 100 versions with **no cursor**. Before the contributor UI depends on it, add deterministic cursor
pagination (stable order on `(created_at desc, id desc)`, an opaque signed cursor, a bounded page size, and tests for inserts and deletes between pages).

## Rollback
`supabase/rollbacks/20261014090000_f2b_down.sql` (drops the six api functions, the twelve content tables, schema `app_content`, and the four ledger rows;
**destroys all content**). Local: `supabase stop --no-backup`. Linked project: afterwards `supabase migration repair --status reverted
20261014090000 20261014090100 20261014090200 20261014090300`. Rehearsed in rolled-back transactions by checks R1 (F2-B then F2-A) and R2.

## Not established
Hosted behaviour; invariants that need later tables (I-2 publication pointer, I-4 worker effects, I-5 budgets, S-*, R-1); load behaviour of the
`FOR SHARE` child triggers on very large drafts.
