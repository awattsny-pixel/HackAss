# M-HOST preparation (mhost0-preflight)

**Status: prepared, not executed.** Everything here was written from local files. Nothing was pushed, no Supabase project exists for this work, the checkout is not linked, no remote secret is set, no workflow has run, and no hosted system was contacted. No claim below is a hosted result.

| Document | Purpose |
|---|---|
| [staging-plan.md](staging-plan.md) | The fresh isolated staging project: settings, database version, migration order, Auth, exposed schemas, worker connection, owner inputs, cost and cleanup |
| [verification-procedure.md](verification-procedure.md) | The numbered hosted checks (H0 to H14), each classified read-only or mutating, with proposed commands, evidence and cleanup |
| [ci-review.md](ci-review.md) | Local review of `.github/workflows/ci.yml` and the answer to "could a push trigger a deployment?" |
| [credential-retirement.md](credential-retirement.md) | Which exposed credential classes the owner must retire and how retirement will be evidenced |
| [approval-summary.md](approval-summary.md) | What is being asked for, in separately authorizable steps |

## Ground rules for every later step

1. **One authorization per step.** Approval of this package authorizes nothing by itself. Each step in `approval-summary.md` is authorized (or not) separately, naming the exact commit and target.
2. **Staging only, and only the staging project.** Never the project whose keys appear in git history. Every command in these documents reads its target from environment variables that the owner sets; no project reference, URL, key or password is ever written into the repository.
3. **Local destructive tooling is never pointed at a hosted database.** See "Forbidden against staging" in the verification procedure.
4. **Secrets never enter the repository, a chat message, a command line argument or a log.** Passwords and keys are passed through environment variables or standard input and are never echoed. Evidence is redacted before it is kept.
5. **Failures are recorded, not worked around.** A failed check stops the run, is reported with its output (redacted), and is not retried silently or fixed by hand-editing the hosted database.
6. **What this preparation cannot know.** Supabase dashboard wording, plan limits, pooler hostnames and prices are written from general knowledge and are marked "confirm" wherever they matter; they were not checked against the live service.
