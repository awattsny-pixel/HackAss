# Hosted verification scripts (staging)

These scripts implement `docs/hosted/verification-procedure.md` for the Supabase project `hackass-staging` (reference `foptxhdnhudburqtnflt`). **Nothing here has been run against a hosted system.** Running any stage against staging needs a separate written authorization that names the stage group and the exact commit (see "Gates"). The integration test `selftest.mjs` runs every stage against the disposable local stack only.

## Principles

* **One stage per script invocation; read-only preflight is separate from everything that changes state.** Stages are grouped for authorization: `S6` read-only, `S7` migrations, `S8` fixtures and checks, `S9` cleanup and evidence. `isolation` (H12) is classed as **mutating**: it creates Auth sessions and POSTs to private functions that would run if isolation were broken.
* **Targets are validated before anything is contacted (H0).** The API URL, the migration login/host, both pooler endpoints, the worker login and the password file are each checked against the staging reference on their own, because a correct API reference does not prove a database connection reaches the same project. `FORBIDDEN_PROJECT_REFS` (the legacy project) must be set and must appear in nothing.
* **Cross-endpoint identity proofs run before migrations (stage `identity`):** a throwaway Auth user created through the API must be visible through the migration, pooler-session and pooler-transaction endpoints, then is deleted. Later, a role comment written as `postgres` must be readable as the worker through both worker endpoints (stage `worker-marker`).
* **Secrets stay out of git, arguments, URLs, logs and chat.** Database passwords are read by libpq from a `0600` password file outside the repository (`PGPASSFILE`); connection strings are password-free and psql never prompts. API keys come from the environment or from a file named by `<NAME>_FILE`. **Every credential file is checked at every entry point before it is read or mounted:** an absolute path, a regular file that is not a symbolic link, mode `0600`, owned by the operator, outside the checkout. Everything printed or recorded passes through `lib/redact.mjs`. Generated fixture passwords and TOTP secrets live only in the run directory (`0700`, outside the repository) and are deleted by `cleanup`; the run keeps only **salted hashes** of what it registered, so redaction still works in a later, separate process (`evidence`) after the secrets file is gone.
* **Role administration runs as `postgres`; `SET ROLE hackass_owner` is reserved for application fixture DML** (staff rows for fixture users created in the run, one category row, one scoped job update) and for owner-side reads. `lib/sqlguard.mjs` enforces this by SQL kind and refuses everything else; there is no general SELECT/WITH fallback for fixture DML.
* **Reads are read-only in the database, not only by inspection.** Every verification read runs inside `BEGIN READ ONLY ... ROLLBACK`; the privilege probes run inside `BEGIN ... ROLLBACK` (a probe that unexpectedly succeeds is undone); fixture and role-administration SQL runs in its own transaction. The worker job calls (claim, subject, heartbeat, complete) are the only reads-that-write and have their own execution path (`kind: 'worker'`): fixed statements, worker endpoints only, naming only the registered synthetic job.
* **Deadlines stop the underlying operation.** Every child process is killed with its whole process group at its deadline; every database client runs in a **named** container that is then removed and its absence verified (`docker ps -a`), with a server-side statement timeout and connection check as a backstop; git subprocesses are bounded and never prompt; truncated migration output is rejected; and an interrupted stage kills its children and removes its containers before exiting. Removal is repeated for up to 3 s and counts as proof only after absence has held for 1 s; that quiet period is an observation, not a guarantee (a daemon slower than 1 s could still create the container afterwards). An interrupted stage whose containers are not proved gone stays `interrupted`, prints `cleanup NOT PROVEN` with the container names, and records them in the run state, the results and the evidence; the verdict says whether absence was not established or was seen but the quiet period was incomplete. **The migration is bounded in the database, not only in the CLI:** the CLI's session gets server-side limits (lock wait 30 s, statement 300 s, idle in a transaction 60 s, a 2 s connection check), its session is identified narrowly (the migration login, the CLI's own session name, started after a server-clock reading taken just before launch), and after a deadline or failure it is waited for, cancelled, terminated, and its end is verified (no session, no lock, nothing left waiting or idle in a transaction), or the error says NOT PROVEN. The stage is then failed and never retried.

## Run state fails closed

* A run is **bound** to one reviewed commit, one profile and one validated target configuration when it starts; every later stage must match all three, and every prerequisite must have been recorded under that commit.
* A stage that **failed, was interrupted (SIGINT, SIGTERM, or a killed process), or raised an unexpected exception** is recorded as such (the exception text, redacted, goes into the results) and **blocks every later stage**. Nothing restarts it. Only `cleanup` and `evidence` may continue such a run. A *read-only* stage (`preflight`, `exposure`, `inventory`) may be re-attempted after its own failure, only with `--retry-after-review`, only if no other stage is unhealthy; the earlier attempt stays in the history and the results. After a **killed** process (SIGKILL) run `evidence` first: it takes over the stale lock and records the interruption; then the approved retry may run. The retried stage can succeed, but the earlier attempt stays in the evidence and the outcome stays FAILED.
* **A process that is refused the lock changes nothing**, not even the run's redaction state: the redaction salt is created exclusively, and only by the holder of the lock, before any secret is registered.
* **Two processes cannot run stages against one run at once** (an exclusive lock). A lock left by a dead process is taken over only by `cleanup` or `evidence`; a lock held by a live process is never taken.
* `cleanup` **closes** the run: afterwards no stage except `cleanup` and `evidence` may run, so no fixture can be created after cleanup began.
* A run started under one commit cannot be continued, even for cleanup, under another: start the cleanup from the commit the run was bound to.

## Gates

Every stage that contacts a target requires `--authorized=<group>@<40-hex SHA>`; the SHA must equal `HEAD` and (for staging) the working tree must be clean. Mutating stages additionally require `--confirm-mutating=<stage>`. A stage runs only after the stages it depends on are `done` in the same run; mutating stages run once per run. The two owner actions are confirmed with `--owner-confirmed=exposure` (after the owner exposes only the `api` schema) and `--owner-confirmed=worker-password` (after the owner sets the worker password). Unknown flags are refused.

## Owner inputs (none of these are requested in chat)

| Input | Where it goes |
|---|---|
| Legacy project reference(s) | `FORBIDDEN_PROJECT_REFS` (comma separated) |
| Publishable and secret API keys | `STAGING_PUBLISHABLE_KEY` / `STAGING_SECRET_KEY`, or `..._KEY_FILE` pointing at a private `0600` file outside the checkout |
| Database password for `postgres.<ref>` and the worker password (set by the owner after the migrations) | a `0600` password file outside the repository, one line per login and endpoint (host:port:postgres:login:password) |
| Pooler host (region endpoint) | `STAGING_MIGRATE_HOST`, `STAGING_POOLER_TXN_HOST`, `STAGING_POOLER_SESSION_HOST` |
| Exposed schemas set to `api` only after the migrations | dashboard; then `--owner-confirmed=exposure` |
| Worker password set | dashboard or owner SQL session; then `--owner-confirmed=worker-password` |
| P1 deployment controls D1 to D8, P2 credential retirement | recorded outside these scripts; required before any push |
| Project deletion date (O9) | `--owner-deletion-date=YYYY-MM-DD` on `cleanup`: a real calendar date, not in the past, not more than a year away |

Environment (names only):
`STAGING_REF=foptxhdnhudburqtnflt`, `STAGING_URL=https://foptxhdnhudburqtnflt.supabase.co`, `STAGING_MIGRATE_HOST`, `STAGING_MIGRATE_PORT` (5432), `STAGING_MIGRATE_USER=postgres.foptxhdnhudburqtnflt`, `STAGING_POOLER_TXN_HOST`/`PORT` (6543), `STAGING_POOLER_SESSION_HOST`/`PORT` (5432), `STAGING_WORKER_USER=hackass_worker.foptxhdnhudburqtnflt`, `STAGING_PGPASSFILE`, `STAGING_PUBLISHABLE_KEY`, `STAGING_SECRET_KEY`, `FORBIDDEN_PROJECT_REFS`.

## Stages and proposed commands

`<SHA>` is the full reviewed commit; `RUN` is a fresh run id such as `stg-20261016a` (6 to 40 lowercase letters, digits, hyphens). Commands are run from the repository root.

| # | Stage | Group | Class | Command |
|---|---|---|---|---|
| 1 | `preflight` (H0, H1a) | S6 | read-only | `node scripts/hosted/preflight.mjs --run-id=RUN --authorized=S6@<SHA>` |
| 2 | `identity` (H1b) | S7 | mutating (one throwaway Auth user, deleted at once; its address is recorded before the request) | `node scripts/hosted/s7-apply.mjs identity --run-id=RUN --authorized=S7@<SHA> --confirm-mutating=identity` |
| 3 | `migrate` (H2a) | S7 | mutating, once | `node scripts/hosted/s7-apply.mjs migrate --run-id=RUN --authorized=S7@<SHA> --confirm-mutating=migrate` |
| | *owner: expose only `api`* | | | |
| 4 | `exposure` (H2b) | S7 | read-only | `node scripts/hosted/s7-verify.mjs exposure --run-id=RUN --authorized=S7@<SHA> --owner-confirmed=exposure` |
| | *owner: set the worker password* | | | |
| 5 | `worker-marker` (H2c) | S7 | mutating (one role comment) | `node scripts/hosted/s7-apply.mjs worker-marker --run-id=RUN --authorized=S7@<SHA> --confirm-mutating=worker-marker --owner-confirmed=exposure,worker-password` |
| 6 | `rerun` (H3) | S7 | mutating-capable no-op | `node scripts/hosted/s7-apply.mjs rerun --run-id=RUN --authorized=S7@<SHA> --confirm-mutating=rerun` |
| 7 | `inventory` (H4, H5a) | S7 | read-only | `node scripts/hosted/s7-verify.mjs inventory --run-id=RUN --authorized=S7@<SHA>` |
| 8 | `fixtures` (FX0, H5b, FX1) | S8 | mutating | `node scripts/hosted/fixtures.mjs --run-id=RUN --authorized=S8@<SHA> --confirm-mutating=fixtures` |
| 9 | `session-checks` (H6, H7, H8, **H8-default**) | S8 | mutating (H8 waits about 70 s; **`--default-window` adds the 16-minute hosted test, required for full acceptance**) | `node scripts/hosted/checks-session.mjs --run-id=RUN --authorized=S8@<SHA> --confirm-mutating=session-checks --default-window` |
| 10 | `worker-checks` (H9, H10) | S8 | mutating (one scoped job update; the worker job calls) | `node scripts/hosted/checks-worker.mjs --run-id=RUN --authorized=S8@<SHA> --confirm-mutating=worker-checks` |
| 11 | `catalog-checks` (H11) | S8 | mutating (keeps the pagination fixtures) | `node scripts/hosted/checks-catalog.mjs --run-id=RUN --authorized=S8@<SHA> --confirm-mutating=catalog-checks` |
| 12 | `isolation` (H12) | S8 | **mutating** (Auth sessions; probes that would run if isolation were broken) | `node scripts/hosted/isolation.mjs --run-id=RUN --authorized=S8@<SHA> --confirm-mutating=isolation` |
| 13 | `cleanup` (H13) | S9 | mutating, repeatable; closes the run | `node scripts/hosted/cleanup.mjs --run-id=RUN --authorized=S9@<SHA> --confirm-mutating=cleanup --owner-deletion-date=YYYY-MM-DD` |
| 14 | `evidence` (H14) | S9 | local only; available for failed and interrupted runs | `node scripts/hosted/evidence.mjs --run-id=RUN` (writes `docs/hosted/evidence/<date>-staging-<run id>.md`, or `...-2.md`, `-3.md` for a later record of the same run, never overwriting; add `--delete-raw` after review, once script cleanup is done) |

`cleanup` needs only `preflight`, so a failed or abandoned run can always be cleaned up. It finds the users of the run by the exact e-mail addresses recorded before each creation request (so an interrupted creation is found again), attempts every step even when one fails, and works before the application tables or the worker role exist. The synthetic content (hacks, versions, publications, decisions, ledgers) is append-only by design and is removed only by deleting the project.

## Evidence outcome

`evidence` states one of three outcomes and lists every required check as PASS, FAIL or **NOT RUN** (never silently absent):

* **COMPLETE**: every required check ran and passed (including H8-default), no stage failed, was interrupted or raised an unexpected error, script cleanup (H13a to H13c) is done, and the owner's deletion date is recorded.
* **INCOMPLETE**: nothing failed, but a required check did not run (for example H8-default without `--default-window`), a stage is not done, script cleanup is not done, or the date is missing or invalid.
* **FAILED**: any check failed, or any stage failed, was interrupted or raised an unexpected error, **in its current state or in any earlier attempt that a retry later replaced**.

The evidence reports script cleanup separately from the **owner cleanup that is still outstanding** (revoking or rotating the keys, deleting the password files, deleting the project); the scripts neither perform nor verify those.

## Local testing

* `npm test` runs `tests/hosted-scripts.test.ts`, `tests/hosted-scripts-correction.test.ts` and `tests/hosted-scripts-review2.test.ts` (target rejection, password-file and key-file checks, redaction, the SQL allowlist, the gates, the run lock, crash and unexpected-exception persistence, cleanup failure paths, deadline handling against a stub container runtime, evidence in a separate process, static limits) without Docker.
* `node scripts/hosted/selftest.mjs [--default-window]` needs the local Supabase stack running and Docker; set `SUPABASE_BIN` to the pinned CLI (`.tools/supabase/2.120.0/supabase`) and put Docker's `bin` on `PATH`. It resets the application state of the **local** database and then: proves the refusals; runs a concurrency scenario, an interruption scenario (SIGTERM) and a crash scenario (SIGKILL in the middle of `identity`, then cleanup before any application table exists); checks with real Docker that a statement past its deadline leaves no container and no running statement; runs the **real Supabase CLI against a genuinely blocked migration** (a held table lock) and shows that the server's own lock timeout, the identified cancellation, and the server's connection check each end the migration's session and locks within the bound, and that the real `migrate` stage with a deadline too short to finish ends failed, leaves no session and cannot be retried; runs the SIGKILL, recovery and approved-retry path and checks that the evidence stays FAILED; runs every stage in order from empty, each as a separate process; and runs `evidence` in a separate process after the secrets file was deleted, checking that no password or key reached any output, any file of the run, or the evidence. Without `--default-window` the evidence outcome must be INCOMPLETE with exactly H8-default NOT RUN; with it, COMPLETE. The `selftest` profile accepts only the local stack and needs `HOSTED_SELFTEST=1`; the `staging` profile accepts only the staging reference.
