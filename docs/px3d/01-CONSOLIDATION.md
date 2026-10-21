# 01 · Consolidation of the accepted work

Everything below is local. Source of the facts: the review packages and logs delivered during PX-2 and PX-3, the repository itself, and a read-only look at the working tree made while writing this document.

## 1. What has been accepted (local scope only)

| Slice | What it delivers | Accepted for |
|---|---|---|
| UX-08 v2 | The approved experience: The Spark, Hack detail, The Lab, The Reveal, states, in-memory draft with overwrite confirmations | local |
| PX-2a | Identity module: trust tiers T0/T1/T2, redirect rules, password rules, error mapping, throttle building blocks | local |
| PX-2b | Auth handlers (`/auth/**`) on the unmodified Supabase Auth, cookie session, setup marker, bounded Auth calls, invite-only registration | local |
| PX-2c | Designed sign-in, recovery, password-setup and email-link screens; session indicator; sign-out; re-check on focus; draft preserved through Auth outages | local pilot scope |
| PX-3a | Private saved prompts and results: 4 migrations, rollback, 11 member functions, erasure trigger, pgTAP, two-connection concurrency tests | local |
| PX-3b | `mywork` module and `/work/**` handlers: T2 on every private read and write, database guard, write throttle, uniform errors, no private content in logs; the two corrections (availability first; export kind must match) | local |
| PX-3e | The private-preview gate (local): route allowlist and legacy blocking compiled into the build, security headers and noindex, an origin lock, a minimal `/health`, stricter environment validation, a deploy-time environment check; plus the pilot tooling (manifest, exact SQL inventory, apply tool with a rehearsal, RPC and revocation checks) | local (pending review) |
| PX-3c | The saved-work UI: Save, Save this result, My prompts, My results, reopen, delete with cascade warning, export, conflict choices, reconciliation, draft/edit protection, Back → Forward restoration | local pilot scope |

"Local" means: the disposable local Supabase stacks (the F2 stack and the separate pilot stack), a local Next.js build, and a headless Chrome. **Nothing in this table was observed on a hosted system.**

## 2. Validation records

| Slice | Record | Result | Where |
|---|---|---|---|
| Baseline | `main` after PR #1 merge `c423aa4`; main CI run #4 (four jobs: verify on Node 22.23.3, verify on Node 24.21.0, database, server-boundary) | passed (owner-confirmed) | project records |
| PX-2b | `npm run px2b:local`: 34 checks against the real local Auth stack, with a fault-injecting proxy | passed | `PX-2b-review-package-r2b.zip` |
| PX-2c | `scripts/px2c-browser-checks.mjs`: 19 real-Chrome checks, desktop and mobile | passed | `PX-2c-review-package.zip`, `PX-2c-delta-package.zip` |
| PX-3 design | plan, database proposal, rehearsal in a rolled-back transaction (55 checks) | accepted as design | `PX-3-plan-package.zip`, `PX-3-revision-1-package.zip` |
| PX-3a | pgTAP on the pilot stack **and** the official `npm run db:test` on a from-scratch F2 stack: 11 files, **1245 tests**; `scripts/local-px3a-checks.mjs`: **38** checks (real concurrent connections, quotas, committed rollback and re-apply) | passed | `PX-3a-review-package.zip` |
| PX-3b | `scripts/px3b-local-checks.mjs`: **24** real-stack checks with two members; unit and source tests (`mywork`, `work-routes-source`) | passed | `PX-3b-review-package.zip`, `PX-3b-correction-delta.zip` |
| PX-3c | `scripts/px3c-browser-checks.mjs`: 29 journeys defined (S, C, R, M, X, E, K, D, L, F1–F5, B1, B2); the full set ran once at delivery (22/22 at that time) and the later correction passes ran the affected subsets (F1–F5: 5/5; 14-check regression rerun; B1, B2) | passed | `PX-3c-review-package.zip`, `PX-3c-correction-delta.zip`, `PX-3c-second-correction-delta.zip`, `PX-3c-third-correction-delta.zip` |
| PX-3e | `scripts/px3e-local-checks.mjs` (11 checks on real built servers: allowlist, uniform 404, headers, health, origin lock, token never logged, environment check); the existing real-stack scripts re-run on the GATED build: PX-2b 34/34, PX-3b 24/24, PX-2c 19/19, PX-3c 30/30 (incl. no CSP violation); `scripts/pilot-rpc-checks.mjs --local` 7/7; `scripts/pilot-inventory.mjs --local` identical (187 lines); committed PX-3a rollback + `pilot-apply` re-apply rehearsal; pgTAP after the rehearsal 11 files, 1245 tests | passed | `docs/px3d/results/` |
| Unit suite | `npm test` (Node 22.23.3): **537 tests, 532 pass, 0 fail, 5 skipped** (one run, at the first PX-3c correction pass). The run delivered with PX-3c had **519 pass, 1 fail, 5 skipped** (the smoke-harness test, see 04); it is preserved, not replaced | see note | `PX-3c-correction-delta.zip`, `results/` |
| Static | `tsc --noEmit` clean; `eslint . --max-warnings 5` clean (the same 5 pre-existing warnings); working-tree secret scan (`npm run scan:secrets`): **0 findings** (run while writing this document) | clean | this machine |

**Honest gaps in the records** (the second and third PX-3c correction gap was closed by the PX-3e full runs below)
* The full unit suite was run three times during the smoke-test diagnosis (04): attempt 1 **failed** (2 tests, one of them my own new files tripping the secret scan, since fixed; the other a smoke-cleanup test, see 04), attempts 2 and 3 passed (557 and 565 tests, 0 failures, 5 skipped). Four more tests were added after attempt 3 (`pilot-apply`) and were run on their own (4/4). One full run per supported Node version is still part of the consolidation (§4) because the CI matrix covers Node 24.21.0 and this machine did not.
* The **database suites were not re-run after PX-3a** (the database has not changed since; the PX-3c corrections are application-side).
* `npm run scan:gitleaks` (the pinned gitleaks scan) was not run for this document; only the repository's own scanner was.
* Node 24.21.0 is exercised by the CI matrix, not locally.

## 3. State of the working tree

Branch `px2b-auth`, based on `main` at `c423aa4`. **Everything from PX-2b onward is uncommitted**: 17 modified tracked files and 57 untracked top-level paths (excluding the review archives).

| Area | Files |
|---|---|
| Platform and configuration | `src/platform/http/body.ts`, `bounded-fetch.ts` (new); modified: `src/platform/db/{clients,index,types}.ts`, `src/platform/{env,env-validate,server}.ts`, `src/modules/catalog/index.ts`, `src/modules/identity/index.ts`, `app/layout.tsx`, `next.config.js`, `package.json`, `.gitignore` |
| Identity and Auth handlers | `src/modules/identity/*` (8 new files); `app/auth/**` (callback, recovery, session, set-password, sign-in, sign-out, `_server`) |
| Experience and account UI | `src/ui/**` (experience, account, work); `app/(experience)/**`; `app/components/LegacyChrome.tsx` |
| Saved work | `src/modules/mywork/`, `app/work/**` |
| Private-preview gate (PX-3e) | `src/platform/preview-gate.ts`, `next.config.js` (modified), `app/health/route.ts`, `app/gate-blocked/route.ts`, `app/robots.ts`, `src/platform/env.ts` / `env-validate.ts` / `server.ts` (modified), `scripts/check-env.mjs`, `scripts/px3e-local-checks.mjs`, `tests/preview-gate.test.ts`, `eslint.config.mjs` and `.gitignore` (alternative build directories) |
| Pilot tooling | `docs/px3d/pilot-manifest.json`, `pilot-inventory.sql`, `pilot-inventory.expected.txt`, `scripts/pilot-manifest.mjs`, `pilot-inventory.mjs`, `pilot-apply.mjs`, `pilot-rpc-checks.mjs`, `scripts/lib/pilot-plan.mjs`, `tests/pilot-manifest.test.ts`, `tests/pilot-apply.test.ts` |
| Database | `supabase/migrations/20261020090000..090300_px3a_*`, `supabase/rollbacks/20261020090000_px3a_down.sql`, `supabase/tests/database/100_my_work.test.sql`, `010_roles_and_grants.test.sql` (modified) |
| Tests and scripts | 21 test files (17 new, 4 modified); `scripts/{px2b-pilot,px2b-local-checks,px2c-browser-checks,local-px3a-checks,px3b-local-checks,px3c-browser-checks}.mjs`, `scripts/lib/cdp.mjs` |
| Local pilot stack | `supabase-pilot/` (configuration only; the migrations and tests directories are links, listed in `.gitignore`) |
| Documents | `docs/px3/`, `docs/identity/`, `docs/ux/` (11 MB of screenshots), this folder |
| Review archives | 14 `PX-*.zip` files in the repository root (**must not be committed**; move them out or ignore them) |
| Assets | `public/hack/hack-official.png` (1.6 MB): **owner confirmation recorded 2026-10-21**: Alan, the owner, confirmed in the working session that the current official Hack artwork was created from scratch by the HackAss team and authorized its use in HackAss and its publication in the public repository. This covers that one file only; `mascot.png` and the two default avatars (already in the repository) are not covered by it. The review screenshots stay outside the repository |

## 4. Proposed commit slicing (proposal only; nothing is committed)

Create one branch from `main` (`c423aa4`) and commit in dependency order. Because several files were edited by more than one slice (`state.ts` by PX-3c, the inventory and documentation tests by PX-3a, `.gitignore` by PX-2b/PX-3a), the slices follow **dependency**, not the order in which they were written. After each commit the typecheck, lint and the unit suite must pass at that commit (checked in a scratch worktree, one commit at a time).

| Commit | Content |
|---|---|
| C1 | Platform: bounded body reader, bounded fetch, environment and client changes |
| C2 | Identity module, Auth handlers, their tests (PX-2a/2b) |
| C3 | UX-08 v2 experience and its tests |
| C4 | PX-2c account screens, session indicator and coordinator, tests |
| C5 | PX-3a database: 4 migrations, rollback, pgTAP, the inventory and migration-list test updates (including the explicit exclusion of PX-3a from the hosted staging plan) |
| C6 | PX-3b `mywork` module, `/work/**`, tests |
| C7 | PX-3c saved-work UI, tests |
| C8 | Local verification scripts and the pilot-stack tooling (the PX-2b/2c/3a/3b/3c scripts, `px2b-pilot`, `lib/cdp`) |
| C9 | PX-3e: the private-preview gate, environment rules, `/health`, `robots`, the deploy-time environment check and their tests |
| C10 | Pilot tooling: manifest, exact SQL inventory, apply tool, RPC and revocation checks, their tests |
| C11 | Documents (`docs/px3`, `docs/identity`, `docs/px3d`; `docs/ux` screenshots only if the owner wants them in the repository) |

Rules: **merge commit into `main`, never squash or rebase** (the recorded SHAs of earlier milestones must remain reachable); the 14 archives are decided separately (D8); the review screenshots stay outside the public repository; no commit message contains a credential; the secret scanner and gitleaks run on the final tree before any push.

## 5. Review archives (kept outside the repository)
`PX-2b-review-package{,-r2,-r2b}.zip`, `PX-2c-review-package.zip`, `PX-2c-delta-package.zip`, `PX-3-plan-package.zip`, `PX-3-revision-1-package.zip`, `PX-3a-review-package.zip`, `PX-3b-review-package.zip`, `PX-3b-correction-delta.zip`, `PX-3c-review-package.zip`, `PX-3c-correction-delta.zip`, `PX-3c-second-correction-delta.zip`, `PX-3c-third-correction-delta.zip`. Each holds its diff, results and (for UI) screenshots.

## 6. Register of open items

| # | Item | Status | Gate it blocks |
|---|---|---|---|
| 1 | **Intermittent smoke-harness failures** (`tests/smoke-harness.test.ts` "startup timeout…" earlier; `tests/smoke-cleanup.test.ts` "transient zombie EPERM…" in diagnostic attempt 1) | **OPEN, cause not demonstrated**: one complete failure captured (a real `kill EPERM` after the leader was reaped, exit 8 instead of 4, under a machine load average near 15 to 19); not reproduced in 5 artificially loaded runs of the two smoke files or in attempts 2 and 3; details and the proposed hardening in 04 | the final CI / release gate | **Delta (2026-10-21):** a bounded EPERM-retry **hardening** is prepared (04 §5; the cause is still not demonstrated); focused regressions and one full run per supported Node version passed (22.23.3 and 24.21.0: 576 tests, 571 pass, 5 skipped, 0 fail); **CTO disposition: the bounded hardening is accepted for the private pilot; the original cause stays an unresolved follow-up (not claimed fixed); a recurrence must be preserved and investigated.**
| 2 | **F-H9-1**: the hosted transaction pooler discloses whether a login exists (a real worker login and a non-existent one answer differently) | open, confirmed on staging; the hosted verification outcome is "FAILED by design" because of it | owner decision D6. For the pilot: the worker role is created **without a password** and no worker runs, so no worker login can succeed; the disclosure remains observable and is recorded as an accepted exception **only if the owner accepts it** |
| 3 | Full F2 acceptance | open | release |
| 4 | Staging credential disposal and the `hackass-staging` deletion date | open (fixture-secret copies removed; keys not rotated; no deletion date set) | closing the staging record |
| 5 | Artwork rights: `public/hack/hack-official.png` **confirmed and authorized by the owner on 2026-10-21** (created from scratch; use and public-repository publication); `mascot.png` and the default avatars are **still to be confirmed** | partly closed | external testers and any public release |
| 6 | SMTP (custom sender), real HTTPS cookie verification, confirmed hosted settings | open | **external testers** |
| 7 | Hosted behaviour of the PX-3a functions, cross-tab behaviour on hosted, the in-memory throttle on more than one instance | unverified | pilot go-live (03) |
| 8 | Legacy service-role client still present for legacy catalogue/profile routes | contained, not removed; must not be reachable or configured in the pilot | pilot deployment (02 §3, §8) |
| 9 | Privacy text is provisional ("Private to your account; not shared with other members…"); operators with database access and backups are outside the application's restrictions | needs owner/legal wording | external testers |
| 10 | Catalogue query cost bound (F2-E follow-up 1) | the benchmark work is closed as a documented experiment; no further benchmarking was requested | public release |
| 11 | Known product limits: after a session expiry and sign-in the draft is no longer linked to its saved prompt (the next Save creates a new prompt); unsaved result edits survive Back/Forward inside the app but not a reload or a closed tab; the browser Back button is not intercepted | accepted for the local pilot | tester briefing |
| 12 | **Historical record (corrected):** the staging evidence for run `stg-20261017-tls3` was committed **unchanged in `aee5287`**, which is already an ancestor of `main`; P1 (deployment controls) and P2 (credential retirement) remain **accepted**. For the pilot only NEW hosting integrations and deployment behaviour are reviewed (02 §3). A test (`tests/pilot-manifest.test.ts`) asserts that the staging plan still lists exactly the 21 F2 migrations, that the evidence exists, and that `aee5287` is an ancestor | closed |
| 13 | **The hosted runner (`scripts/hosted/*`) is outdated for the pilot; the golden inventory is not.** The golden inventory in `supabase/tests/database/010_roles_and_grants.test.sql` was already extended by PX-3a (120 functions, 28 tables, `app_work`), and the runner's H4 comparison already reads it. What is outdated in the runner: `APP_SCHEMAS` lacks `app_work`; `API_FUNCTIONS` (the OpenAPI allowlist) is the 19 F2 functions; its selftest and counts assume 21 migrations and the `staging` profile names. The pilot therefore uses a **pilot-specific** manifest, exact SQL inventory, apply tool and RPC checks (02 §4) and leaves the runner and the staging records untouched | pilot tooling replaces the runner for the pilot only |
| 14 | One-instance throttle: counters reset on every restart, deploy and crash, and the host overlaps old and new instances during a normal deploy | explicit acknowledgement and a maintenance gate (02 §2.4) | pilot go-live |
| 15 | Origin protection: the chosen host cannot restrict inbound traffic to the edge on its lower plans, so the application enforces an origin lock itself (PX-3e) | implemented locally; verified on real builds | pilot deployment |
