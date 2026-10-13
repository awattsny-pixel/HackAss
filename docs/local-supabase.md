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

## Status
Written and statically checked only. It has **not** been run: the development machine has no Docker. The first run on a
Docker-capable machine or on GitHub Actions is the first verification; treat any failure there as expected feedback on
this setup, not as a regression.
