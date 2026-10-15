# Hosted verification scripts (staging)

These scripts implement `docs/hosted/verification-procedure.md` for the Supabase project `hackass-staging` (reference `foptxhdnhudburqtnflt`). **Nothing here has been run against a hosted system.** Running any stage against staging needs a separate written authorization that names the stage group and the exact commit (see "Gates"). The integration test `selftest.mjs` runs every stage against the disposable local stack only.

## Principles

* **One stage per script invocation; read-only preflight is separate from everything that changes state.** Stages are grouped for authorization: `S6` read-only, `S7` migrations, `S8` fixtures and checks, `S9` cleanup and evidence.
* **Targets are validated before anything is contacted (H0).** The API URL, the migration login/host, both pooler endpoints, the worker login and the password file are each checked against the staging reference on their own, because a correct API reference does not prove a database connection reaches the same project. `FORBIDDEN_PROJECT_REFS` (the legacy project) must be set and must appear in nothing.
* **Cross-endpoint identity proofs run before migrations (stage `identity`):** a throwaway Auth user created through the API must be visible through the migration, pooler-session and pooler-transaction endpoints, then is deleted. Later, a role comment written as `postgres` must be readable as the worker through both worker endpoints (stage `worker-marker`).
* **Secrets stay out of git, arguments, URLs, logs and chat.** Database passwords are read by libpq from a `0600` password file (`PGPASSFILE`) outside the repository; connection strings are password-free. API keys come from the environment or from a file named by `<NAME>_FILE`. Everything printed or recorded passes through `lib/redact.mjs`; generated fixture passwords and TOTP secrets live only in the run directory (`0700`, outside the repository) and are deleted by `cleanup`.
* **Role administration runs as `postgres`; `SET ROLE hackass_owner` is reserved for application fixture DML** (staff rows for fixture users created in the run, one category row, one scoped job update) and for owner-side verification reads. `lib/sqlguard.mjs` enforces this by SQL kind and refuses everything else.
* **Bounded failures.** Every database call, HTTP call and child process has a deadline; nothing retries; the first failed check stops its stage; a failed stage blocks the rest of the run (except `cleanup`, which can always be repeated).

## Gates

Every stage that contacts a target requires `--authorized=<group>@<40-hex SHA>`; the SHA must equal `HEAD` and (for staging) the working tree must be clean. Mutating stages additionally require `--confirm-mutating=<stage>`. A stage runs only after the stages it depends on are `done` in the same run; mutating stages run once per run. The two owner actions are confirmed with `--owner-confirmed=exposure` (after the owner exposes only the `api` schema) and `--owner-confirmed=worker-password` (after the owner sets the worker password).

## Owner inputs (none of these are requested in chat)

| Input | Where it goes |
|---|---|
| Legacy project reference(s) | `FORBIDDEN_PROJECT_REFS` (comma separated) |
| Publishable and secret API keys | `STAGING_PUBLISHABLE_KEY` / `STAGING_SECRET_KEY`, or `..._KEY_FILE` pointing at a `0600` file |
| Database password for `postgres.<ref>` and the worker password (set by the owner after the migrations) | a `0600` password file outside the repository, one line per login and endpoint (host:port:postgres:login:password) |
| Pooler host (region endpoint) | `STAGING_MIGRATE_HOST`, `STAGING_POOLER_TXN_HOST`, `STAGING_POOLER_SESSION_HOST` |
| Exposed schemas set to `api` only after the migrations | dashboard; then `--owner-confirmed=exposure` |
| Worker password set | dashboard or owner SQL session; then `--owner-confirmed=worker-password` |
| P1 deployment controls D1 to D8, P2 credential retirement | recorded outside these scripts; required before any push |
| Project deletion date (O9) | `--owner-deletion-date=YYYY-MM-DD` on `cleanup` |

Environment (names only):
`STAGING_REF=foptxhdnhudburqtnflt`, `STAGING_URL=https://foptxhdnhudburqtnflt.supabase.co`, `STAGING_MIGRATE_HOST`, `STAGING_MIGRATE_PORT` (5432), `STAGING_MIGRATE_USER=postgres.foptxhdnhudburqtnflt`, `STAGING_POOLER_TXN_HOST`/`PORT` (6543), `STAGING_POOLER_SESSION_HOST`/`PORT` (5432), `STAGING_WORKER_USER=hackass_worker.foptxhdnhudburqtnflt`, `STAGING_PGPASSFILE`, `STAGING_PUBLISHABLE_KEY`, `STAGING_SECRET_KEY`, `FORBIDDEN_PROJECT_REFS`.

## Stages and proposed commands

`<SHA>` is the full reviewed commit; `RUN` is a fresh run id such as `stg-20261016a` (6 to 40 lowercase letters, digits, hyphens). Commands are run from the repository root.

| # | Stage | Group | Class | Command |
|---|---|---|---|---|
| 1 | `preflight` (H0, H1a) | S6 | read-only | `node scripts/hosted/preflight.mjs --run-id=RUN --authorized=S6@<SHA>` |
| 2 | `identity` (H1b) | S7 | mutating (one throwaway Auth user, deleted at once) | `node scripts/hosted/s7-apply.mjs identity --run-id=RUN --authorized=S7@<SHA> --confirm-mutating=identity` |
| 3 | `migrate` (H2a) | S7 | mutating, once | `node scripts/hosted/s7-apply.mjs migrate --run-id=RUN --authorized=S7@<SHA> --confirm-mutating=migrate` |
| | *owner: expose only `api`* | | | |
| 4 | `exposure` (H2b) | S7 | read-only | `node scripts/hosted/s7-verify.mjs exposure --run-id=RUN --authorized=S7@<SHA> --owner-confirmed=exposure` |
| | *owner: set the worker password* | | | |
| 5 | `worker-marker` (H2c) | S7 | mutating (one role comment) | `node scripts/hosted/s7-apply.mjs worker-marker --run-id=RUN --authorized=S7@<SHA> --confirm-mutating=worker-marker --owner-confirmed=exposure,worker-password` |
| 6 | `rerun` (H3) | S7 | mutating-capable no-op | `node scripts/hosted/s7-apply.mjs rerun --run-id=RUN --authorized=S7@<SHA> --confirm-mutating=rerun` |
| 7 | `inventory` (H4, H5a) | S7 | read-only | `node scripts/hosted/s7-verify.mjs inventory --run-id=RUN --authorized=S7@<SHA>` |
| 8 | `fixtures` (FX0, H5b, FX1) | S8 | mutating | `node scripts/hosted/fixtures.mjs --run-id=RUN --authorized=S8@<SHA> --confirm-mutating=fixtures` |
| 9 | `session-checks` (H6, H7, H8) | S8 | mutating (H8 waits about 70 s; `--default-window` adds the 16-minute step) | `node scripts/hosted/checks-session.mjs --run-id=RUN --authorized=S8@<SHA> --confirm-mutating=session-checks` |
| 10 | `worker-checks` (H9, H10) | S8 | mutating (one scoped job update) | `node scripts/hosted/checks-worker.mjs --run-id=RUN --authorized=S8@<SHA> --confirm-mutating=worker-checks` |
| 11 | `catalog-checks` (H11) | S8 | mutating (keeps the pagination fixtures) | `node scripts/hosted/checks-catalog.mjs --run-id=RUN --authorized=S8@<SHA> --confirm-mutating=catalog-checks` |
| 12 | `isolation` (H12) | S8 | read-only | `node scripts/hosted/isolation.mjs --run-id=RUN --authorized=S8@<SHA>` |
| 13 | `cleanup` (H13) | S9 | mutating, repeatable | `node scripts/hosted/cleanup.mjs --run-id=RUN --authorized=S9@<SHA> --confirm-mutating=cleanup [--owner-deletion-date=YYYY-MM-DD]` |
| 14 | `evidence` (H14) | S9 | local only | `node scripts/hosted/evidence.mjs --run-id=RUN` (writes `docs/hosted/evidence/<date>-staging.md`; add `--delete-raw` after review) |

`cleanup` needs only `preflight`, so a failed or abandoned run can always be cleaned up. The synthetic content (hacks, versions, publications, decisions, ledgers) is append-only by design and is removed only by deleting the project.

## Local testing

* `npm test` runs `tests/hosted-scripts.test.ts` (target rejection, password-file reader, redaction, SQL allowlist, gates, static limits) without Docker.
* `node scripts/hosted/selftest.mjs` needs the local Supabase stack running and Docker; set `SUPABASE_BIN` to the pinned CLI (`.tools/supabase/2.120.0/supabase`) and put Docker's `bin` on `PATH`. It resets the application state of the **local** database, runs every stage in order from empty, proves the refusals, and checks that no password or key appears in any output or in the evidence. The `selftest` profile accepts only the local stack and needs `HOSTED_SELFTEST=1`; the `staging` profile accepts only the staging reference.
