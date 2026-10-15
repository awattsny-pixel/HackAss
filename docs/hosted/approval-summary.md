# Approval summary (M-HOST execution, proposed)

**Nothing in this document is authorized by approving the preparation package.** Each step below is a separate request. For every step the authorization message must name: the **exact commit SHA**, the target, the commands, and the stop conditions. The SHA of the commit that contains this document is the tip of `mhost0-preflight` and is stated in the hand-off message (a commit cannot contain its own SHA). Base: accepted `266ec02e4e55b91420d51dc8cf907c7b8ac4540e`.

## 1. Facts the approval depends on

| Item | State |
|---|---|
| Commit to be pushed | the tip of `mhost0-preflight` (accepted base `266ec02` plus this documentation commit); 28 commits ahead of `origin/main` (`a3a2ee3`) |
| Proposed remote and branch | remote `origin` = `https://github.com/awattsny-pixel/HackAss.git`; branch **`mhost1-ci-first-run`** (a new name; not `main`, no tags, no force). Exact form: `git push origin <SHA>:refs/heads/mhost1-ci-first-run`. If the owner chooses a separate private repository (`ci-review.md` option 3), only the remote changes |
| Staging project | **not yet identified; not created.** Name `hackass-staging`; reference, region and plan to be supplied by the owner (OWNER inputs O1 to O9 in `staging-plan.md`) |
| Credentials needed | none by me today. Later, in the operator's shell only: the staging database password, publishable and secret keys, the worker password (O2 to O4) |
| Hosted-system contact so far | none |

## 2. Unresolved dependencies and deployment triggers

| # | Unresolved item | Why it blocks | Resolution |
|---|---|---|---|
| U1 | **Deployment integration on push** (`ci-review.md` section 5): repository docs say Vercel auto-deploys on push, and `README.md` starts with `// Deployment trigger`. A preview deployment of the pushed branch is plausible, built with whatever environment variables the hosting project holds | a push could start an uncontrolled build outside this plan, possibly with the old project's keys | owner answers D1 to D3, then disconnects/limits the integration or chooses a separate private repository |
| U2 | **Repository visibility and the history already on the remote** (`1307cd0`, `c25e780` are ancestors of `origin/main`) | determines how serious the exposure is and whether a separate private repository is advisable | owner answers D7 |
| U3 | **Credential retirement** (`credential-retirement.md`) not done or evidenced | staging must never share keys with the old project; the first push to a shared remote should follow retirement | owner retires R1 to R8 and supplies redacted evidence |
| U4 | **GitHub repository settings** (secrets, environments, Actions policy, Apps, webhooks: D4 to D6) | cannot be read locally | owner answers; this package assumes no secrets exist |
| U5 | **Workflow hardening not yet applied** (mutable action tags, floating runner, `push:` on every branch) | the first run would use the workflow as it is | a local commit in the execution slice, after authorization to contact GitHub for the commit SHAs; or accept the risk explicitly for the first run |
| U6 | **Supabase-side unknowns** (hosted `postgres` privileges for roles, `auth.users` triggers and the session bridge; pooler username form and ports; key model) | the first migration apply may fail at a platform difference | accepted as the purpose of the run; failure is reported, not patched |
| U7 | **Owner-supplied staging project and settings** (O1 to O9) | nothing to test without it | owner |
| U8 | **Worker password** set out of band (O4) | H9/H10 cannot run without it | owner, via password manager, after migration 1 exists |

## 3. Requested actions, as separately authorizable steps

| Step | Action | Who | Needs | Mutating? |
|---|---|---|---|---|
| S0 | Review and accept this preparation package | CTO | nothing | no |
| S1 | Owner checks D1 to D8 and starts credential retirement (R1 to R8) | owner | provider consoles | owner-side only |
| S2 | Local only: apply workflow hardening (SHA pins, runner pin, push filter) as a reviewed commit | me | GitHub contact **only** to resolve action SHAs (authorize that lookup) | local commit |
| S3 | **Push** `<SHA>:refs/heads/mhost1-ci-first-run`, observe the first CI run, report all three jobs (including failures) | me | S1 results for U1 and U2, explicit authorization, the exact SHA | **yes** (creates a remote branch and starts CI) |
| S4 | Delete the remote branch `mhost1-ci-first-run` after the run | me or owner | authorization | yes |
| S5 | Owner creates the `hackass-staging` project and applies the settings (O1, O6, O7, O8); tells me only the reference and region | owner | S1 results | owner-side |
| S6 | Hosted **read-only** checks H0, H1 (and later H4, H5a, H9 queries, H12) | me | S5 and secrets exported by the owner for the session | no |
| S7 | Hosted **migration apply** H2, then H3, H4 | me | S6 passed; owner confirms the hosted facts (Postgres 17, bridge privileges) | yes |
| S8 | Hosted **mutating checks** H5b to H8, H10, H11 and the worker password setup (owner) with H9 | me and owner | S7 passed; worker password (O4) | yes (synthetic data) |
| S9 | Cleanup H13 and evidence H14; owner deletes the project | me and owner | all of the above | yes |

S3 is the only step that reaches GitHub; S5 to S9 are the only steps that reach Supabase. S3 and S6 to S9 are independent of each other once their own prerequisites are met (the CI run does not need staging, and staging does not need CI).

## 4. Expected cost

* **Supabase:** possibly nothing on a free plan; otherwise a paid plan's monthly fee plus compute for the days the project exists. Free plans limit active projects per organization and pause inactive ones. Not verified against current pricing; the owner decides (O8).
* **GitHub Actions:** one push runs three Linux jobs, roughly 25 to 35 minutes of runner time in total (estimate from local timings); a pull request on the same branch doubles it. Free for public repositories; for a private repository it draws on the plan's included minutes (CONFIRM).
* **Hosting provider, if an integration is connected (U1):** a preview build consumes build minutes and may expose a preview URL; this is the cost the owner can avoid by resolving U1 first.
* **My time and tokens:** the execution slice is bounded by `verification-procedure.md`; the 16-minute MFA wait is the only long idle step.

## 5. Cleanup responsibilities

| What | Who | When |
|---|---|---|
| Delete the remote branch `mhost1-ci-first-run` (and the separate repository, if used) | me with authorization, or owner | after the CI result is recorded |
| Delete or pause, then delete, the `hackass-staging` project (the only way to remove synthetic content, which is append-only) | **owner** | after H14 evidence is accepted |
| Revoke every key, token and password created for the run; unset exported variables | owner (keys), me (shell session) | immediately after S9 |
| Remove raw, unredacted run output from the operator machine | me | after redaction |
| Disconnect/limit any hosting integration changed for U1, and restore it deliberately (not automatically) | owner | when the owner is ready for deployments |
| Credential retirement evidence kept with the project records, not in the repository | owner | before S3 |

## 6. Stop conditions that apply to every step

Stop and report (do not continue or retry) if: a target does not match the expected staging reference; a forbidden project reference is detected; a command would touch anything listed in "Forbidden against staging"; a secret would appear in output; any check fails; a deployment or workflow starts that was not requested; or the owner withdraws authorization.
