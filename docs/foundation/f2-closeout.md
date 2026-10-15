# F2 closeout: harness diagnosis, reconciled acceptance matrix, build sequence

Branch `f2f-foundation-closeout`, from accepted `cd7b5ca` (F2-E). **This slice changes no database behaviour**: no migration, no function, no grant. It records one test-harness fix, one documentation correction and a row-by-row reconciliation of `docs/foundation/f2-acceptance.md`. Nothing here was pushed, deployed or run against a hosted system.

## 1. Smoke-harness cleanup failure (`kill EPERM`, exit 8 instead of 4)

**Original failure (kept on record).** Fresh-clone verification of `cd7b5ca` on Node 24.21.0: `tests/smoke-harness.test.ts` "request timeout: app answers readiness but hangs on a check request -> exit 4, nothing left running" failed with `8 !== 4`. Harness output: `FAIL request timeout after 1500ms: GET /api/hacks/…`, then `FAIL cleanup failed: app (pid 4875): kill EPERM`. Three reruns in the same clone passed (191/191). Across four runs of that suite, one failed. The failure is **not** erased by the reruns.

**Where the message can come from.** Only `Managed.signalGroup` (`tests/smoke/harness.mjs`) could produce the text `kill EPERM` for a harness child: it rethrew every `process.kill(-pid, sig)` error except `ESRCH`, and `terminate()` was called inside a `.catch` in `run.mjs` that turned the exception into a cleanup failure. `groupAlive()` separately swallowed every error (including `EPERM`) as "not alive".

**Cause established by experiment (Darwin 24.6.0, Node 24).** `/tmp` probe: spawn a detached child (its own process group), `SIGKILL` it from outside, block the parent's event loop so the child stays an unreaped zombie, then signal its group:

```
kill(-pgid, 0)        EPERM
kill(-pgid, SIGTERM)  EPERM
kill(-pgid, SIGKILL)  EPERM
kill(pid, 0)          ok
after the exit is reaped: kill(-pgid, 0) ESRCH
```

On macOS a process group whose only members are zombies rejects every signal, including signal 0, with `EPERM`, although the group belongs to the same user. The state ends as soon as the parent reaps the leader (the `'exit'` event). The harness met that state whenever `terminate()` ran after the app had died but before Node processed the child's exit, and treated it as a failed cleanup although the process was already dead.

**What was not established.** I did not capture the pid or process-table state of the one recorded failure, and 140 runs of the real request-timeout scenario on the old harness (60 unloaded, 80 under 8 busy loops) all exited 4 (the natural window is narrow). So: the defect and its exact error are reproduced deterministically; that the single recorded instance went through this path is an inference from identical message, identical code path and absence of any other source of the message, not an observation. If `kill EPERM` ever recurs after this change the failure now carries the evidence (see below), and the issue should be reopened.

**Fix (`tests/smoke/harness.mjs`, `tests/smoke/run.mjs`).**
* Group signals and probes are classified, never assumed: `sent`/`alive`, `gone` (ESRCH), or the error code. Nothing is thrown past the cleanup report.
* `EPERM` while the leader is **not yet reaped** is the transient zombie window: wait (bounded) for the exit event, then look again. After the reap, ESRCH proves the group is empty.
* `EPERM` (or any other error) that **persists after the leader was reaped** has no explanation: `terminate()` returns `{ ok: false, reason: "process group state unknown after the leader exited: kill EPERM (leader reaped=…, exitCode=…; a permission or system error is not a successful cleanup)" }`. The run exits 8. It is never counted as success.
* `{ ok: true }` still requires the leader exited **and** the group provably gone (ESRCH).
* Request timeouts and cleanup failures stay distinct: a timeout with transient EPERM exits 4; a timeout with persistent EPERM exits 8 and prints both the timeout and the permission error.
* Scope of signals: only `-pid` of a group the harness created (`detached: true` for that child) and signal 0 probes are ever sent. A pid is not reused while its process group has members, and no signal is sent after a probe reports ESRCH; the residual risk (reuse of a pid whose group is already empty between a probe and a signal) is a few microseconds and is unchanged by this fix.
* Test hooks: `killFn` option on `Managed`, `--test-kill-eperm=transient|persistent` on `run.mjs` (the real group is still killed, so nothing leaks).

**Regression tests (`tests/smoke-cleanup.test.ts`, 7 tests), run against the unfixed harness first** (output retained in the review package as `regression-before-fix.out`, not committed): 6 of 7 failed, including the real-zombie test with `Error: kill EPERM`. The seventh (transient EPERM via `killFn`) passed on the old code only because the old `Managed` ignored the `killFn` option; it is kept as a behaviour pin. After the fix all 7 pass, and the 14 existing harness tests still pass.

## 2. Pagination documentation

`docs/db/f2e-public-catalog.md`, "Changes between pages", no longer says a traversal "never returns the same hack twice". `published_at` is the publication transaction's start time (`now()`), not its commit time. A publication that started earlier but committed later (for example a replacement that waited for a lock on the same hack) gets an older timestamp and sorts behind a cursor that has passed it: the traversal skips it, or, for a replacement of a hack already returned, returns the same hack again with a different `version_id`. The document now states the exact guarantees: at most once and one whole version **within a response**, deterministic tie-breaking by `slug`, and **across pages** possible skips and possible repeats, with de-duplication by `slug` for consumers that need it. No pagination code was changed. The claim follows from the schema default and keyset semantics; it was not separately demonstrated by a test.

## 3. Reconciled F2 acceptance matrix

Status vocabulary: **satisfied locally** (evidence on the local stack; hosted behaviour not claimed), **partly** (named gaps), **hosted verification pending**, **implementation missing**, **explicitly deferred**. "Real stack" in the original table means the local Supabase stack; nothing has been verified on a hosted project and no CI run has happened on GitHub (nothing was pushed). Milestones named below are **proposed** (section 5); their order is for review.

| ID | Requirement | Implementation | Evidence | Status | Responsible milestone for the remainder |
|---|---|---|---|---|---|
| G-1 | Replay: apply from empty; re-running the migration runner is safe; no default grants to PUBLIC | 21 migrations in `supabase/migrations`; role creation idempotent | every `supabase db reset` applies all 21 from empty; committed rollback + `migration up` rehearsed for F2-D1, D2, E (`R6`, `R7`, `R8`); no PUBLIC grant (`010`, `tests/f2a-migrations.test.ts`) | **partly**: apply-from-empty and rollback-then-reapply are satisfied locally. **Interpretation (CTO, F2-F review):** the requirement is that invoking the migration runner again applies nothing that the ledger already records; ordinary one-time migrations are not required to tolerate their raw SQL being executed twice, and no such test is needed. What is not yet shown is that second invocation (local `supabase migration up` / `db push` with nothing pending) on a real target | M-HOST (second runner invocation on the hosted staging project; procedure in `docs/hosted/verification-procedure.md`, check H3) |
| G-2 | Grant allowlist: full table/column/routine privilege list for anon, authenticated, hackass_worker equals a golden file | `010_roles_and_grants.test.sql` (functions: owner, definer, search_path, volatility, EXECUTE grantees; tables, schemas, roles); no table or column privilege is granted to any role | golden inventory covers 101 functions and every table; extended in every slice including F2-E; `local-f2a-checks.mjs` catalog facts | **satisfied locally** (there is no column-level grant to list; the golden fails on any drift) | extend per slice |
| G-3 | Privileged-function conformance | owner `hackass_owner` except `app_bridge.session_valid` (pinned exception), SECURITY DEFINER, `search_path=''`, qualified references, guard-first for authenticated api functions | `010` (inventory, qualification regex, guard test); the two public catalog reads are the documented exception to guard-first | **satisfied locally**; the `postgres`-owned bridge on a hosted project is unverified | M-HOST |
| G-4 | Forbidden writes: members, reviewers, anon, worker cannot write risk class, rights reviews, lifecycle, roles, flags, publication pointers, projections | tables are owner-only (RLS, no grants); all writes through staff/member functions | `010`, `020`, `050`, `060`, `070`; real worker login `W5`/`W6`; real-stack check `E4` in `scripts/local-f2e-checks.mjs` (F2-E: anonymous and member table and private-function access refused) | **partly**: satisfied for every table that exists; **flags** and **projections** do not exist | M-AUTO (flags), M-DISCOVERY (projections, if built) |
| I-1a | Frozen children cannot be written, moved | `app_content` guard triggers | `040_content.test.sql` (all 21 attempts, both move directions) | **satisfied locally** | |
| I-1b | Freeze race | row locks in fixed order | `local-f2b-checks.mjs` C1–C6 (36 randomized rounds) | **satisfied locally** | |
| I-1c | Lifecycle vs immutability | lifecycle table separate from content | `040` | **satisfied locally** | |
| I-2 | Pointer ownership; one winner; no deadlock | composite FK `hacks.current_publication_id`, lock order | `060` §E, `local-f2c2-checks.mjs` Y1–Y4 | **satisfied locally** | |
| I-3 | Direct RPC authorization with genuine JWTs: signed-out, banned/deleted, removed staff, aal1, stale MFA | `app_guard.require_member/require_staff` in each consequential function | `020` matrix; real tokens in `local-f2a/f2b/f2c/f2c2-checks.mjs`; stale MFA by real 15-minute-old token never exercised (claims level only) | **satisfied locally** for the functions that exist; **hosted verification pending** (Auth, session bridge); stale-MFA real-token case open | M-HOST |
| I-4a | Subject binding: lease for job A cannot affect B; type X cannot do type Y's effects | `worker.*` functions, lease epoch, `job_assert_lease` | `070` and `local-f2d1-checks.mjs` J2; **only one job type exists** (`publication_recheck`), so the cross-type half cannot be demonstrated | **partly** | M-AI (second job type) |
| I-4b | Minimal content read | `worker.get_job_subject` allowlist | `070`; `W6` (no table privileges) | **satisfied locally** for the one job type | M-AI (golden per new type) |
| I-4c | Fencing for heartbeat, complete, `record_*`, `publish_automated`, budget calls | heartbeat/complete/fail fenced by epoch | `070`, J2 | **partly**: `record_*`/`publish_automated` worker calls and budget calls from a worker do not exist (budget functions are owner-only and not wired to jobs) | M-AI, M-AUTO |
| I-5 | Reservations: expired lease's reservation stays counted; in-flight call after expiry; reconciliation; conservative horizon; 50 parallel never exceed cap | `app_budget.*`, `app.ai_*` tables (F2-D2) | `080_budgets.test.sql`, `local-f2d2-checks.mjs` B1–B5, S1, U1, I1, R7 | **partly**: the accounting (cap under 50 parallel, idempotency, settle/cancel/unknown, reconciliation, UTC rollover) is **satisfied locally**; the lease-linked clauses (reservation tied to a job lease, in-flight provider call after lease expiry, conservative horizon from a lease) have no subject yet because **no AI job or provider integration exists** | M-AI |
| S-1 | Shadow prohibition: PUBLISH shadow decision and crafted `decided_by_kind` cannot publish | `moderation_decisions.decided_by_kind` is checked to be `'human'` only; there is no automated decision path or shadow decision at all | `050` (human path); no test for shadow decisions because none can be written | **implementation missing** (safe by absence: the only entry points are human staff functions) | M-AUTO |
| S-2 | Authority split: human path rejects automated decisions; automated path rejects human decisions, disabled flag, disabled category, elevated risk, unclear rights, later human decision | human path exists; automated path does not | `050`/`060` for the human restrictions (self-review, decision by submitter) | **implementation missing** for the automated path; **explicitly deferred** to M-AUTO | M-AUTO |
| S-3 | Kill switch race | no flag table, no automated publish | none | **implementation missing**; **explicitly deferred** | M-AUTO |
| H-1 | Canonical hash: ≥30 golden vectors in SQL and TypeScript; version/submission/decision mismatch blocks publication | `app_content` canonical functions, `tests/hashcanon.test.ts`, `docs/db/hashcanon-1.md` | 36 vectors in `030_hashcanon_vectors.test.sql` and `tests/hashcanon.test.ts`; hash binding in `050`, `060`, `090` | **satisfied locally** | |
| P-1 | Public surface equals documented contract: published projection, categories, counts view, public profiles projection, public collections, search functions; no grant on profiles | `api.list_public_hacks`, `api.get_public_hack` (F2-E); no other anonymous-readable object | `090`, E1–E8 (anon EXECUTE = exactly 2 functions; 0 table grants) | **partly**: hacks list/detail **satisfied locally**; the **categories**, **counts**, **public profiles**, **public collections** and **search** surfaces and a **published projection** are **not built** (the catalog reads live tables); catalog cost is unbounded (section 4) | M-DISCOVERY (categories, counts, search, performance bound/projection); M-PROFILES (profiles, collections) |
| R-1 | Rights: multiple claims; publication stores rights snapshot (claim hashes, review ids, evidence hashes) that survives later review changes | `app.publication_rights`, `HACKASS-PUB-1` snapshot, evidence-note hash at commit | `060` (snapshot rebuilt in pgTAP and from the API), D1 backstop tests, `090` §C | **satisfied locally** | |
| Generic | containment, privacy and smoke suites green; no schema applied outside migrations; no secret in the repository | `tests/*.test.ts`, `scripts/scan-secrets.mjs`, gitleaks | `npm test` 201/201 at `266ec02` (191 before F2-F plus the 7 `tests/smoke-cleanup.test.ts` tests and 3 documentation tests); `tests/f2a-migrations.test.ts`; gitleaks clean | **satisfied locally**; historic findings are baselined, not retired (see below) | |

### Items called out in the assignment

| Topic | Current state | Status | Responsible milestone and dependency |
|---|---|---|---|
| AI job / budget integration | F2-D2 budget accounting exists, owner-only, **not wired to any capability, job or provider**. No AI job type, no provider code. | implementation missing (foundation present) | M-AI. Depends on M-WORKER (a running worker) and the second job type. |
| Automated-decision restrictions | Only human decisions can be recorded; `decided_by_kind` is constrained to `'human'`; no flags table, no automated publish. S-1 to S-3 have no subject. | implementation missing; explicitly deferred | M-AUTO. Depends on M-AI (an automated reviewer to restrict) and on a flags/kill-switch design. Must not start before the restrictions' tests are written first. |
| Profile and asset references | Unresolved profile/asset references **block approval and publication** (`unresolved_references`) and are hidden by the catalog read. Nothing resolves them, so no member-profile attribution or asset can ever be public. | explicitly deferred (blocking by design) | M-PROFILES for profiles; assets inside M-PROFILES or a separate asset milestone. Depends on a profiles table and storage decisions; the catalog contract already excludes both. |
| Worker execution | The worker role and `worker.*` functions exist and are exercised by tests; **no worker process exists**. Recheck jobs are enqueued but nothing runs them in a deployed system. | implementation missing | M-WORKER. Hosted pooler login for `hackass_worker` is itself unverified (M-HOST). |
| Monitoring and recovery | Expired leases are reclaimable; `reconcile_report` exists for budgets. Nothing sweeps `failed` jobs, alerts on stuck leases, or schedules reconciliation (stated in `docs/db/f2d1-jobs.md`, `f2d2-ai-budgets.md`). | implementation missing | M-WORKER (failed-job monitoring, stale-lease alerting, reconciliation scheduler, rights-expiry recheck scheduling visibility). |
| Contributor pagination | `api.list_my_versions()` returns the newest 100 versions with no cursor (`docs/db/f2b-content.md`). | implementation missing; documented roadmap | M-DISCOVERY (before the contributor UI). Same ordering lesson as the catalog: use a total order with a unique tie-breaker. |
| Catalog performance | Eligibility is evaluated per candidate row; a page of 25 can examine many ineligible rows; no benchmark, index review or bound exists. | follow-up open (accepted risk until public release) | M-DISCOVERY: benchmark at realistic volume, bound rows examined per request (or add a derived, always-revalidated read model that keeps `public_blockers` as the final word), review indexes. Gate: before public release. |
| Hosted verification | Every result so far is from the local stack. Hosted-only unknowns: `postgres`-owned bridge reading `auth.sessions`, triggers on `auth.users`, `hackass_worker` through the pooler, key model, token lifetime, cookie behaviour over HTTPS (`docs/spikes/f1-hosted-spikes.md`: BLOCKED, no staging project or credentials). | hosted verification pending | M-HOST. Needs an authorised staging project and credentials from the owner. |
| GitHub CI | The workflow `.github/workflows/ci.yml` (including the F2 database steps) has **never run on GitHub**: nothing has been pushed. Equivalent steps were run locally on Node 22.23.3 and 24.21.0. | hosted verification pending | M-HOST (first push, first run; expect to fix environment differences). |
| Legacy credential retirement | `docs/security/gitleaks.md`: real credentials exist in git history (`.env` JWTs and a generic key at commits `1307cd0` and `c25e780`), baselined in `.gitleaksignore`; "credential retirement is an owner task". Rotation/revocation has not been done or verified by me. | implementation missing (owner action) | Owner, before any push to a shared remote or public release; M-HOST must confirm the retired keys no longer work. Also consider history rewrite before first push. |
| Other remaining items | G-1 second runner invocation on a real target; stale-MFA with a real token; second job type for I-4a. | open | as in the table above |

## 4. Known limits carried forward (not changed here)

* The catalog's keyset order key is a transaction start time (section 2).
* Catalog cost is proportional to rows examined, including ineligible ones.
* `list_my_versions` has no cursor.
* Hosted behaviour of everything is unverified.

## 5. Proposed milestones and recommended build sequence

Proposed names (for your ordering; none is started):

* **M-HOST**: hosted staging project, first GitHub CI run, hosted spikes S1–S6, pooler worker login, bridge/trigger feasibility, second migration-runner invocation applying nothing, credential retirement confirmed.
* **M-DISCOVERY**: catalog performance bound (benchmark, index review, optional revalidated read model), categories/counts/search surfaces, contributor pagination.
* **M-WORKER**: a worker process, failed-job monitoring and recovery, stale-lease alerting, reconciliation scheduler.
* **M-PROFILES**: profile and asset reference resolution, public profiles and collections.
* **M-AI**: AI job types bound to budget reservations and leases, provider integration, remaining I-4/I-5 clauses.
* **M-AUTO**: flags and kill switch, automated and shadow decisions, S-1 to S-3.

Recommended sequence and why:

1. **M-HOST first (in parallel with 2 where the owner can act).** Every accepted result is local-only; the biggest risks (bridge, pooler, Auth, CI differences) are unknown, and everything later builds on them. Credential retirement is an owner action that should precede the first push.
2. **M-DISCOVERY.** The catalog cost bound and contributor pagination are prerequisites for any UI; categories/counts/search define the public surface that P-1 requires.
3. **UI** can start after step 2 on the public read surface (not part of F2).
4. **M-WORKER.** Nothing runs jobs yet; monitoring is needed before automation depends on jobs.
5. **M-PROFILES** whenever member profiles or assets are wanted (independent of 3–4 except for storage decisions).
6. **M-AI**, then **M-AUTO.** Automation comes last: it depends on a running worker, budgets wired to jobs, and the restrictions tested first.

F2 acceptance as written remains **open**: rows marked partly or missing above, and all hosted verification, are unfinished. Nothing in this slice closes them.

## 6. Corrections after the F2-F review (mhost0-preflight)

Three corrections were carried forward from the F2-F review and applied here: the Generic row's test count (201/201), the explicit identification of `E4` as the F2-E real-stack check, and the G-1 interpretation (a second invocation of the migration runner must apply nothing already recorded; raw double execution of one-time migrations is not required). The hosted preparation for M-HOST is in `docs/hosted/`.
