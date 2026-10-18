# Local Supabase stack

The real local stack (GoTrue Auth, PostgREST, Storage, Postgres, mail catcher) is the integration target for every
database and Auth test. An auth shim may speed up database-only tests but is **not** evidence for Auth, Storage or
cookie behaviour.

- Config: `supabase/config.toml` (CLI 2.120.0). Changed from the generated defaults: `project_id`, `auth.jwt_expiry = 600`
  (short access tokens bound the revocation window), `auth.email.enable_confirmations = true`, `auth.mfa.totp` enabled.
  The hosted staging/production settings are **not** inferred from this file.
- Run: `npm run db:test` (starts the stack, runs `supabase test db`, always stops it). Every command is time-bounded
  (`--start-timeout-ms`, `--test-timeout-ms`, `--stop-timeout-ms`, `--preflight-timeout-ms`). Exit codes: `0` passed,
  `1` tests failed, `2` **BLOCKED** (Docker or the CLI is missing; not a failure and not a pass), `3` stack failed to
  start, `4` a command timed out, `8` cleanup (`supabase stop`) failed. Cleanup is attempted whenever a start was
  attempted, and exit 8 outranks every other result. `tests/db-test-runner.test.ts` covers all of these with command
  doubles; no database is contacted.
- Tests: `supabase/tests/database/*.test.sql` (pgTAP). F1 contains only a platform sanity test; the application schema
  and its tests arrive in F2.
- CI: the `database` job in `.github/workflows/ci.yml`.

## Tooling (pinned)
- Supabase CLI **2.120.0**: `node scripts/install-supabase-cli.mjs` installs it into `.tools/` after checking the archive's SHA-256
  against `scripts/supabase-cli-pin.json` (same procedure as Gitleaks). `db:test` refuses any other version (exit 2, BLOCKED).
- Docker: Docker Desktop. On macOS the runner also finds Docker Desktop's own `docker` and per-user socket
  (`~/.docker/run/docker.sock`) when `/usr/local/bin/docker` and `/var/run/docker.sock` are not linked. `DOCKER_BIN`,
  `SUPABASE_BIN` and `DOCKER_HOST` override discovery.
- `npm run db:test` runs the pgTAP tests (platform sanity, F2-A role/grant inventory, F2-A authorization matrix); `npm run db:test:auth`
  additionally runs `scripts/local-auth-spikes.mjs` (local Auth/session/MFA checks, `docs/spikes/f1-hosted-spikes.md`) and
  `scripts/local-f2a-checks.mjs` (real-JWT RPC calls, worker login, grant inventory, rollback rehearsal; `docs/db/f2a-authority.md`),
  `scripts/local-f2b-checks.mjs` (content, immutability, concurrency; `docs/db/f2b-content.md`) and `scripts/local-f2c-checks.mjs` (staff review RPCs, self-review, concurrent decisions; `docs/db/f2c1-review.md`) and `scripts/local-f2c2-checks.mjs` (staff publication RPCs, publish/withdraw races; `docs/db/f2c2-publication.md`) and `scripts/local-f2d1-checks.mjs` (real worker login, parallel claims, lease epochs, recheck races; `docs/db/f2d1-jobs.md`) and `scripts/local-f2d2-checks.mjs` (AI budgets: fifty-way reservations, settlement races, access; `docs/db/f2d2-ai-budgets.md`) and `scripts/local-f2e-checks.mjs` (public catalog reads as anon, member and staff, response allowlist, replacement and withdrawal races, committed rollback; `docs/db/f2e-public-catalog.md`)
  against the same stack before stopping it. The discovery probe (`docker --version`) is time-bounded like every other command.

## Status
Run on the development machine (Intel Mac, macOS 15.7.7, Docker Desktop 4.95.0, Docker engine 29.8.2, CLI 2.120.0) on 2026-10-13:
the stack started, the 9 pgTAP checks passed, the 6 local Auth/session/MFA checks passed, `supabase stop --no-backup` ran, and
afterwards `docker ps -a` and `docker volume ls` were empty. Raw (secret-redacted) output is in the F1 review package. The
GitHub Actions `database` job runs the same commands but has not yet run on GitHub. These checks establish that the test
environment works and that the local Auth behaviours below hold; they do not yet exercise application permissions or
publication rules (F2).
