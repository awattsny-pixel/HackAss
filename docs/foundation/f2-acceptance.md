# F2 acceptance contract — schema core and privileged-function framework

F2 is accepted only when every row below has a passing test run against the **real local Supabase stack** (not an auth
shim) in CI, plus the generic requirements. "Real stack" rows need the Auth service to mint genuine sessions.

| ID | Requirement | Test must show | Real stack |
|---|---|---|---|
| G-1 | Replay | migrations apply from empty, twice-run safe where idempotent; no default grants to `PUBLIC` | no |
| G-2 | Grant allowlist | the full table/column/routine privilege list for `anon`, `authenticated`, `hackass_worker` equals a golden file; any drift fails | no |
| G-3 | Privileged-function conformance | every `SECURITY DEFINER` function: `search_path=''`, no `EXECUTE` for `PUBLIC`/`anon` unless intended, guard as first statement, allowed schema, and owner `hackass_owner` **with exactly one exception**: `app_bridge.session_valid(uuid, uuid)` is owned by `postgres` (the platform does not let `postgres` delegate `USAGE` on schema `auth`, so the application owner cannot read `auth.sessions`); it is pinned by name, signature, owner and grantee (`hackass_owner` only) in the golden inventory, and any other `postgres`-owned function in an application schema fails that test | no |
| G-4 | Forbidden writes | members, reviewers, `anon`, and `hackass_worker` each fail to write risk class, rights reviews, lifecycle/approval state, roles, flags, publication pointers, projections | no |
| I-1a | Frozen children | after freeze, `INSERT`/`UPDATE`/`DELETE` on every hashed child table fails, including moving a child between versions (both directions); unfrozen drafts remain editable | no |
| I-1b | Freeze race | N randomized interleavings of draft writes and `submit_version`: stored hash == recomputed hash of committed rows, and no child row post-dates `frozen_at` | no |
| I-1c | Lifecycle vs immutability | superseding or withdrawing a frozen version succeeds (lifecycle only); content cannot change | no |
| I-2 | Pointer ownership | setting `current_publication_id` to another hack's publication fails at the database; version-belongs-to-hack enforced by composite key; concurrent publish yields one winner, no deadlock (fixed lock order) | no |
| I-3 | Direct RPC authorization | calling each consequential function directly with a JWT: signed-out session, banned/deleted user, removed staff role, `aal1`, and stale MFA are all rejected inside the database | **yes** |
| I-4a | Subject binding | a worker holding a valid lease for job A cannot record any effect on subject B; job type X cannot perform type Y's effects | no |
| I-4b | Minimal content read | `get_job_subject` returns exactly the golden column set for its job type and nothing for other jobs; the worker role has no table privileges | no |
| I-4c | Fencing | expired/re-claimed epoch is rejected for `heartbeat`, `complete_job`, `record_*`, `publish_automated`, budget calls | no |
| I-5 | Reservations | an expired lease's reservation stays counted; the cap holds with an in-flight provider call after expiry; reconciliation settles actual usage; the conservative horizon settles the full amount; 50 parallel reservations never exceed the cap | no |
| S-1 | Shadow prohibition | a `PUBLISH` shadow decision, and a crafted invalid `decided_by_kind`, cannot publish via either entry point | no |
| S-2 | Authority split | the human path rejects automated decisions and self-approval; the automated path rejects human decisions, a disabled flag (read in-transaction), a disabled category, elevated risk, unclear rights, and any later human decision | no |
| S-3 | Kill switch race | concurrent flag disable and automated publish: no publish commits after the disabling transaction commits | no |
| H-1 | Hash | canonical golden vectors (≥ 30) pass in SQL and TypeScript; version/submission/decision hash mismatch blocks publication | no |
| P-1 | Public surface | the anonymous-readable object list equals the documented contract (published projection, categories, counts view, public profiles projection, public collections, search functions); no grant on `profiles` | no |
| R-1 | Rights | multiple claims per version; publication stores the rights snapshot (claim hashes, review ids, evidence hashes) and it survives later review changes | no |

Generic: containment, privacy and smoke suites stay green; no application schema is applied outside migrations; no secret in
the repository (`npm run scan:secrets`).

## F2-A progress (database authority foundations)
| Row | F2-A evidence | Status |
|---|---|---|
| G-1 Replay | the three migrations apply from empty on every `supabase db reset` / `start`; idempotent role creation | partly (no full replay-twice test yet) |
| G-2 Grant allowlist | golden inventory in `supabase/tests/database/010_roles_and_grants.test.sql` (roles, schemas, tables, functions) | done for F2-A objects; extend per slice |
| G-3 Function conformance | owner (`hackass_owner`, except the pinned `app_bridge.session_valid` bridge owned by `postgres`), SECURITY DEFINER, `search_path = ''`, EXECUTE grantees, guard-first body, qualified references (same file) | done for F2-A functions |
| G-4 Forbidden writes | members and `anon`/`service_role`/worker cannot write accounts or staff assignments (`020`, `010`) | done for the two tables |
| I-3 Direct RPC authorization | `020_authorization.test.sql` (claims matrix) and `scripts/local-f2a-checks.mjs` (real JWTs via PostgREST): signed-out unexpired token, missing session, user/session mismatch (claims level), banned/deleted user, disabled account, removed staff, aal1, stale MFA | done locally; hosted pending |
| Worker confinement | `hackass_worker` logs in with a password and can execute only `worker.healthcheck()` | done locally; pooler pending |
| I-1, I-2, I-4, I-5, S-*, H-1, P-1, R-1 | need tables and functions that do not exist yet | not started |

## F2-B progress (content versions, hashing, immutability)
| Row | F2-B evidence | Status |
|---|---|---|
| I-1a Frozen children | `040_content.test.sql`: all 21 child INSERT/UPDATE/DELETE attempts on a frozen version fail; moves out of and into a frozen version fail (both parents judged) | done locally |
| I-1b Freeze race | `scripts/local-f2b-checks.mjs` C1–C6: two real sessions race child writes, draft saves, moves and freezes (incl. 36 randomized rounds); stored hash == recomputed hash always; no deadlock | done locally |
| I-1c Lifecycle vs immutability | `040`: superseding and withdrawing a frozen version succeeds while content stays immutable | done locally |
| H-1 Hash | 36 shared golden vectors, TypeScript and SQL (including through the real tables); the freeze trigger recomputes and refuses a wrong hash; version/**submission** hash agreement. Version-hash vs *decision*-hash needs decisions (F2-C) | partly |
| G-2 / G-3 | golden inventory extended to 14 tables and 33 functions (owner, definer, search_path, volatility, EXECUTE grantees); only `api.*` content functions are executable by `authenticated`; no table privilege for any role | done for F2-B objects |
| G-4 Forbidden writes | members, anon, service_role and the worker have no table access; privileged/unknown fields are rejected by `save_draft` (pgTAP + real JWT) | done for content |
| I-3 | every content function refuses no-claims, signed-out, disabled-account and other-owner callers (pgTAP + real JWT) | done locally |

### F2-B correction round
| Defect found in review | Fix | Evidence |
|---|---|---|
| category slug (hashed) was updatable | slug and id immutable; names editable | `040` H1; check C8 (rename storm during a submit) |
| the 20-draft quota was not atomic | account-row lock, account → hack → version order | `C9` (8 simultaneous creates from 19: exactly 1 succeeds; 8 of 8 succeeded before), `C10` (delete + creates) |
| requirements/tags/assets had no cap; no size cap | `assert_limits` before replacement; DB backstop trigger for the three lists | `040` H2: boundaries for all 7 lists and the document size, canary proves nothing was updated/deleted |
| UUID/digest spelling could differ between hashing and storage | strict lowercase hyphenated UUID / 64 lowercase hex, rejected otherwise, in SQL and TypeScript | 10 rejection vectors (SQL, TypeScript, storage) |
| Roadmap | `list_my_versions()` needs cursor pagination before the contributor UI | documented in `docs/db/f2b-content.md` |

### F2-B correction round 2
| Defect found in review | Fix | Evidence |
|---|---|---|
| child-count backstop took only shared parent locks, so two direct writers could both pass the count | all child operations take `FOR NO KEY UPDATE` on the parent(s), ascending; count read after the lock; one lock mode, no upgrades | `C11` for tags (10), requirements (30), assets (20): racing inserts, racing moves into a nearly full target, move vs insert (11 rows on the old code); `C12` no deadlock: 6 parallel inserts, opposite multi-statement moves, 2 writers + a freeze |
| `delete_draft` locked account and version before the hack | account → hack → version, everything re-read under the locks | `C13` (a transaction holding the hack row then wanting the version: deadlock on the old code, none now) |
| a concurrently deleted draft reported success | `not_found` after the lock for delete, save and submit | `C14` (delete/save/submit after a concurrent delete; hack deleted and hack kept cases) |

## F2-C1 progress (moderation records and human review decisions)
| Row | F2-C1 evidence | Status |
|---|---|---|
| G-2 / G-3 | golden inventory extended to 17 tables, 7 schemas and all review functions (owner, definer, search_path, volatility, EXECUTE grantees); only the six staff functions are executable by `authenticated`; no table privilege for any role | done for F2-C1 objects |
| G-4 Forbidden writes | members, anon, service_role and the worker cannot read or write assessments, rights reviews or decisions (pgTAP, real worker login) | done |
| I-3 Direct RPC authorization | all six staff functions refuse: anon, service_role, no claims, signed-out, disabled account, removed staff role, non-staff member, aal1, no TOTP, stale and future MFA (pgTAP matrix; real tokens for each except stale MFA) | done locally |
| Binding | composite foreign keys to the frozen submission; hash quoted by the reviewer must equal the frozen and the recomputed hash; tampered content blocks every write | done |
| Append-only | UPDATE/DELETE/TRUNCATE refused on all three tables; seq and supersedes_id trigger-assigned | done |
| Approval rules | self-review, missing/prohibited/high-needs-admin assessment, unclear/expired/revoked rights per claim, unresolved profile/asset references, unfrozen content, hash mismatch; DB trigger backstop | done |
| Concurrency | `X1` simultaneous decisions (1 wins, rest `decision_conflict`, chain linear), `X2` approval vs revocation / prohibited assessment (waits, then blocked), `X3` stress across submissions (no deadlock) | done locally |
| S-1 .. S-3 (automated/shadow), publication pointer, worker effects, budgets | not started | out of scope |
