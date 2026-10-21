# 00 · PX-3e: what changed, why, and how it was verified

> Superseded in part by the delta review (06): the RPC checker, the rollback export, the maintenance gate and the hosted sequence were corrected; the validation counts in §4 are those of the first package, the delta runs are in `results/delta/`.

All changes are **local and uncommitted** in `wt-px2b`. No hosted system was contacted.

## 1. Focused changes
| Area | Change | Files |
|---|---|---|
| Route allowlist | only the preview's routes are served (spark, lab, reveal, `/account/{sign-in,recover,prompts,results}`, `/auth/*` flow routes, `/work/*`, `/health`, `robots.txt`, `_next/static`, `_next/image` for the four public assets, the four public assets); everything else, including the legacy pages, `/api/**`, `/auth/login`, `/auth/signup`, `/states`, answers **one uniform 404** (no detail, same headers, every method). `/` redirects 307 to `/spark`. Disabled legacy routes are **not** reactivated | `src/platform/preview-gate.ts`, `next.config.js`, `app/gate-blocked/route.ts` |
| Environment validation | preview mode (every `APP_ENV` except an explicit `local`/`ci`; unset or invalid fails closed) forbids the service-level and database names, requires the three app secrets and a trusted client-address source, validates `EDGE_LOCK_SECRET` (required in staging/production), refuses `PREVIEW_GATE=off` outside local/ci. `scripts/check-env.mjs` runs it at build and prints names only | `src/platform/env-validate.ts`, `env.ts`, `server.ts`, `scripts/check-env.mjs` |
| Headers | `X-Content-Type-Options`, `X-Robots-Tag: noindex, nofollow, noarchive`, `Permissions-Policy`, COOP/CORP, `no-store` where private, page-only `X-Frame-Options`, same-origin `Referrer-Policy` and a CSP (honest: `'unsafe-inline'` for Next hydration; no framing, plugins, `base` or third-party connections); HSTS (180 d) and `upgrade-insecure-requests` for HTTPS builds only; `/auth/**` keeps its own stricter route headers | `preview-gate.ts` |
| Noindex | headers plus `robots.txt` (`app/robots.ts`). **Supplementary**; real protection is the Access gate and the origin lock (02 §3) | |
| Health | `GET /health` → `{status, ready, gate, lock, boot}`; 503 when the environment is invalid, the runtime says preview but the build is open, or a strict environment lacks the built lock. No variable name or value | `app/health/route.ts` |
| Origin lock | because Render Hobby cannot restrict the origin to the edge, a build compiled with `EDGE_LOCK_SECRET` refuses everything lacking the exact `x-hackass-edge` header (except `/health`) | `preview-gate.ts` |
| Pilot tooling | manifest (25 migrations, 120 functions, 28 tables), exact SQL inventory (187 lines), guarded apply, actual-RPC checks (R1–R7), hosted-target refusals | `docs/px3d/pilot-*`, `scripts/pilot-*.mjs`, `scripts/lib/pilot-plan.mjs` |
| Test harness | CDP log history and a CSP-violation scan (Z1) in the PX-3c browser checks; stale px2b U1/R2 expectations corrected | `scripts/lib/cdp.mjs`, `px3c-browser-checks.mjs`, `px2b-local-checks.mjs` |

## 2. Design decision: no `proxy.ts`
A request proxy was built first and **removed**. Next 16 buffers and clones request bodies for a proxy, which defeats the streaming 64 KB body limit and the 3 s deadline of PX-2b/3b (observed: the px3b V2, px2b B1 and B2 checks hung). The gate is therefore compiled at build time into `next.config.js` (`rewrites` `beforeFiles`, `redirects`, `headers`) from the same pure module the tests import (`decidePath` is asserted equivalent to the built rules). A test forbids `proxy.ts`/`middleware.ts`. Consequences: the gate mode and the lock are fixed **at build** (hence `/health` checks that build and runtime agree); changing the edge secret needs a rebuild.

## 3. Build modes
| Use | Command shape |
|---|---|
| Local development/tests (open) | `APP_ENV=local npx next build` |
| Preview (gated) | `APP_ENV=staging|production EDGE_LOCK_SECRET=… npx next build` (plus the runtime environment) |
| Alternate directory (tests) | `NEXT_DIST_DIR=.next-gate …` (the build rewrites `tsconfig.json`; `git checkout -- tsconfig.json` afterwards) |

## 4. Validation results (all in `docs/px3d/results/`)
| Check | Result |
|---|---|
| `px3e-local-checks.mjs` G1–G11, five real servers (gated, open, build/runtime mismatch, locked) | **11/11** |
| Earlier real-stack and browser suites re-run **on the gated build**: px2b, px3b, px2c, px3c | all passed (`gated-*.txt`) |
| New unit tests: preview-gate, platform-env, pilot-manifest (6), pilot-apply (4) | pass (the last four alone: 4/4; they were added after the third smoke attempt) |
| Pilot rehearsal on the local pilot stack: rollback → dry run (4 pending) → apply → inventory identical (187 lines) → second apply a no-op | passed |
| `pilot-rpc-checks --local` R1–R7 (anonymous/service-role refusal, member isolation, revoked-session token refused by the database guard, mass revocation) | **7/7** |
| pgTAP after the rehearsal | 1245 passed |
| `tsc` | clean; lint 0 errors, 5 known warnings; secret scan: working tree 0, history 0 new (5 known historic) |
| Full suite | expected total **569** after the four added tests; last full-suite run: see 04 (the smoke item is still open) |

## 5. Limits, stated plainly
* **Single process:** the throttles reset on restart/deploy/crash; Render overlaps instances during deploys; a maintenance gate and an owner acknowledgement are required (02 §2.1, 05 §6).
* The CSP keeps `'unsafe-inline'` for scripts and styles (Next hydration); it is a limiter, not a seal.
* `proxy`-free design means no per-request logic at the edge of the app: the lock is a static header match.
* Real HTTPS cookies, real SMTP, hosted settings, hosting/proxy log contents and all provider prices remain unverified until the hosted checks run (03).
* The smoke-harness failure is **not resolved** (04).
