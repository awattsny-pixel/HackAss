# 04 · The intermittent smoke-harness failures: still OPEN

**Status: OPEN. A complete failure has now been captured and narrowed, but the cause is not demonstrated, and a failure that does not reproduce is not resolution.** No harness, stub or test code was changed. This must be closed (cause shown and fixed, or a risk formally accepted) **before the final CI/release gate**.

## 1. What was done (the reduced plan the review asked for)
* Complete failure output captured for every attempt (`docs/px3d/results/smoke-diagnosis/`).
* **At most three diagnostic full-suite attempts; stop at the first failure to investigate it.** Attempt 1 failed, so it was investigated before attempts 2 and 3.
* Investigation of the first failure only: the failing assertion and output, the machine's load and its top consumers, the harness code involved, and **one bounded reproduction** (5 runs of the two smoke files alone under artificial CPU load, stopping at the first failure). No discovery-then-confirmation matrix, no 30-run proof.

## 2. The record

| Attempt | Conditions | Result |
|---|---|---|
| 1 (11:28) | full suite on Node 22.23.3; load average **15.8 / 15.0 / 11.1** on 6 logical CPUs before the run, 18.8 after; a Next.js server at 82% CPU, another project's Python process at 82% and two Chrome processes were running; 7 Docker containers up | **2 failures of 557**: `#445` (the repository secret scan) and `#461` (a smoke-cleanup test) |
| investigation | the two smoke files alone, repeated, under 10 CPU-burner processes added to the machine (load average rose to 153) | 5 runs: **21/21 passed each time** (not reproduced) |
| 2 (11:35) | full suite; load average 18.4 | **557 tests, 552 pass, 0 fail, 5 skipped** |
| 3 (11:51) | full suite after the PX-3e and pilot-tooling tests; load average 8.4 | **565 tests, 560 pass, 0 fail, 5 skipped** |

Earlier history (from the PX-3c packages): one full run failed in `smoke-harness` ("startup timeout…", assertion not captured), 3 reruns gave fail / pass / fail, then a pass; the harness file alone passed 14/14 three times.

## 3. What the captured failure shows
**Failure `#445` was caused by me and is fixed:** my new test and check script contained credential-shaped literals, which the repository's own secret scan (correctly) flagged. The values are now assembled at run time, the scan reports 0 findings, and the test passes. It is unrelated to the smoke harness.

**Failure `#461` is the smoke-harness family.** `tests/smoke-cleanup.test.ts`, "request timeout with a transient zombie EPERM during cleanup still exits 4 (the timeout), nothing left running". Its complete output:
```
FAIL  request timeout after 1500ms: GET /api/hacks/00000000-0000-4000-8000-000000000001
FAIL  cleanup failed: app (pid …): process group state unknown after the leader exited: kill EPERM
      (leader reaped=true, exitCode=128; a permission or system error is not a successful cleanup)
8 !== 4
```
The harness exited **8 (cleanup failed)** instead of **4 (timeout)**, because a **real `kill EPERM`** was seen on the process group **after the leader had already been reaped**.

## 4. Reading of the evidence (a hypothesis, not a finding)
`tests/smoke/harness.mjs` encodes a macOS fact: `kill(-pgid, sig)` returns EPERM while the group's only remaining member is a **zombie** the harness has not yet reaped; the harness retries (`settle`) only while the **leader** is unreaped, and treats EPERM after `exited` as a real failure ("a permission or system error is not a successful cleanup", a rule accepted in F2-F). A zombie **descendant** that was re-parented to `launchd` and is reaped late (the machine was heavily loaded) would produce exactly this message after the leader is reaped. This would also explain the earlier "startup timeout" failure (exit 8 where 3 is expected) and why the same tests pass when the machine is quiet. **It is consistent with the one captured failure; it has not been demonstrated** (no zombie descendant was observed, and a reproduction under artificial load failed).

| Alternative | Why it is not excluded |
|---|---|
| a different macOS or system EPERM source under load | only one failure captured |
| the injected "transient" test double interacting with a real EPERM | the test passes a flag that makes the harness report EPERM once; a real one on top is possible |
| load-induced timing in the first stub-start | the failing assertion was the exit code, not a timing assertion |

## 4b. Disposition (CTO, 2026-10-21)
**Accepted for the private pilot:** the bounded hardening below. **The original cause is recorded as an unresolved follow-up and is not claimed fixed.** The item does not block progress, because cleanup still requires proof that the process group is gone (persistent EPERM still fails cleanup) and both supported-Node full runs passed. **A recurrence must be preserved (complete output and `ps -o pid,ppid,pgid,stat` of the group) and investigated, not rerun until green.**

## 5. The hardening patch (prepared locally; hardening, not a demonstrated fix)
**Status of the claim:** the original cause has **not** been demonstrated. The patch is a bounded tolerance that is consistent with the one captured failure; it is described as **hardening**, and the smoke item stays open until the CTO records its disposition.

**Change (`tests/smoke/harness.mjs`, `Managed.terminate`):** after the process has exited, a group probe that still answers `EPERM` is retried every 50 ms for the **existing `killWaitMs` budget** (the same value that already bounds the other waits; the run's total deadline still applies above it). Cleanup is reported as failed only if `EPERM` **persists** once that budget is spent, with the same message as before. Nothing else changed: a live group, a process that did not exit and any other error are unchanged failures.

**Focused regression (`tests/smoke-cleanup.test.ts`, new test):** (1) a test double that reports `EPERM` for 600 ms **after** the group was killed and the leader reaped, then the real answer, now cleans up successfully within the budget; (2) a double that reports `EPERM` on every group call still **fails** the cleanup (`kill EPERM` in the reason) and the retries stay within the budget (800 ms budget, bounded below 4 s). The two earlier EPERM tests and the harness-level "persistent EPERM exits 8" test are unchanged.

**Results** are in `docs/px3d/results/delta/` (focused regressions first, then one full run per supported Node version, failures preserved and not rerun automatically).

## 6. Acceptance for closing
* The failing assertion has been captured **and** the mechanism is shown (or the owner/CTO records an explicit risk acceptance with the reason).
* If a fix is made: the targeted regression above passes, and the final release checks pass.
* The decision is recorded in the register (01 §6, item 1).

## 7. Why it matters
A suite that sometimes fails for reasons that do not recur weakens the CI gate that every later push and the deployment build depend on, and "rerun until green" is the habit the project's rules forbid. The failures are in tests of the harness's own cleanup, not in application code.
