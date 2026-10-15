# Local review of `.github/workflows/ci.yml`

Reviewed from the file in this checkout at `266ec02` plus the local git metadata. **The workflow has never run on GitHub.** GitHub-side settings (Actions policy, repository secrets, environments, installed Apps, webhooks) cannot be read from local files and are listed as unresolved in section 5.

## 1. Triggers

```yaml
on:
  push:
  pull_request:
```
* `push:` with no filter fires for **every branch and every tag** pushed to the repository. `pull_request:` fires for every pull request event. A branch with an open pull request runs the workflow twice (once per event).
* `concurrency: ci-${{ github.ref }}` with `cancel-in-progress: true` cancels an older run of the same ref when a newer commit arrives.
* There is no `workflow_dispatch`, `schedule`, `workflow_run`, `release` or `deployment` trigger.

## 2. Permissions and secrets

* Workflow-level `permissions: contents: read` and no job overrides it. No job requests `id-token`, `packages`, `deployments`, `pull-requests` or write access.
* Every `actions/checkout@v4` step sets `persist-credentials: false`; the token is not left in the checkout.
* **The file references no secrets and no variables** (`secrets.` and `vars.` do not appear; the only expressions are `github.ref` and the setup-node file input). The build step uses literal dummy values (`http://127.0.0.1:9`, `dummy`). A repository secret that happens to exist would not be read by this file, but note that a push-triggered workflow runs from the pushed branch's own copy of the file: **any branch author can change the workflow**. The protection is therefore that no secret is set in the repository for this work and that nothing sensitive is reachable from the runner.
* Fork pull requests run with a read-only token and no secrets by GitHub's default; not relevant until the repository takes outside contributions.

## 3. Jobs, actions, runtime and pins

| Item | Value | Pin quality |
|---|---|---|
| Runner | `ubuntu-latest` (all three jobs) | floating image; the Ubuntu release can change under the job |
| `actions/checkout` | `@v4` | **major-version tag, mutable** (not a commit SHA); `fetch-depth: 0` in the `verify` job for the Gitleaks history scan |
| `actions/setup-node` | `@v4` | **major-version tag, mutable**; `node-version-file: .nvmrc` = **22.23.3** (exact); npm cache |
| `supabase/setup-cli` | `@v1` | **major-version tag, mutable**; installs CLI **2.120.0** (input), which tests (`tests/db-test-runner.test.ts`, `tests/foundation-docs.test.ts`) tie to `scripts/supabase-cli-pin.json` |
| Gitleaks | downloaded by `scripts/install-gitleaks.mjs` from the GitHub release `v8.30.1`, **SHA-256 verified** against `scripts/gitleaks-pin.json` (linux-x64 digest present) | pinned and verified |
| npm packages | `npm ci --ignore-scripts` from `package-lock.json` | lockfile-pinned, no lifecycle scripts |
| Postgres / Supabase service images | pulled by `supabase start` for CLI 2.120.0 (Postgres 17 line, same as local) | pinned indirectly by the CLI version; image digests are not recorded |
| Timeouts | `verify` 20 min, `database` 25 min, `server-boundary` 20 min | set |

* **Node coverage gap.** CI runs Node 22.23.3 only; Node 24.21.0 (also supported, and used for the second local verification) is not in CI.
* **Action pinning recommendation (not applied here):** replace the three mutable tags with full commit SHAs, keeping the tag in a comment. Resolving the SHAs requires contacting GitHub, so it is deliberately left for the execution slice, after authorization.
* **Floating runner recommendation:** pin `ubuntu-24.04` (or the current LTS) to avoid image drift; also left for review.

## 4. What the workflow does and does not touch

* `verify`: install, Gitleaks and in-repo secret scans, lint, typecheck, `npm test` (with `REQUIRE_GITLEAKS=1`), a production build with dummy configuration, and the isolated smoke run against a local fixture server (loopback only, enforced by the net guard).
* `database`: starts the local Supabase stack **inside the runner** (containers), runs pgTAP and the eight local check scripts. The checks include committed rollback rehearsals, which run against that disposable runner database only. Nothing connects to any hosted Supabase project.
* `server-boundary`: a throwaway build probe.
* No step deploys, publishes, pushes, comments, creates releases, uploads artifacts, or writes to the repository or any other service. Network egress: npm registry, GitHub release downloads (Gitleaks), container registries (Supabase images).
* **Expected first-run risks** (the database job's own first verification, as its comment says): Docker image pulls and stack start time on the runner; the `tests/smoke-*` harness on Linux (the F2-F cleanup tests passed on a Linux reconstruction, per the F2-F review); timing-sensitive tests on slower runners; the Gitleaks history scan must find only the six baselined fingerprints in `.gitleaksignore` (their commit SHAs are identical on GitHub because history is not rewritten).

## 5. Could pushing this branch trigger a deployment? (do not assume it cannot)

**What the repository itself shows:** the workflow deploys nothing, and no `vercel.json`, `.vercel` directory, `netlify.toml`, `render.yaml`, `fly.toml`, `Procfile` or Dockerfile exists. **That does not settle it**, because deployment integrations live outside the repository:

* `SETUP_COMPLETE.md` says: "Use Vercel (Next.js native). Push to GitHub and Vercel auto-deploys on git push."
* `PROJECT_STATUS.md` lists "Frontend: Vercel (Next.js optimized)".
* The first line of `README.md` is the text `// Deployment trigger`, which suggests that a commit to that file was once used to trigger a deployment.
* The application reads `VERCEL_URL` (landing page self-fetch), and `frontend/.gitignore` ignores `.vercel`.

**Conclusion: a deployment on push is plausible and must be treated as likely until the owner shows otherwise.** If a Vercel (or Render) Git integration is connected to `awattsny-pixel/HackAss`, pushing any branch normally creates a **preview deployment** of that branch, built with the **environment variables stored in that hosting project** (which may include keys for the project whose credentials were exposed). A push to `main` normally creates a production deployment. I cannot see those settings from here.

Other places that can react to a push, all external to the repository and all unknown from local files: GitHub webhooks, installed GitHub Apps, deploy keys, repository or organization rulesets, GitHub Pages, and Supabase's GitHub integration (branching).

**Facts about this push that matter regardless of deployment:**
* The remote is `https://github.com/awattsny-pixel/HackAss.git`; local `origin/main` is `a3a2ee3`. `mhost0-preflight` is 27 commits ahead of it at `266ec02` (plus the commit adding this package). Only the pushed branch's new commits are uploaded.
* The two commits that contain exposed credentials (`1307cd0`, `c25e780`) are **already ancestors of `origin/main`**, so as far as the last fetched state shows they are already on GitHub. Pushing does not newly expose them; it also does not remove them (see `credential-retirement.md`). Repository visibility (public or private) is not recorded locally: **OWNER confirms**.

**Owner checks required before any push** (each takes a minute in a settings page; record the answer):

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

* The `push:` trigger will also run on any later branch pushed, including ones unrelated to this work. Restricting `push:` to selected branches, or to `main` plus pull requests, is a reasonable hardening change for the execution slice.
* There is no required-status-check or branch-protection configuration in the repository (it cannot be stored there).
* No test asserts the absence of `secrets.` in the workflow; the execution slice could add one (cheap, local).
