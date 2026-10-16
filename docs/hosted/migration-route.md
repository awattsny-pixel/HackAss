# Migration route: direct connection only

**Status:** local implementation, awaiting source review. Nothing in this document has been run against staging by the code of this commit. Hosted behavior of the real migration CLI on the direct route is untested.

## 1. Decision

Migrations run **only** over the staging **direct** connection, `db.<ref>.supabase.co:5432`, as `postgres`. The pooler (`aws-0-us-east-1.pooler.supabase.com`, ports 5432 and 6543) is used by the application and the pooler/worker checks, with the separate login `postgres.<ref>`. A migration through a pooler is refused in code.

### Why not a pooler (local lab, Supavisor 2.9.13, session mode, the pinned Supabase CLI 2.120.0; Claude-reported, not hosted)
* startup `options` (lock, statement, idle-in-transaction timeouts and the connection check) are **ignored**: all four read 0 inside the CLI's own session;
* `application_name` is replaced by `Supavisor`; server connections are **reused** across clients and runs, so a session cannot be identified by its name or its start time;
* the `BackendKeyData` pid handed to the client is fabricated;
* a CLI **killed mid-file does not roll the file back**: the file ran to completion and committed about 20 s later (ledger row and all three tables), while the shipped identification matched zero sessions;
* a killed CLI's blocked session persisted for at least 75 s with no limit.
The runner of `0e1e2a1` is therefore unsuitable for pooled execution; it was accepted only for a direct connection. Full record: `pooler-lab/FINDINGS.md` and its checksum manifest (outside the repository).

### Why the direct route is acceptable (measured)
* local direct connection (the disposable stack): the four startup limits survive the CLI's `RESET ALL`, a killed CLI's session ends within about 2 s, and the interrupted file is rolled back completely;
* **S6B on staging (run `stg-<date>-direct1`, ten checks passed, `psql` probes only):** TLS 1.3 with `sslmode=require`; the options are honored; the timeouts fire; a client killed mid-statement is noticed by the server in under a second; the shipped identification predicate matched exactly one positively identified probe. The real CLI on the hosted direct route has **not** been run.

## 2. What changed in the scripts
| Item | Before | Now |
|---|---|---|
| Migration target (`STAGING_MIGRATE_*`) | pooler as `postgres.<ref>`, or direct as `postgres` | **direct only**: host exactly `db.<ref>.supabase.co`, port 5432, login `postgres` |
| Pooler login | the migration login was reused for the pooler endpoints | new `STAGING_POOLER_USER`, exactly `postgres.<ref>` (selftest: `postgres`, or `postgres.<tenant>` for a local pooler lab) |
| `session` / `txn` endpoints | `targets.migrate.user` | `targets.poolerUser` |
| TLS on the migration route | `sslmode=require` (encrypted, certificate not verified) | **`sslmode=verify-full`** (certificate and host name) against the owner-supplied root certificate `STAGING_SSLROOTCERT`, for the migration endpoint (psql) and the CLI; the pooler endpoints still use `require` |
| Password file | migration login + worker + (same login) at the pooler | `postgres` at the direct host `:5432`; `postgres.<ref>` at the pooler `:5432` and `:6543`; `hackass_worker.<ref>` at the pooler `:5432` and `:6543` |
| Refusal of a pooler migration | none | H0 (`lib/config.mjs` `migrationRouteErrors`); `cliUrl`; and the first statement of `pushMigrations` (`assertDirectMigrationTarget`), before the server clock is read, the database contacted or the CLI started |
Migration SQL (`supabase/migrations`) is unchanged from `0e1e2a1` (asserted by a test).

**Shown locally with the repository code and a real Supavisor (lab record `split-proof.mjs`):** the `migrate` endpoint connects directly as `postgres` (the server sees the client's own application name), the `session` and `txn` endpoints connect through the pooler as `postgres.<tenant>` (the server sees `Supavisor`); the previous shape, the migration login reused for the pooler, is refused by the pooler (and, with the real password file, already by H0 because the file has no such entry); the bounded runner's dry-run over the direct target lists the 21 pending migrations.

## 3. Environment and password file
```
STAGING_REF=<ref>   STAGING_URL=https://<ref>.supabase.co
STAGING_MIGRATE_HOST=db.<ref>.supabase.co   STAGING_MIGRATE_PORT=5432   STAGING_MIGRATE_USER=postgres
STAGING_POOLER_USER=postgres.<ref>
STAGING_POOLER_TXN_HOST=<pooler host>   STAGING_POOLER_TXN_PORT=6543
STAGING_POOLER_SESSION_HOST=<pooler host>   STAGING_POOLER_SESSION_PORT=5432
STAGING_WORKER_USER=hackass_worker.<ref>
STAGING_PGPASSFILE=<0600 file>  STAGING_SSLROOTCERT=<root certificate file, writable by you only>  STAGING_PUBLISHABLE_KEY_FILE=<0600 file>  STAGING_SECRET_KEY_FILE=<0600 file>  FORBIDDEN_PROJECT_REFS=<legacy ref>
```
The existing password file (five lines, added by the approved helper) already satisfies these requirements. Only host, port, database and login columns are ever read.

## 4. Exact proposed S7 commands (NOT authorized; for review)
`SHA` is the full SHA of the reviewed commit; `RUN` is a fresh run id (for example `stg-<date>-s7a`). The stage dependencies require `preflight` in the same run, so the first S7 run begins with a fresh S6 preflight under the new environment.
```bash
#!/bin/bash
# Save as a file and run it as `bash s7.sh A` or `bash s7.sh B`. Any failing command stops the sequence at once; nothing after it is run.
set -euo pipefail
cd "<repository>"
D="<private directory>"; R=<ref>; H=<pooler host>; SHA=<the reviewed commit>; RUN=<fresh run id>
# docker must be on PATH
S7ENV=(env -u HOSTED_SELFTEST STAGING_REF=$R STAGING_URL=https://$R.supabase.co STAGING_MIGRATE_HOST=db.$R.supabase.co STAGING_MIGRATE_PORT=5432 STAGING_MIGRATE_USER=postgres
  STAGING_POOLER_USER=postgres.$R STAGING_POOLER_TXN_HOST=$H STAGING_POOLER_TXN_PORT=6543 STAGING_POOLER_SESSION_HOST=$H STAGING_POOLER_SESSION_PORT=5432 STAGING_WORKER_USER=hackass_worker.$R
  STAGING_PGPASSFILE="$D/pgpass" STAGING_SSLROOTCERT="$D/supabase-root-ca.pem" STAGING_PUBLISHABLE_KEY_FILE="$D/publishable.key" STAGING_SECRET_KEY_FILE="$D/secret.key" FORBIDDEN_PROJECT_REFS=<legacy ref>)
# one stage; a non-zero exit status prints which one failed and ends the whole script (the stage itself is then failed and is never retried)
step() { echo "== $*"; "${S7ENV[@]}" node "$@" || { echo "STOP: '$*' failed (exit $?). Nothing further was run." >&2; exit 1; }; }
case "${1:-}" in
  A) # read-only preflight, then the two mutating stages that precede the migration
    step scripts/hosted/preflight.mjs       --run-id=$RUN --authorized=S6@$SHA
    step scripts/hosted/s7-apply.mjs identity --run-id=$RUN --authorized=S7@$SHA --confirm-mutating=identity
    step scripts/hosted/s7-apply.mjs migrate  --run-id=$RUN --authorized=S7@$SHA --confirm-mutating=migrate ;;
  B) # only after the owner has exposed ONLY the api schema and set the worker password
    step scripts/hosted/s7-verify.mjs exposure --run-id=$RUN --authorized=S7@$SHA --owner-confirmed=exposure
    step scripts/hosted/s7-apply.mjs worker-marker --run-id=$RUN --authorized=S7@$SHA --confirm-mutating=worker-marker --owner-confirmed=exposure,worker-password
    step scripts/hosted/s7-apply.mjs rerun    --run-id=$RUN --authorized=S7@$SHA --confirm-mutating=rerun
    step scripts/hosted/s7-verify.mjs inventory --run-id=$RUN --authorized=S7@$SHA ;;
  *) echo "usage: bash s7.sh A|B" >&2; exit 2 ;;
esac
```
Each stage is a separate process and the script above stops at the first non-zero exit status (a test runs this very block with a stub that fails each stage in turn); each mutating stage runs once per run; a failed or interrupted stage blocks the run and is never retried (only `cleanup` and `evidence` run after it). The paths are quoted so that directories with spaces work (the real ones do; a test runs the block from and with paths that contain spaces). The `migrate` stage: checks the target ledger is empty and the dry-run lists exactly the 21 repository migrations, applies them with the bounded runner, then checks the ledger equals the repository.
The root certificate file must exist first (section 6). The first command, the fresh S6 preflight, is also the first hosted proof of certificate verification: its platform-facts queries to the direct host use `verify-full` and fail if the certificate or the host name does not verify. The worker password is set later by the owner; until then the worker lines in `pgpass` are the nonfunctional placeholder, so step B's worker checks cannot pass before that.

## 5. Per-file recovery procedure
**Facts this relies on (measured locally; hosted unverified):** the CLI applies each migration file in **one transaction together with its ledger row**; a failing file is rolled back completely and earlier files stay committed; a CLI killed on the direct route has its server session ended within about 2 s and the interrupted file is rolled back. A static scan of the 21 files found no top-level `BEGIN`/`COMMIT`/`ROLLBACK`/`START TRANSACTION` and no non-transactional DDL (`CONCURRENTLY`, `VACUUM`, `CREATE DATABASE`, `ALTER TYPE ... ADD VALUE`):
```bash
grep -nEi "^\s*(begin\s*;|commit\b|rollback\b|start transaction)|concurrently|\bvacuum\b|alter system|create database|alter type [a-z_.]+ add value" supabase/migrations/*.sql   # expect no output
```
Atomicity is per file, **not** per batch.

After any failure, deadline or interruption of `migrate` (or `rerun`):
1. **Do not retry the stage.** Read the stage's error. It says whether the migration's database session end was **proven** or **NOT PROVEN**.
2. **NOT PROVEN, or in doubt:** the owner lists the sessions of the `postgres` login in the dashboard SQL editor and ends only a session that is the migration's: `select pid, application_name, state, wait_event_type, left(query, 80) from pg_stat_activity where usename = 'postgres' and pid <> pg_backend_pid();` (the CLI's session is named `@effect/sql-pg`); repeat until nothing of the migration remains. Nothing below is valid before this.
3. **Inventory what committed (read-only).** The committed files are exactly the ledger versions; the first repository file not in the ledger is the interrupted or failed one:
```bash
{ echo "begin read only;"; node -e "import('./scripts/hosted/lib/sql.mjs').then(m=>console.log(m.LEDGER_EXISTS_SQL+';\n'+m.FINGERPRINT_SQL+';'))"; echo "rollback;"; } \
 | docker run --rm -i -v "$D/pgpass:/pgpass:ro" -e PGPASSFILE=/pgpass public.ecr.aws/supabase/postgres:17.11.0.004 psql "host=db.$R.supabase.co port=5432 dbname=postgres user=postgres sslmode=require connect_timeout=15" -X -w -q -At
# then, only if the first line is "true":   select version || ' ' || name from supabase_migrations.schema_migrations order by version;  (same way)
```
4. **Supporting evidence, never proof.** Compare the staging catalog fingerprint with the fingerprint a disposable local stack gets from applying exactly the first N committed files (N = the ledger count): reset the local application state, run the CLI with a work directory holding only those N files, and compute the same fingerprint. `FINGERPRINT_SQL` hashes only the function definitions with their ACLs, the schema ACLs, and the names, ACLs and row-security flag of the tables, views, materialized views and sequences in the application schemas. It does **not** cover table columns, constraints, indexes, triggers, policies, role attributes or data, so **equal fingerprints do not show that the interrupted file left nothing, and equality alone never clears recovery.** An unexplained **difference** is a finding to investigate. Recovery is cleared only by all of: the session end proven, the ledger an exact prefix of the repository files, no unexplained difference, and a fuller comparison that the CTO accepts (for example a schema-only dump of staging compared with the same dump of the local rebuild; not implemented or rehearsed here). Otherwise treat the project as not recoverable and recreate it.
5. **Decide (CTO/owner).** The `migrate` stage requires an empty ledger on staging, so a partially migrated project cannot simply be resumed by the stage. Because staging is disposable and holds no data, the simplest safe recovery for any NOT PROVEN or mismatch is a new staging project (new keys, new password file, and the IPv4 add-on again). Resuming from an exact ledger prefix would need a reviewed code change.
6. Keep the evidence: run `evidence` (it records the failed attempt), and do not delete the failed run directory.

**Rehearsed locally (disposable stack, direct connection, the real 21 migrations, Claude-reported):** the first 7 files applied twice give the same catalog fingerprint (the method is deterministic); applying the first 8 files with the 8th failing at its last statement leaves the ledger at exactly the first 7 and the fingerprint identical to the 7-file one (consistent with, but not proof of, the failed file leaving nothing); applying the 8th file outside the ledger (a partial or unexplained change) makes the fingerprint differ, so a difference of that kind is detected (a change outside what the fingerprint covers would not be). The script (`recovery-rehearsal.mjs`) is kept outside the repository with the lab record.

## 6. Server certificate verification (implemented locally; not yet exercised against the hosted server)
**What the code does.** The staging profile requires `STAGING_SSLROOTCERT`, the Supabase root certificate (public) that the owner downloads from the dashboard's database SSL settings (wording to confirm) and stores outside the repository where only they can write it. It is checked as a trust anchor before use (`lib/rootcert.mjs`): an absolute path, a regular file that is not a symbolic link, owned by the caller, not writable by group or others, outside the checkout, at most 64 KB, PEM `CERTIFICATE` blocks only (no private key, no stray text), every certificate parseable and currently valid. The migration endpoint (psql, the file mounted read-only into the client container) and the CLI (`sslmode=verify-full&sslrootcert=<path>` in the URL) connect with certificate **and host-name** verification; the URL builder cannot produce a staging URL without it. The pooler endpoints still use `sslmode=require`: whether the pooler's certificate chains to the same root is not known.
**Measured locally on a throwaway TLS-only Postgres with a test CA generated for the purpose (psql 17 in a container and the pinned CLI 2.120.0; Claude-reported):**
| Case | psql | CLI |
|---|---|---|
| `verify-full`, right CA, name in the certificate | connected, TLS 1.3 | connected (the CA path contained a space) |
| `verify-full`, unrelated CA | refused: certificate verify failed | refused: unable to verify the first certificate |
| `verify-full`, name not in the certificate | refused: certificate does not match host name | refused: hostname/IP does not match the certificate's altnames |
| `verify-full`, no root certificate given | refused: root certificate file missing | refused: unable to verify the first certificate |
| `verify-full`, root certificate file missing | n/a | refused: failed to read sslrootcert |
| `sslmode=require` (what S6 and S6B used), wrong CA and/or wrong name | **connected** | **connected** |
| `verify-ca`, name not in the certificate | **connected** | not tested |
So `require` verifies nothing, and only `verify-full` is acceptable.
**Not established, and what would establish it.** That the Supabase root certificate the owner provides validates the real direct host's certificate and name: the fresh S6 preflight under the new environment (section 4, step 1) is the first hosted test, it is read-only, and it fails if the certificate does not verify. That the CLI's verification works against the hosted server: the `migrate` stage starts with a dry-run through the CLI, which fails before anything is applied if it does not (a failed stage cannot be retried, so a new run would be needed). That the pooler certificates chain to the same root. How certificate rotation or expiry is handled (the file is checked for validity at the start of every stage).

## 7. What this does not establish
* the real CLI on the hosted direct route (S6B used `psql`); the 21 migrations on staging;
* the server certificate against the real server (only measured on a local test server);
* that the lab's pooler behavior equals the hosted one (the migration route no longer depends on it).

## 8. Local verification record (Claude-reported; failures kept)
* **Unit tests:** the full suite passed (312 of 312) after the documentation tests were updated for this document. An earlier full run had three failures: two were this document breaking the `docs/hosted` guard tests (fixed), and one was a timing-sensitive smoke-harness test (`smoke-cleanup`, about 2 s) that passes alone and passed in the next full run; it may be the earlier undiagnosed intermittent failure, but its cause is not established.
* **Selftest (standard, without the 15-minute window), six full runs on this change:** run 1 to 3: two failures each, run 4: one failure, all of them the container-survival checks in section 3 and at the end of the run (a `Created` psql client container left behind); run 5: six failures after empty-error Docker query failures (the deadline check, then the preflight stage and the checks that depend on it); run 6: all checks passed. In runs 1 to 4 every stage of the chain, the evidence and the secret checks passed.
* **Not caused by this change, but not explained either:** the previous commit's full selftest passed once on the same day, yet repeating only the first three selftest sections failed in 4 of 6 runs on the previous commit and in 4 of 6 on this one, and a loop of the SIGTERM scenario left a `Created` container in 6 of 12 iterations on each. The likely mechanism is a race between a killed Docker client and the daemon creating the container; a separate change is investigating it. **One green run does not resolve the causes of the failed ones.**
* **Interference:** a second Claude session ran Docker-backed loops against the same daemon and local stack during the later runs; each session's cleanup removed `hackass-psql-*` containers belonging to the other. Some of the failures in runs 5 and 6 and in the comparison loops may therefore be interference. The sessions agreed to stop overlapping.
* **Certificate verification and the real CLI on the hosted direct route** are still open (section 6).

