# Local review of `.github/workflows/ci.yml`

Reviewed from the file in this checkout after the local CI hardening commit (base `1699b43`, which was reviewed at `266ec02`). **The workflow has never run on GitHub.** GitHub-side settings (Actions policy, repository secrets, environments, installed Apps, webhooks) cannot be read from local files and are listed as unresolved in section 5. Nothing here was pushed or run.

## 1. Triggers

```yaml
on:
  push:
    branches: [main, mhost1-ci-first-run]
  pull_request:
```
* `push` runs only for pushes to **`main`** and to the single verification branch **`mhost1-ci-first-run`** (exact names, no wildcards). Pushes to any other branch and **all tag pushes do not run the workflow**. (Before this change `push:` had no filter and fired for every branch and every tag.)
* `pull_request` still runs for every pull request event, so a branch with an open pull request runs once per event type (push, if the branch is one of the two above, and pull request).
* `concurrency: ci-${{ github.ref }}` with `cancel-in-progress: true` cancels an older run of the same ref when a newer commit arrives.
* There is no `workflow_dispatch`, `schedule`, `workflow_run`, `release` or `deployment` trigger, and no `pull_request_target`.
* A push to `main` also runs it. If a hosting integration deploys `main` (see section 5), that deployment is independent of this workflow.

## 2. Permissions and secrets

* Workflow-level `permissions: contents: read` and no job overrides it. No job requests `id-token`, `packages`, `deployments`, `pull-requests` or write access.
* Every `actions/checkout` step sets `persist-credentials: false`; the token is not left in the checkout.
* **The file references no secrets and no variables** (`secrets.` and `vars.` do not appear; the only expressions are `github.ref`, `matrix.node-version` and the setup-node file input). The build step uses literal dummy values (`http://127.0.0.1:9`, `dummy`). A repository secret that happens to exist would not be read by this file, but a push-triggered workflow runs from the pushed branch's own copy of the file: **any author of a branch that matches the trigger filter can change the workflow**. The protection is that no secret is set in the repository for this work and that nothing sensitive is reachable from the runner. The branch filter narrows which pushes can run a modified workflow; it does not remove the property.
* Fork pull requests run with a read-only token and no secrets by GitHub's default; not relevant until the repository takes outside contributions.

## 3. Jobs, actions, runtime and pins

| Item | Value | Pin quality |
|---|---|---|
| Runner | `ubuntu-24.04` (all three jobs) | **pinned image label**; GitHub still updates the contents of that image, but not to another Ubuntu release |
| `actions/checkout` | `11d5960a326750d5838078e36cf38b85af677262` (release v4.4.0, node20) | **full commit SHA** |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` (release v4.4.0, node20) | **full commit SHA** |
| `supabase/setup-cli` | `1dedf2c611547ede7232d26866dd3c56ab903bbb` (release v1.7.3, node20) | **full commit SHA**; installs CLI **2.120.0** (input), which tests (`tests/db-test-runner.test.ts`, `tests/foundation-docs.test.ts`) tie to `scripts/supabase-cli-pin.json` |
| Node in the application job (`verify`) | matrix **22.23.3** and **24.21.0**, `fail-fast: false` | exact versions; 22.23.3 is `.nvmrc` (a test keeps them equal) |
| Node in the `database` and `server-boundary` jobs | `.nvmrc` = **22.23.3** | exact |
| Gitleaks | downloaded by `scripts/install-gitleaks.mjs` from the GitHub release `v8.30.1`, **SHA-256 verified** against `scripts/gitleaks-pin.json` (linux-x64 digest present) | pinned and verified |
| npm packages | `npm ci --ignore-scripts` from `package-lock.json` | lockfile-pinned, no lifecycle scripts |
| Postgres / Supabase service images | pulled by `supabase start` for CLI 2.120.0 (Postgres 17 line, same as local) | pinned indirectly by the CLI version; image digests are not recorded |
| Timeouts | `verify` 20 min (per matrix leg), `database` 25 min, `server-boundary` 20 min | set |

**How the pins were resolved and verified (2026-10-15, read-only lookups of the public repositories; no credentials, no access to this repository):**

| Reference in the old workflow | What it was | Resolved commit | Verification |
|---|---|---|---|
| `actions/checkout@v4` | tag `v4` (the same commit as tag `v4.4.0`) | `11d5960a326750d5838078e36cf38b85af677262` | `git ls-remote` of the tag; the commit was then fetched **by SHA** into a throwaway repository: it exists, `action.yml` is "Checkout" with `using: node20`, committed 2026-07-16 ("backport fixes to releases-v4") |
| `actions/setup-node@v4` | tag `v4` (same commit as tag `v4.4.0`) | `49933ea5288caeca8642d1e84afbd3f7d6820020` | same two steps; `action.yml` is "Setup Node.js environment", `using: node20`, committed 2025-04-02 |
| `supabase/setup-cli@v1` | **a branch** (`refs/heads/v1`), not a tag; its head is the same commit as tag `v1.7.3` | `1dedf2c611547ede7232d26866dd3c56ab903bbb` | same two steps; `action.yml` is "Supabase CLI Action", `using: node20`, committed 2026-09-24 |

To re-verify any pin: `git ls-remote https://github.com/<owner>/<repo>.git refs/tags/<release>` (add `^{}` for an annotated tag) must print the SHA in the workflow, and `git init t && cd t && git fetch --depth 1 https://github.com/<owner>/<repo>.git <SHA>` must fetch exactly that commit. A tag can be moved by its owner; the SHA in the workflow cannot, which is the point of pinning.

* **`supabase/setup-cli` has newer major versions** (`v2.x` and `v3` exist). This change pins the commit that `@v1` already pointed to, so behaviour does not change; adopting v2 or v3 is a separate decision with its own review.
* **Updating a pin** is a deliberate commit that changes the SHA and its comment together; a test fails if a `uses:` line is not a 40-character SHA.

### Node 24 and `engines`
`package.json` declares `"node": ">=22.18.0 <23"`, so installing on Node 24 prints an npm `EBADENGINE` warning (seen in the fresh-clone install log on Node 24.21.0); it is a warning, not a failure, because `engine-strict` is not set. The application verification job now runs on Node 24.21.0 as well as 22.23.3, since both are supported in practice (the full local gate passed on both). **`engines` was deliberately not changed here** (it is a package contract outside this assignment); aligning it is a follow-up. A test records the discrepancy so it is not forgotten.

## 4. What the workflow does and does not touch

* `verify` (two legs, Node 22.23.3 and 24.21.0): install, Gitleaks and in-repo secret scans, lint, typecheck, `npm test` (with `REQUIRE_GITLEAKS=1`), a production build with dummy configuration, and the isolated smoke run against a local fixture server (loopback only, enforced by the net guard). Each leg scans the full git history.
* `database`: starts the local Supabase stack **inside the runner** (containers), runs pgTAP and the eight local check scripts. The checks include committed rollback rehearsals, which run against that disposable runner database only. Nothing connects to any hosted Supabase project.
* `server-boundary`: a throwaway build probe.
* No step deploys, publishes, pushes, comments, creates releases, uploads artifacts, or writes to the repository or any other service. Network egress: npm registry, GitHub release downloads (Gitleaks), container registries (Supabase images), Node distribution downloads (setup-node).
* **Expected first-run risks** (the database job's own first verification, as its comment says): Docker image pulls and stack start time on the runner; the `tests/smoke-*` harness on Linux (the F2-F cleanup tests passed on a Linux reconstruction, per the F2-F review); timing-sensitive tests on slower runners; the Node 24 leg is new on CI (it passed locally); the Gitleaks history scan must find only the six baselined fingerprints in `.gitleaksignore` (their commit SHAs are identical on GitHub because history is not rewritten).

## 5. Could pushing this branch trigger a deployment? (do not assume it cannot)

**What the repository itself shows:** the workflow deploys nothing, and no `vercel.json`, `.vercel` directory, `netlify.toml`, `render.yaml`, `fly.toml`, `Procfile` or Dockerfile exists. **That does not settle it**, because deployment integrations live outside the repository:

* `SETUP_COMPLETE.md` says: "Use Vercel (Next.js native). Push to GitHub and Vercel auto-deploys on git push."
* `PROJECT_STATUS.md` lists "Frontend: Vercel (Next.js optimized)".
* The first line of `README.md` is the text `// Deployment trigger`, which suggests that a commit to that file was once used to trigger a deployment.
* The application reads `VERCEL_URL` (landing page self-fetch), and `frontend/.gitignore` ignores `.vercel`.

**Conclusion: a deployment on push is plausible and must be treated as likely until the owner shows otherwise.** The new `push` filter limits only **this workflow**; it does not limit a Git integration of a hosting provider, which reacts to pushes on its own settings. If a Vercel (or Render) Git integration is connected to `awattsny-pixel/HackAss`, pushing any branch normally creates a **preview deployment** of that branch, built with the **environment variables stored in that hosting project** (which may include keys for the project whose credentials were exposed). A push to `main` normally creates a production deployment. I cannot see those settings from here.

Other places that can react to a push, all external to the repository and all unknown from local files: GitHub webhooks, installed GitHub Apps, deploy keys, repository or organization rulesets, GitHub Pages, and Supabase's GitHub integration (branching).

**Facts about this push that matter regardless of deployment:**
* The remote is `https://github.com/awattsny-pixel/HackAss.git`; local `origin/main` is `a3a2ee3`. The working branch is ahead of it by the commits since `a3a2ee3`. Only the pushed branch's new commits are uploaded. **Because of the new filter, the only branch name that runs the workflow from a push, apart from `main`, is `mhost1-ci-first-run`; the push in the approval summary uses exactly that name.**
* The two commits that contain exposed credentials (`1307cd0`, `c25e780`) are **already ancestors of `origin/main`**, so as far as the last fetched state shows they are already on GitHub. Pushing does not newly expose them; it also does not remove them (see `credential-retirement.md`). Repository visibility (public or private) is not recorded locally: **OWNER confirms**.

**Push prerequisites (all three, for every push to any shared remote):** **P1 deployment controls**: the owner has answered D1 to D8 in `ci-review.md` and any deployment integration is disconnected or limited (or a separate private repository is used), confirmed in writing; **P2 credential-retirement evidence**: R1 to R8 in `credential-retirement.md` are each retired or recorded not applicable, with the redacted evidence accepted by the CTO; **P3 final workflow commit reviewed**: the exact commit to be pushed, including any workflow hardening from step S2, has been reviewed and accepted by the CTO and is named by its SHA in the authorization.

**Owner checks required before any push** (these are P1; each takes a minute in a settings page; record the answer):

| # | Where | Question |
|---|---|---|
| D1 | Vercel dashboard (and any Render, Netlify, Fly or similar account) | is `awattsny-pixel/HackAss` connected to any project? If yes: what branches build, what environment variables does each environment hold, and can Git deployments be disabled or limited to a branch that is never pushed? |
| D2 | GitHub repository, Settings, Webhooks | any webhook configured? |
| D3 | GitHub repository, Settings, GitHub Apps (and Integrations) | which Apps are installed (Vercel, Render, Supabase, others)? |
| D4 | GitHub repository, Settings, Environments, Secrets and variables | any environment, secret or variable present? (This package assumes none.) |
| D5 | GitHub repository, Settings, Actions, General | are Actions enabled; which actions are allowed; default `GITHUB_TOKEN` permission (read-only expected)? |
| D6 | GitHub repository, Settings, Pages and Rulesets/branch protection | any Pages deployment or push-triggered ruleset? |
| D7 | Repository visibility | public or private? |
| D8 | Supabase dashboard of the **old** project | is the GitHub integration (branching) enabled for this repository? |

**Options if D1 to D3 show an integration (owner chooses):**
1. Disconnect or pause the Git integration for the duration of the run (cleanest).
2. Configure the integration so the pushed branch name is ignored (an "ignored build step" or branch allowlist), and confirm with a dry check before pushing.
3. Push to a **separate private repository** created for verification with no integrations installed. The full history, including the two baselined exposure commits, is copied there too; that repository must be treated as sensitive and deleted afterwards.
Option 3 changes the remote in the approval request; the commands in `approval-summary.md` then use the new remote's name.

## 6. Other CI observations

* **Done in the CI hardening commit:** action SHA pins, runner pin, push filter, Node 22 and 24 for the application job. These changes are part of the final workflow commit that push prerequisite P3 requires the CTO to review.
* The `supabase/setup-cli` pin follows the old `v1` branch; newer majors exist (section 3).
* There is no required-status-check or branch-protection configuration in the repository (it cannot be stored there).
* The workflow is covered by tests that fail on any mutable action reference, an unpinned runner, a wider push filter, a missing Node leg, or the appearance of secrets or deployment steps (`tests/ci-hardening.test.ts`, `tests/hosted-docs.test.ts`).
