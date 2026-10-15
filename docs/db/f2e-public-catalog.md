# F2-E — the public catalog database boundary

Branch `f2e-public-catalog`, from `6c090a7`. **This document is the contract and the eligibility matrix; it was written before the implementation.** Migrations `20261019090000…090100`. Rollback `supabase/rollbacks/20261019090000_f2e_down.sql`.
**Out of scope and not built:** UI, search, ranking or scoring ("top 25"), caching or materialized projections, outcome reporting, any change to how content is published or withdrawn, jobs, AI. Nothing here writes: both functions are `STABLE` (PostgreSQL itself rejects data changes from a stable function) and neither runs, enqueues or depends on a job.

## What is public
Exactly two functions in schema `api`, executable by `anon` and `authenticated` (the same content for both; no caller identity is read), and by nobody else:
* `list_public_hacks(p_limit, p_category, p_difficulty, p_after_published_at, p_after_slug)`
* `get_public_hack(p_slug)`
Everything underneath stays private: the tables keep RLS and have **no** new grant; the internals live in `app_review` and are executable only by `hackass_owner`. Drafts, submissions, reviews, publication records, jobs and budgets are not reachable from these functions' outputs.

## Eligibility: one definition, read time, used by both functions
`app_review.public_blockers(publication_id) → text[]` ({} = publicly readable). It is evaluated **on every read, from the database's current state**: a publication is hidden the moment any row below changes, whether or not a recheck job has run, failed, or exists. It reuses the publication rules (`publication_blockers`, i.e. the ongoing-eligibility half of F2-C2) and adds the structural checks.
| # | Check | Blocker code | Hides when | Source of the rule |
|---|---|---|---|---|
| 1 | the hack's pointer names this publication, and the publication belongs to that hack | `not_current` | never published; replaced (superseded); pointer cleared by a withdrawal | `hacks.current_publication_id` + composite key |
| 2 | the hack has its public slug | `no_slug` | slug not assigned | `hacks.slug` |
| 3 | the publication has not been withdrawn | `withdrawn` | any withdrawal row (staff, superseded, review change, recheck) | `publication_withdrawals` |
| 4 | the version is still approved | `lifecycle_not_approved` | back under review, rejected, withdrawn, superseded | `version_lifecycle` |
| 5 | frozen content still hashes to the publication's recorded hash (canon 1) | `content_hash_mismatch` | any change to the committed content rows | `app_content.version_hash` vs `publications.content_hash` |
| 6 | the snapshot is intact: recomputed from the recorded decision, assessment and rights-review ids it equals the stored text and hash | `snapshot_mismatch` | tampered snapshot or rights rows | `app_review.snapshot_text` |
| 7 | the submission's frozen hash still equals the recomputed hash | `hash_mismatch` | as 5, against the submission | `publication_blockers` |
| 8 | the latest decision is still a human PUBLISH, and its actor was not the submitter or a named author | `decision_not_publish`, `decision_self_review` | a later HOLD / REJECT / REQUEST_CHANGES | `publication_blockers` |
| 9 | the current assessment exists, is not `prohibited`, and if `high` the publisher is (still) an admin | `assessment_missing`, `risk_prohibited`, `risk_high_needs_admin` | a later prohibited or high assessment | `approval_blockers` |
| 10 | every source claim has an effective `clear` rights review bound to the claim's hash, **not expired on the database's current UTC day** | `rights_not_clear:<n>`, `rights_not_clear:none` | revocation, hold, newer unclear review, expiry (by the calendar alone) | `approval_blockers` + `app_review.utc_today()` |
| 11 | no unresolved profile or asset reference | `unresolved_references:profile_id`, `:asset_id` | any member-profile attribution or asset, until resolution exists | `approval_blockers` |
| 12 | the publisher is not the submitter or a named author | `self_review` | n/a for valid data (immutable); kept for defence | `approval_blockers` |
One further code exists only as a defence: `publication_missing` is returned for an id that names no publication (a pointer cannot dangle, so it never reaches a caller). It is treated as ineligible.

**Deliberately NOT checked on read** (they apply only to first publication, and would wrongly hide a live hack): that the PUBLISH decision is *unused* by another publication, that the caller named the expected hash/decision, and that a slug is *free*. The lifecycle check (4) is an ongoing condition, not a first-publish one.
Cheap structural checks (1–4) run first and short-circuit; the content hash and snapshot are recomputed only for rows that pass them. The cost of a list page is therefore proportional to the rows it must examine, including ineligible ones; a later slice may add a derived, always-revalidated read model, but it must keep this definition as the final word.

## The public response (an explicit allowlist, built field by field; whole rows are never serialized)
`get_public_hack(slug)` returns:
```
slug, version_id, published_at,
category { slug, name }, title, summary, outcome, difficulty (easy | moderate | hard),
time_minutes { min, max }, cost { min_cents, max_cents, currency }, estimate_basis, ai_requirement (none | helpful | required), limitations,
steps [ { position, body } ], materials [ { position, name, detail } ], requirements [ { kind, name, detail } ], tags [ slug ],
attributions [ { role, name, url } ],
sources [ { kind, url, author, license, license_version } ]
```
`list_public_hacks` returns `{ items, next_cursor, page_size }`; each item is `slug, version_id, published_at, category { slug, name }, title, summary, difficulty, time_minutes { min, max }, cost { min_cents, max_cents, currency }, ai_requirement`.
Navigation uses `slug`; `version_id` identifies the exact published version for future version-specific outcome reports. **Never exposed:** `hack_id`, `publication_id`, `submission_id`, any account or staff identity, the submitter, review rationales, rights evidence notes or basis codes, decision reasons, hashes, snapshots, job or budget data, drafts, the author's permission and asset-rights notes (author declarations are not clearance), and assets (none can be published yet). Attributions show the declared name and link only; member-profile attributions cannot be public until resolution exists.

## Reading rules
* **Same content for everyone.** `anon` and `authenticated` receive identical results; no function reads the caller's claims.
* **`get_public_hack`:** a missing slug, a malformed slug, and an ineligible hack all return the identical `PT404 not_found` (no existence oracle).
* **`list_public_hacks`:** `p_limit` null = the default 25 (default 25 rows per page), 1…100 as given, above 100 capped at 100, below 1 = `PT422 invalid_content (p_limit)`. `p_category` (a category slug; unknown = empty list, malformed = `PT422`), `p_difficulty` (`easy` / `moderate` / `hard`, else `PT422`). The cursor is both halves or neither (`p_after_published_at`, `p_after_slug`; one alone, or a malformed slug = `PT422 invalid_content (cursor)`).
* **Order and pagination:** newest publication first, `published_at` descending, ties broken by `slug` descending (slugs are unique, so the order is total). Keyset pagination: `next_cursor` = `{published_at, slug}` of the last item, or null at the end; the next request passes it back and receives strictly later rows in that order. Filters apply to the published version's category and difficulty.
* **Changes between pages.** Separate requests are separate snapshots; **no fixed snapshot is promised across pages**. A hack withdrawn or made ineligible between pages disappears; a hack whose publication is replaced moves to the top of the order (its new `published_at`), so a traversal that has not reached it yet will not see it, and one that already saw it will not see it again; a newly published hack appears before every cursor and is not seen by a traversal in progress. A traversal never returns the same hack twice, but may skip some. **Within one request** all rows are read from one snapshot (the functions are `STABLE`, so PostgreSQL gives every statement inside the call the caller's single statement snapshot), so a response never mixes two versions of a hack or lists a publication it has already judged ineligible.

## Rollback
`supabase/rollbacks/20261019090000_f2e_down.sql` drops the two api functions and the internal functions. It touches no table and loses no data; reapplication is rehearsed after a **committed** rollback (check R8) and in the rolled-back chains R1–R5 (F2-E first).

## Not established
Hosted behaviour; query cost at production scale (see above); outcome reporting; search and ranking; caching. The recheck jobs (F2-D1) remain useful but are no longer what keeps expired content hidden: the read is.
