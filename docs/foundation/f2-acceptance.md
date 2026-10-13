# F2 acceptance contract — schema core and privileged-function framework

F2 is accepted only when every row below has a passing test run against the **real local Supabase stack** (not an auth
shim) in CI, plus the generic requirements. "Real stack" rows need the Auth service to mint genuine sessions.

| ID | Requirement | Test must show | Real stack |
|---|---|---|---|
| G-1 | Replay | migrations apply from empty, twice-run safe where idempotent; no default grants to `PUBLIC` | no |
| G-2 | Grant allowlist | the full table/column/routine privilege list for `anon`, `authenticated`, `hackass_worker` equals a golden file; any drift fails | no |
| G-3 | Privileged-function conformance | every `SECURITY DEFINER` function: owner `hackass_owner`, `search_path=''`, no `EXECUTE` for `PUBLIC`/`anon` unless intended, guard as first statement, allowed schema | no |
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
