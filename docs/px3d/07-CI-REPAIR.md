# 07 · CI run #5 on PR #2 (head `06c8092`): the failures, the repairs, and proposed GitGuardian dispositions

Run: https://github.com/awattsny-pixel/HackAss/actions/runs/39642091397 (synthetic merge `3785e70b`). **Preserved as recorded, not rerun.** Results below are local, on the disposable stacks; nothing was pushed, committed or applied.

## 1. What CI reported
| Check | CI result | Cause (reproduced locally) |
|---|---|---|
| Verify, Node 22.23.3 and 24.21.0 | 2 unit tests failed | the fake-API RPC-checker tests still ran the checker's **real local-mode content-check subprocess**, whose default executable is a macOS Docker path; on Linux it failed and the checker (strictly) exited 3 instead of 1 |
| Database | failed at the F2-A rollback rehearsal | PX-3a added a third `hackass_%` trigger (`hackass_work_content_deleted`) and sits above F2-E in the ledger; the rehearsal expected 2 triggers and did not roll PX-3a back. Reproduced with the **original script** on a 25-migration local stack: `before rollback: ... triggers=3 ledger=21` |
| Server boundary | passed | |
| GitGuardian | 3 findings | section 4 |
Not reached by this run, so **unverified by CI**: the production build and smoke checks (verify jobs) and the database stages after F2-A (F2-B to F2-E). The database stages were run locally, see 3.

## 2. Repair 1: the fake-API tests are isolated from Docker; the checker stays strict
* `tests/pilot-rpc-checks.test.ts`: every run of the checker in those tests now sets `DOCKER_BIN` to a stub script (default answer `0`, success). A test asserts the stub is always used and that the test code names no real Docker path. The tests pass with Docker removed from `PATH`.
* `scripts/pilot-rpc-checks.mjs`: the local-mode content check now has **three outcomes that are not conflated**: confirmed none (passes); **confirmed content remaining** (`n > 0`: "saved content CONFIRMED remaining (n row(s))"); and **verification unavailable** (the subprocess failed or returned something unreadable: "the saved-content verification was UNAVAILABLE ... not evidence that content remains, but cleanup is not verified"). **Both of the last two still fail the run (exit 3).** Previously "unavailable" was reported as "saved content remains", which asserted something not established.
* New test: stub reporting 2 rows -> exit 3 with the "CONFIRMED" wording; stub failing -> exit 3 with the "UNAVAILABLE" wording; unreadable output -> exit 3; stub reporting 0 -> verified.

## 3. Repair 2: the database rehearsals know PX-3a
Rolled-back rehearsal (F2-A R1, F2-B R2, F2-C1 R3, F2-C2 R4): PX-3a's rollback is **first** in the dependency chain; expectations are updated (`triggers=3 ledger=25 app_work=1 work_tables=2 work_trigger=1 work_fns=11` before, all zero after; F2-B's expected content tables 26 and its function list include the 11 PX-3a functions). F2-A now asserts the restored state is **exactly equal** to the starting state (not just a pattern). Committed rollback and re-application (F2-D1 R6, the F2-D2 and F2-E rollback checks): PX-3a is rolled back **first** (committed), otherwise `supabase migration up` finds a ledger gap and refuses; the same `migration up` then re-applies everything, PX-3a included. Rehearsals run **only on the disposable local stack**; the rolled-back ones in a transaction that restores the starting state.

Local evidence (`results/ci-repair/`): the original F2-A script reproduces the CI failure; the corrected script passes. Two intermediate failures are preserved with their causes: F2-B R2 (content table count 26 and function list; the same missing PX-3a chain step) and F2-D1 R6 (ledger gap on `migration up`, which left the disposable database half rolled back; the next attempt failed on that broken state and was discarded; the stack was reset from the 25 migrations). **Final run, in CI order on a freshly reset stack:** pgTAP 1245 pass; Auth/session spikes 6/6; F2-A 13/13; F2-B 19/19; F2-C1 7/7; F2-C2 8/8; F2-D1 9/9; F2-D2 11/11; F2-E 9/9; ledger 25 at the end (`final-ci-order/`).

## 4. GitGuardian: proposed dispositions (NOT applied)
The GitGuardian incident pages require a sign-in, so **I could not read its extracted matches**; the check output on GitHub shows only a count. The dispositions below rest on the CTO's inspection of the flagged source plus my reading of the candidate lines; **the extracted matches must be confirmed by someone signed in to GitGuardian before any disposition is applied.**
| Incident | Candidate source | Proposed disposition | Why |
|---|---|---|---|
| 38820122 | `tests/identity-misc.test.ts` line 10 (`validatePassword('correct horse battery')`) | test credential (a sample string with no account) | only exercises the length/character rules |
| 38820123 | `tests/identity-misc.test.ts` line 11 (`validatePassword('abcdefghijkl')`) | test credential | same |
| 38820124 | `src/modules/identity/password.ts` line 16 (the expression comparing a password with the member's email) | false positive | code, not a value; no credential in it |
The check is not disabled and no history is rewritten. Other password-looking strings in the diff are in local-stack check scripts (for example `'initial password 123'`, created only against the disposable stack's synthetic users); if GitGuardian's matches turn out to include those, they get the same "test credential" disposition after the same confirmation.

## 5. Not covered
The production build and smoke checks were not run here (they are part of the Verify jobs and stay unverified until CI runs on the updated branch). No full-suite rerun. The branch is not updated.
