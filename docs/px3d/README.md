# PX-3d / PX-3e: one consolidated review package for a concrete private-preview operation

**Status after the PX-3e review: the six requested local corrections are made (06); PV-1 remains held.** Local work only, uncommitted. Nothing hosted was contacted; no commit, push, hosted migration, paid provisioning or deployment happened.** Provider facts were read from public pages on 2026-10-21 and are labelled verified / search-result / unverified in 02.

## 1. What is in the package
| Document | Content |
|---|---|
| [00-PX-3e-CHANGES.md](00-PX-3e-CHANGES.md) | The focused changes (allowlist, legacy blocking, environment validation, headers, noindex, health, origin lock), why there is no proxy, build modes, validation results, limits |
| [01-CONSOLIDATION.md](01-CONSOLIDATION.md) | What is accepted, tree state, commit slices C1–C11, register of open items |
| [02-HOSTING-CONFIGURATION-AND-COST.md](02-HOSTING-CONFIGURATION-AND-COST.md) | One concrete configuration (Render Starter + Cloudflare Access + Supabase Pro + Resend), restrictions, database manifest, token-in-logs analysis, cost, external-tester gate |
| [03-HOSTED-CHECKS.md](03-HOSTED-CHECKS.md) | Hosted checks, now RPC-based, with key rotation vs revocation, log (K) and single-process (L) series |
| [04-SMOKE-TEST-DIAGNOSIS.md](04-SMOKE-TEST-DIAGNOSIS.md) | The reduced diagnosis: three attempts, one failure captured, **still open** |
| [05-DEPLOYMENT-AND-ROLLBACK.md](05-DEPLOYMENT-AND-ROLLBACK.md) | Exact deployment and rollback procedure (revised after the PX-3e review: sequence, project binding, maintenance gate, export-before-rollback) |
| [06-DELTA-REVIEW.md](06-DELTA-REVIEW.md) | **Start here for the delta review:** the six corrections, where each is and its evidence |
| `pilot-manifest.json`, `pilot-inventory.sql`, `pilot-inventory.expected.txt`, `results/` | Updated pilot migration/check manifest, exact SQL inventory, evidence logs |

## 2. The five package corrections
| # | Correction | Where |
|---|---|---|
| 1 | Explicit single-process restriction: restart loses counters; Render overlaps old/new instances; maintenance gate during deploys; acknowledged counter resets; shared store deferred | 02 §2.1, 05 §6, 03 L2–L4 |
| 2 | Pilot-specific manifest (25 / 120 / 28), staging history preserved; member access and anonymous denial by **actual RPC calls** plus exact SQL inventory | 02 §4.2, `pilot-*`, 03 P2–P4, O4 |
| 3 | Key rotation separated from session revocation, explicit revocation check; hosting/proxy log suppression of emailed tokens | 02 §6, 03 X3, X5, K1–K4, 05 §8–9 |
| 4 | Historical record: staging evidence committed unchanged in `aee5287` (ancestor of `main`); P1 and P2 stay accepted; review only the new hosting integrations and deployment behaviour | 01 register item 12 |
| 5 | Outdated hosted runner distinguished from the golden inventory already extended by PX-3a | 02 §4.2, 01 item 13 |

## 3. Decisions needed with the one approval (reduced)
| # | Decision |
|---|---|
| D1 | Approve Render (Hobby, Starter) + Cloudflare + Supabase Pro + Resend as in 02, and its cost (about 32 USD a month, plus domain) |
| D2 | The pilot domain/subdomain, which becomes `APP_ORIGIN` exactly |
| D3 | **Written acknowledgement** of the single-process limits (02 §2.1) |
| D4 | Pilot project region; IPv4 add-on only for the migration window |
| D5 | F-H9-1 disposition for the pilot |
| D6 | Who closes access, receives alerts, and sends invitations; number of testers and duration |
| D7 | Merge strategy (merge commit only) and when the smoke diagnosis may continue |
| D8 | Final privacy text, retention and tester terms (provisional text stays until decided) |

## 4. The single private-preview operation proposed for approval
**Operation PV-1: owner-only private preview of the accepted journey.** It covers Stages 0–6 of 05 in order, with a stop and a redacted report at each checkpoint:
1. Local consolidation commits on a branch (no outside effect) → report SHA.
2. CI on that SHA via pull request; merge by merge commit only if green and the smoke item is closed.
3. Owner provisions accounts; the pilot database is migrated (`pilot-apply`, inventory, RPC checks).
4. One instance deployed behind Access and the origin lock, with the maintenance gate.
5. Hosted checks 03; internal preview (owner, CTO).

**Not covered:** external testers (02 §10 is a separate gate), the public release (artwork rights), a shared throttle store, any change to the legacy routes. **Stop conditions:** any failed check, any secret or token appearing in a log, any mismatch of the inventory, a smoke-test flake on the final commit, or a cost above the estimate by more than 25%. Nothing in PV-1 proceeds past a stop without a new decision.

## 5. Honest state
* Smoke-harness failure: three diagnostic attempts (1 failed, 2 passed); cause **not demonstrated**; a bounded EPERM-retry **hardening** is now prepared (04 §5) and both supported Node versions pass the full suite once (576 tests, 571 pass, 5 skipped, 0 fail); the item stays open for the CTO's disposition.
* Unverified until hosted: real HTTPS cookies, SMTP/deliverability, hosting and proxy log contents, provider prices (02 §7 labels), restore from backup.
* Open: F-H9-1, staging credential disposal, full F2 acceptance, artwork rights.
