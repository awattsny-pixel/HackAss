# Hosted verification procedure (staging)

**Prepared, not executed.** Each check names what it proves, whether it is **read-only** or **mutating**, the proposed command, the pass criterion and the local result it is compared with. Nothing here has been run against any hosted system.

## 0. Conventions

### 0.1 Targets and secrets

* **Targets come from environment variables** set by the owner in the operator's shell for the duration of a run (names only; no value is ever written to the repository, printed, or logged):

  | Variable | Meaning |
  |---|---|
  | `STAGING_REF` | the staging project reference |
  | `STAGING_URL` | `https://<ref>.supabase.co` (API, Auth, REST) |
  | `STAGING_MIGRATE_HOST`, `STAGING_MIGRATE_PORT`, `STAGING_MIGRATE_USER` | the endpoint and login used for migrations and owner-side SQL: ONLY the direct host `db.<ref>.supabase.co`, port 5432, user `postgres` (a migration through a pooler is refused; see `migration-route.md`) |
  | `STAGING_POOLER_USER` | the login for the pooler transaction and session checks: `postgres.<ref>` |
  | `STAGING_POOLER_TXN_HOST`, `STAGING_POOLER_TXN_PORT` | the pooler **transaction-mode** endpoint |
  | `STAGING_POOLER_SESSION_HOST`, `STAGING_POOLER_SESSION_PORT` | the pooler **session-mode** endpoint |
  | `STAGING_WORKER_USER` | `hackass_worker.<ref>` |
  | `STAGING_PGPASSFILE` | path of a password file (section 0.2) |
  | `STAGING_PUBLISHABLE_KEY`, `STAGING_SECRET_KEY` | API keys, read by the scripts from the environment (or from a file named by `<VARIABLE>_FILE`), **never placed in a command line or a URL** |
  | `FORBIDDEN_PROJECT_REFS` | comma-separated project references that must never be targeted |

* **Tooling.** The checks are run by the script set under `scripts/hosted/` (its README gives the stage order, gates and commands), which was written and reviewed before any run. It refuses to start unless `H0` passes; reads only the variables above; never prints a secret; passes secrets to HTTP clients through headers set in code (not through `curl -H` arguments); writes raw output only to a directory outside the repository; and contains none of the local container, reset or rollback logic. **Run state fails closed:** a run is bound to one reviewed commit, one profile and one validated target set; a stage that failed, was interrupted (killed, or stopped by a signal) or raised an unexpected error is recorded and blocks every later stage, and is never restarted automatically (only `cleanup` and `evidence` may continue such a run; a read-only stage may be re-attempted after review with `--retry-after-review`); two processes cannot run stages against one run at once; every database call, process and container has a deadline that stops the underlying operation; and every credential file (password file, API-key file) must be a private regular file outside the checkout (not a symbolic link, mode `0600`, owned by the operator) before it is read or mounted. SQL snippets below are inline so they can be reviewed.
* **Classification.** *Read-only*: sends only queries or GET requests that change nothing. *Mutating*: creates, changes or deletes hosted state (users, sessions, rows, roles, role comments, migrations). A mutating check is run only after the previous checks passed and only against the staging project.
* **Stop rule.** Any failed check stops the run. The output (redacted) is the result; nothing is patched by hand on the hosted database and no check is retried until the cause is understood and reviewed.

### 0.2 Database connection method: password file, never an argument (verified locally)

**Method.** Every database connection (the Supabase CLI's `db push`, `psql`, and the Node scripts) takes its password from a **libpq password file**: `STAGING_PGPASSFILE`, exported to those processes as `PGPASSFILE`. The file is created by the owner out of band (mode `0600`, in a directory outside the repository, for example under the owner's home directory), one line per login:

```
<host>:<port>:postgres:<login>:<password>
```
with lines for the migration login (`postgres` on the direct host), for the pooler transaction and session endpoints (`postgres.<ref>`), and for `hackass_worker.<ref>`. It is never read, printed or copied by me; the scripts only check that it exists, is outside the working tree, and has mode `0600` (H0).

**Migration command.** The URL carries no password:
```
PGPASSFILE="$STAGING_PGPASSFILE" supabase db push \
  --db-url "postgresql://postgres@db.$STAGING_REF.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=<URL-encoded path of $STAGING_SSLROOTCERT>" --dry-run
```
(the same without `--dry-run` for the real run). The migration login is `postgres` on the direct host, which is not a secret (the pooler login `postgres.<ref>` is used only for the pooler checks). `psql` uses the same file: `PGPASSFILE=... psql "host=... port=... dbname=postgres user=... sslmode=require"`.

**Never:** a password inside the URL or any argument; `SUPABASE_DB_PASSWORD` (see below, it is not honoured with `--db-url`); `--debug` (not shown to leak in the test below, but its output on a hosted target is unknown); `supabase link`.

**What was verified, locally, on 2026-10-15, with the pinned CLI 2.120.0 against the disposable local stack** (`db push --db-url ... --dry-run`, a sentinel password set on the local `postgres` role and restored afterwards; no hosted system involved):

| Case | Result |
|---|---|
| no password source at all (control) | fails: `password authentication failed` |
| `PGPASSFILE` with the right password, URL without a password | succeeds (`"upToDate":true`); the sentinel appears **0** times in the output and in the process argument list |
| a wrong password in the password file | fails with the same error (so the file is consulted); the wrong value is not echoed |
| `PGPASSWORD` in the environment | succeeds; sentinel not in the output (the value is in the process environment, readable by the same user) |
| `SUPABASE_DB_PASSWORD` in the environment, URL without a password | **fails**: not honoured with `--db-url`; do not rely on it |
| same as the password-file case with `--debug` | succeeds; sentinel not in the output |
| password inside the `--db-url` argument | the sentinel **is visible in `ps`** while the command runs: this is the form that is forbidden |

**Not verified (unknown until the first hosted step):** TLS to the hosted pooler (the local test used a plaintext connection), the pooler's login form, and the exact wording of the hosted "up to date" message. The first hosted action is a read-only `--dry-run`, which fails closed with an authentication error if the password file is not honoured; nothing is applied on that run.

## 1. Forbidden against staging

These exist for the **local disposable stack** and must never be pointed at a hosted database:

* `supabase db reset`, `supabase stop --no-backup`, `supabase start`, `supabase test db` (local stack lifecycle; `db reset` drops and rebuilds a database).
* every `scripts/local-f2*-checks.mjs` and `scripts/local-auth-spikes.mjs` and `scripts/db-test.mjs` (they `docker exec` into the local container, insert staff by direct SQL, mutate clocks and tamper rows, and include **committed rollback** checks R6, R7, R8).
* every file in `supabase/rollbacks/` (hand-applied local reversal scripts; deleting from `schema_migrations`).
* `supabase link` (writes the project reference into the checkout) and `supabase db push --linked`, `supabase db remote commit`, `supabase db pull`, and any `--include-all` or `--include-seed` flag.
* the pgTAP files under `supabase/tests/database/` (they assume the local role setup and disable triggers).

Hosted scripts must also refuse any SQL containing `drop schema`, `drop role`, `truncate`, `disable trigger` or `schema_migrations` writes. **The only permitted direct-SQL data changes** (everything else goes through the application's own RPCs, the Auth API or the migration run) are these, each scoped to a synthetic fixture. **Who runs them matters:** role administration runs **as `postgres` itself** (the migration login) and never after `set role`; `set role hackass_owner` is reserved for **application fixture DML** (and owner-side reads of application tables). The guard in `scripts/hosted/lib/sqlguard.mjs` enforces this split.
* the migration run itself (H2a), as `postgres`;
* **role administration, as `postgres`:** the worker-role marker, a role comment: `comment on role hackass_worker is '<nonce>'` (H2c) and its removal `comment on role hackass_worker is null` (H13). (A custom setting such as `alter role hackass_worker set hackass.staging_marker` was tried first and is refused for a non-superuser `postgres`, found by running the scripts against the local stack, so a role comment is used; it has no behavioural effect);
* **application fixture DML, as `hackass_owner` after `set role hackass_owner`:**
  * the synthetic category (no migration seeds one): `insert into app.categories (slug, name) values ('stg-<run>', 'Staging check') on conflict do nothing`;
  * **staff-assignment setup**, once per staff fixture (`s-rm`, `s-mfa`, `s-rev`): `insert into app.staff_assignments (user_id, role, granted_by) values ('<fixture user id>', 'reviewer', 'staging-check')`, the statement shape the local checks use;
  * **staff-assignment revocation**, for `s-rm` in H7 (and any assignment still active at H13, if the delete trigger has not already revoked it): `update app.staff_assignments set revoked_at = now(), revoked_by = 'staging-check' where user_id = '<fixture user id>' and revoked_at is null`;
  * the one scoped job update of H10 (`available_at` of the single synthetic job, one atomic block that raises unless exactly one row changes);
* the read-only queries of the checks.
A statement outside these shapes, or one naming a user id that is not a fixture created in this run, is refused by the script.

## 2. Fixture users and the sequence they allow

Each check that signs a user out, changes staff membership or consumes a job uses a **dedicated** fixture so later checks never depend on a state an earlier check destroyed. Every later check starts with its **own fresh sign-in**; no token is reused across checks unless a check says so. All emails are `staging-<run>-<name>@example.test`; users are created through the Auth admin API with the confirmed flag (sign-ups stay closed).

| Fixture | Role | Created in | Used by | End state |
|---|---|---|---|---|
| `ident` | throwaway Auth user | H1b | H1b only | deleted inside H1b |
| `b1` ("author") | confirmed member; authors every synthetic hack | H5b | H5b, H10, H11, H12 | active until H13 |
| `b2` | confirmed member | H5b | H5b only | deleted in H5b |
| `s-sess` | confirmed member, **dedicated to H6** | H6 | H6 only (signed out on purpose) | signed out; deleted in H13 |
| `s-rm` | staff reviewer with TOTP, **dedicated to H7** | H7 | H7 only (assignment revoked on purpose) | assignment revoked in H7; user deleted in H13 |
| `s-mfa` | staff reviewer with TOTP, **dedicated to H8** | H8 | H8 only | assignment active until H13 |
| `s-rev` | staff reviewer with TOTP, active assignment | H10 setup | H10 setup, H11, H12 | assignment revoked and user deleted in H13 |

Because staff membership is changed only for `s-rm`, and sign-out happens only for `s-sess`, nothing downstream loses its session or its role. H8's long wait (step 3) runs on its own user and may overlap other checks. A staff fixture needs an `aal2` token: enroll a TOTP factor, verify it with a computed code, and use the resulting token; the factor secret lives in memory only.

## 3. Checks

### H0. Preflight guard (read-only, local, no network)
Proves every connection the run will make is aimed at the staging project and nothing else. A correct API reference alone does not establish that the database connections reach the same project, so each endpoint is validated separately, and H1b adds a live cross-check.
* `STAGING_REF` is set and not in `FORBIDDEN_PROJECT_REFS`; no variable contains a forbidden reference as a substring of a host, user or URL.
* **API:** `STAGING_URL` equals `https://$STAGING_REF.supabase.co` exactly.
* **Database (migration login):** user `postgres` with host exactly `db.$STAGING_REF.supabase.co` and port 5432. A pooler host, the login `postgres.<ref>` or port 6543 for migrations is refused. **Pooler login:** `STAGING_POOLER_USER` is exactly `postgres.$STAGING_REF`.
* **Pooler transaction endpoint and pooler session endpoint:** each host ends `.pooler.supabase.com` (not loopback, private, link-local or a container name); the transaction port is 6543 and the session port is 5432; both are the same host (one project, one region), and different from the migration host.
* **Worker login:** `STAGING_WORKER_USER` equals `hackass_worker.$STAGING_REF`.
* **Password file:** `STAGING_PGPASSFILE` exists, has mode `0600`, is outside the repository working tree, and every entry's login carries the same `$STAGING_REF` suffix (or is the direct-host `postgres` login for `db.$STAGING_REF.supabase.co`); the check reads only the host, port, database and login fields and never the password field.
* Decode only the `ref` claim of the staging keys **if they are JWTs** and require it to equal `STAGING_REF` (a mismatch means a key belongs to another project). Never print a key.
Pass: all conditions hold. Fail: stop; nothing was contacted.

### H1. Platform facts (H1a, read-only) and the live identity proof (H1b, mutating)
*H1a (read-only).* Records the facts that replace assumptions (spikes S3, S4, S6). Proposed:
```sql
select version();                                    -- expect Postgres 17.x; record the minor version
select name, installed_version from pg_available_extensions where name in ('pgcrypto','citext','pg_trgm') order by 1;
select rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin from pg_roles where rolname in ('postgres','authenticator','anon','authenticated','service_role','supabase_auth_admin') order by 1;
select schema_name from information_schema.schemata where schema_name in ('app','app_guard','api','worker','app_bridge','app_content','app_review','app_budget') order by 1;   -- before H2: expect none
select has_schema_privilege('postgres','auth','usage') as postgres_auth_usage, has_table_privilege('postgres','auth.sessions','select') as postgres_sessions_select;
select count(*) as public_objects_before from pg_class where relnamespace = 'public'::regnamespace;   -- recorded; compared in H4
```
HTTP (GET): `$STAGING_URL/auth/v1/settings` (disable_signup, external providers, mailer settings) and `$STAGING_URL/auth/v1/.well-known/jwks.json` (signing algorithm). Run once through each of the three database endpoints (migration, pooler session, pooler transaction) as the `postgres` login. Pass: Postgres major is 17; the three extensions are available; `postgres_auth_usage` and `postgres_sessions_select` are true; sign-ups are disabled; the provider list matches section 3 of the staging plan; the three endpoints return the same version string and the same `public_objects_before`.

*H1b (mutating, minimal): the API and every database endpoint are the same project.* Generate a random nonce. Create the fixture `ident` through the Auth admin API on `$STAGING_URL` with the email `staging-<nonce>-ident@example.test`. Then, through **each** of the migration endpoint, the pooler session endpoint and the pooler transaction endpoint as `postgres`, run `select count(*) from auth.users where email = 'staging-<nonce>-ident@example.test';`. Delete `ident` through the admin API and confirm the count is 0 through one endpoint.
Pass: the count is **1 on all three** endpoints before the deletion and 0 after. A 0 on any endpoint means that endpoint is a different project or database: stop and report, apply nothing. (The worker endpoint is proven in H2c, once the worker role exists.)

### H2. Apply the 21 migrations (H2a mutating once; H2b exposure; H2c worker endpoint proof)
*H2a (mutating, once).* With the method of section 0.2:
```
PGPASSFILE="$STAGING_PGPASSFILE" supabase db push --db-url "postgresql://postgres@db.$STAGING_REF.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=<URL-encoded path of $STAGING_SSLROOTCERT>" --dry-run   # lists the 21 pending, in filename order; changes nothing
PGPASSFILE="$STAGING_PGPASSFILE" supabase db push --db-url "postgresql://postgres@db.$STAGING_REF.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=<URL-encoded path of $STAGING_SSLROOTCERT>"             # applies them, stopping at the first failure
```
The `--dry-run` listing is compared with `staging-plan.md` section 4 before the real run. Pass: all 21 apply; `select count(*) from supabase_migrations.schema_migrations where version like '2026%'` is 21; the versions match the filenames. A failure is a **hosted-specific risk** from the staging plan: record the failing file and error, stop and report. Do not edit the migration or the database to get past it.

**The migration's database work is bounded, not only the CLI process.** Killing the CLI does not end its server session (measured: a blocked migration's session survived 47 s after the CLI was killed, with its transaction and lock). The script therefore (1) gives the CLI's session **server-side limits** as startup options: no lock wait over 30 s, no statement over 300 s, no idle-in-transaction time over 60 s, and a connection check every 2 s that ends a session whose client has died; (2) reads the **server clock** before starting the CLI and identifies the CLI's session narrowly (same login, the CLI's own session name `@effect/sql-pg`, started after that clock reading; the CLI ignores an `application_name` given in the URL); and (3) after a deadline (600 s, 120 s for the dry run), a failure or truncated output, waits for the server to end the session, then cancels it, then terminates it (waits of at most 10 s and 30 s), and **verifies** that no such session remains, that no lock is held by one, and that no session of the login is left waiting on a lock or idle in a transaction. If that cannot be shown the error says **NOT PROVEN**. This holds on a **direct** connection only; through a pooler it does not (the startup limits are ignored, sessions are renamed and reused, and a killed CLI's file still commits, so the verification could report a false clean result), which is why a pooler migration target is refused before anything starts (`migration-route.md`). Either way the stage is failed and, being mutating, can never be retried: the run is cleaned up and a new one started. The limits and the identification were verified on the local stack's direct connection and, with `psql` probes only (S6B), on staging's direct host; the real CLI on the hosted direct route has not been run. A pooler provides none of them (measured in the lab) and does **not** fail closed: it can produce a false clean result, so a pooler migration target is refused by the route guard before anything starts.

*H2b (owner action, then read-only verification): expose `api` only, after it exists.* The `api` schema is created by migration 1, so the Data API's exposed-schema list can only be set to `api` **now** (not earlier). The owner sets "Exposed schemas" to `api` alone and removes `public` and `graphql_public`; the platform reloads its schema cache. Until this step the project has no application object in any exposed schema (H4 checks that `public` is unchanged), so nothing application-related is reachable over HTTP in the meantime. Verification (read-only), two separate questions with two credentials. **Metadata** (what is listed): `GET $STAGING_URL/rest/v1/` with `Accept-Profile: api`, read with the **secret key** in the `apikey` header only (never a Bearer header), returns an OpenAPI document whose `/rpc/` paths are `api` functions only (the allowlist in H12) and which lists no table or view. Supabase serves this root to a secret key only: a publishable or member credential gets HTTP 401 (S7 part B recorded `OpenAPI description: HTTP 401` with the publishable key; self-hosted stacks and the local selftest are unaffected). **Public access and isolation** (what a credential may reach): the anonymous (publishable-key) credential calls an actual endpoint, `POST /rest/v1/rpc/list_public_hacks` with the schema as the profile, and the verification asserts the exact refusal, not merely an error: `app`, `public` and `graphql_public` each answer HTTP 406 with PostgREST code `PGRST106`, and the exposed-schema list in that answer is exactly `api` (for `public` and `graphql_public`; for `app` it must name no private schema). No HTTP-based check (H5b onward) runs before H2b passes.

*H2c (mutating, minimal): the worker endpoint is the same project.* As `postgres` through the migration login (role administration, no `set role`) set a marker with a fresh nonce: `comment on role hackass_worker is '<nonce>';` Then, as `hackass_worker` through **each** of the pooler transaction and session endpoints, run only `select shobj_description(r.oid, 'pg_authid') from pg_roles r where r.rolname = current_user;`.
Pass: it equals the nonce on both. Otherwise stop before using the worker for anything else. The marker is removed in H13 (`comment on role hackass_worker is null;`).

### H3. Migration runner invoked again with nothing pending (read-only dry-run; mutating-capable no-op)
Proves G-1 as interpreted in the F2-F review: a second invocation applies nothing already recorded.
1. Before: `select count(*) , md5(string_agg(version, ',' order by version)) from supabase_migrations.schema_migrations;` and a **catalog fingerprint** (md5 over the sorted `pg_get_functiondef` of every function in the application schemas plus the sorted ACLs of the application schemas, tables and functions).
2. The `--dry-run` command of H2a (read-only): expect a statement that the remote database is up to date and no pending migrations.
3. The real command of H2a (expected to be a no-op).
4. After: the same two queries.
Pass: step 2 lists nothing; ledger count and checksum are unchanged (21); the catalog fingerprint is unchanged; no error. (The role comment of H2c is not part of the fingerprint; it is a shared-catalog comment, recorded separately.)

### H4. Catalog inventory against the golden (read-only)
Runs the function-inventory query from `supabase/tests/database/010_roles_and_grants.test.sql` (the `$golden$` block and the query above it) on staging and diffs it with the golden text. Also: role attributes of `hackass_owner` and `hackass_worker`; no table, column or sequence privilege for `anon`, `authenticated` or `hackass_worker` in the application schemas; `hackass_owner` holds no privilege on `auth`; `select count(*) from pg_class where relnamespace = 'public'::regnamespace` equals `public_objects_before` from H1a. Also: no *effective* column privilege and no sequence privilege (`has_column_privilege`, `has_sequence_privilege`) for those three roles in the application schemas, and row-level security enabled on every application table.
Pass: the inventory equals the golden **exactly** (101 functions); zero table privileges; roles have the required attributes (`NOLOGIN`/`LOGIN`, `NOINHERIT`, connection limits 0 and 10); `public` is unchanged. Local analogue: pgTAP 010; `local-f2a-checks.mjs`.

### H5. Auth triggers and the session bridge exist and fire
*H5a (read-only):* `select tgname, tgenabled from pg_trigger where tgrelid = 'auth.users'::regclass and tgname like 'hackass_%' order by 1;` expects `hackass_account_created` and `hackass_account_deleted`, enabled. `select proowner::regrole, prosecdef, proconfig from pg_proc where oid = 'app_bridge.session_valid(uuid,uuid)'::regprocedure;` expects owner `postgres`, `SECURITY DEFINER`, `search_path=""`; `has_function_privilege('hackass_owner','app_bridge.session_valid(uuid,uuid)','execute')` is true and false for `anon`, `authenticated`, `hackass_worker`.
*H5b (mutating):* create fixtures `b1` and `b2` (section 2): expect one `app.accounts` row each with status `active` (read with a `postgres` session using `set role hackass_owner`). Delete `b2` through the admin API: expect its account `status = 'deleted'` and no active staff assignment (the delete trigger). Pass: all as stated. `b1` stays active as the author fixture. Local analogue: `020`, `local-f2a-checks.mjs`.

### H6. Session revocation and the in-database session check (mutating, dedicated user)
Create `s-sess`. Sign in (`/auth/v1/token?grant_type=password`), record `expires_in` and the token header algorithm. Call `api.whoami` through PostgREST with the access token: expect HTTP 200. Sign out (`/auth/v1/logout`, scope local) with the same token. Call `api.whoami` again with the **same still-unexpired token**.
Pass: before sign-out 200; after sign-out the call is refused inside the database (`session_invalid`, HTTP 403), while the token still decodes with an unexpired `exp` and a valid signature (so the refusal is the database's `auth.sessions` check, not signature or expiry). Also call `/auth/v1/user` with the revoked token: expect the Auth server to refuse it. This session ends here by design: **no later check uses `s-sess`**, and every later check signs in its own users afresh. Local analogue: L3, L4; `local-f2a-checks.mjs`.

### H7. Staff removal takes effect at once (mutating, dedicated user)
Create `s-rm`, enroll and verify TOTP to obtain an `aal2` token, insert a staff assignment with the permitted insert of section 1 (a `postgres` session with `set role hackass_owner`; the same statement the local scripts use). Call `api.staff_probe` with that token: expect success. Revoke the assignment with the permitted revocation of section 1. Call `api.staff_probe` again with the **same token**.
Pass: success before, `not_staff` immediately after. `s-rm` is not used again. Local analogue: `020`, `local-f2c-checks.mjs`.

### H8. Real-token MFA expiry (mutating, time-dependent, dedicated user)
Create `s-mfa` and give it an active staff assignment with the permitted insert of section 1 (it is **not** the user of H7, so H7's revocation cannot affect this check).
1. Enroll a TOTP factor (`/auth/v1/factors`), verify with a computed code (`/auth/v1/factors/{id}/challenge` then `/verify`): the new token has `aal2` and an `amr` entry for `totp` with a timestamp.
2. *Fast path (about 2 minutes):* call `api.staff_probe(p_max_mfa_age_seconds => 60)` immediately: success. Wait 70 seconds (the access token, valid for 600 s, is still unexpired) and call it again with the same token: expect `mfa_stale`.
3. *Default window (about 16 minutes, run once; it may overlap H6, H7 and H9 because it uses its own user):* refresh the session around minute 9 (expected: a refreshed token keeps the original `amr` timestamp; whether the hosted platform does so is itself a fact to record), then at about minute 16 call `api.staff_probe()` with default arguments: expect `mfa_stale` (default window 15 minutes) while the token is still within its own `exp`.
Pass: step 2 and 3 as stated; token claims show `aal2` and an `amr` timestamp that does not move on refresh. This is the "stale-MFA with a real token" case left open since F2-A. **Step 3 is required for full acceptance:** the script runs it only with `--default-window`; without it the evidence records `H8-default` as NOT RUN and the run's outcome is INCOMPLETE, never COMPLETE.

### H9. Worker authentication and privileges through the hosted pooler (read-only queries; the password is set once by the owner)
Precondition (owner action O4, section 5 of the staging plan): the worker password was set out of band and is in the password file; H2c passed.
For **each** of: pooler transaction mode, pooler session mode (`PGPASSFILE="$STAGING_PGPASSFILE" psql "host=<pooler host> port=<port> dbname=postgres user=$STAGING_WORKER_USER sslmode=require"`):
* `select current_user, session_user;` both `hackass_worker`.
* `show statement_timeout;` is 30s; `show idle_in_transaction_session_timeout;` is 30s; `show search_path;` is empty.
* `select worker.healthcheck();` succeeds.
* each of these is refused with `42501`/`permission denied`: `select 1 from app.accounts limit 1;`, `select 1 from app.jobs limit 1;`, `select api.whoami();`, `select app_budget.today();`, `select app_review.utc_today();`, `set role hackass_owner;`, `select 1 from auth.users limit 1;`, `create table public.x (i int);`.
* a connection with a wrong password (a second password file written for this check, with a deliberately wrong value) is refused and does not reveal whether the role exists. The script gives this probe its own function: it writes the placeholder password file itself (in the run directory, mode `0600`, removed afterwards) and can name only the exact worker login and the exact nonexistent login `hackass_nonexistent.<ref>`; no other login or password file can be passed to the database client.
Pass: all as stated in both modes. Local analogue: `local-f2a-checks.mjs` (worker login), `W6` in `local-f2d1-checks.mjs`.

### H10. Worker job functions through transaction mode (mutating, explicit synthetic fixture)
A recheck job exists only when a publication's rights review carries an **expiry date**, and it becomes due the day **after** that expiry (`available_at` is `expires_on + 1 day`, 00:00 UTC). It is therefore neither present nor claimable just because a publication was made. The fixture is built and made due in one narrowly scoped way:
1. *Fixture.* With `b1` as author and `s-rev` as reviewer (created here, TOTP, active assignment through the permitted insert of section 1), submit and review one synthetic hack `J` through the real API, recording its rights review with `p_expires_on` = **tomorrow (UTC)**, then publish it. Exactly one `app.jobs` row for `J`'s publication now exists, `queued`, with `available_at` in the future.
2. *Preconditions (read-only, `postgres` session with `set role hackass_owner`):* `select id, status, available_at from app.jobs where target_publication_id = '<J publication id>'` returns exactly one `queued` row with `available_at > now()`; `select count(*) from app.jobs where status = 'queued' and available_at <= now()` is **0** (no other job is due). If either fails, stop; do not continue.
3. *The one scoped mutation* (the same statement the local checks use to make a job due; no trigger is disabled, the job guard allows it):
```sql
begin;
update app.jobs set available_at = pg_catalog.now() - interval '1 minute'
 where id = '<J job id>' and target_publication_id = '<J publication id>' and status = 'queued'
returning id;
-- the script requires exactly one returned row, otherwise: rollback; stop
commit;
```
4. *Check it is the only due job:* `select count(*), min(id::text) from app.jobs where status = 'queued' and available_at <= now()` is `1` and that id is `J`'s job.
5. *Worker flow,* as `hackass_worker` through the **transaction-mode** pooler: `select worker.claim_job('publication_recheck');` (must return `J`'s job), then `worker.get_job_subject`, `worker.heartbeat_job`, `worker.complete_job` with the returned job id and lease epoch; then call `worker.complete_job` again with the same epoch and with a wrong epoch.
Pass: the claim returns exactly `J`'s job; the subject contains exactly the documented columns; complete succeeds once with outcome `still_eligible` (the expiry is tomorrow, so the publication stays eligible) and the job is `succeeded`; the repeat and the wrong epoch answer `lease_lost`; `J` is still in the public catalog afterwards (it is one of the eligible fixtures for H11). Local analogue: `J1`, `J2` in `local-f2d1-checks.mjs`.

### H11. Public catalog eligibility on staging (mutating, synthetic, keeps a pagination fixture)
Fixtures (all authored by `b1`, reviewed and published by `s-rev` through the real API, slugs `stg-<run>-p1` to `-p5`): `P1`, `P2`, `P3` **stay eligible**; `P4` will be **withdrawn**; `P5` will have its rights **revoked**. Together with `J` from H10 there are six eligible publications at the start and **four (`P1`, `P2`, `P3`, `J`) at the end**, enough for multiple pages in both walks.
1. *All six visible.* Anonymous (publishable key only), member and staff `api.list_public_hacks` and `api.get_public_hack`: identical content for the three callers; detail keys equal the documented allowlist; list item keys equal the documented set; no identifier, hash, note or rationale string from the fixtures appears. A draft, a submitted-only, an approved-unpublished and a missing slug give the identical `PT404 not_found` body.
2. *Walk 1.* With `p_limit => 2` follow `next_cursor` to the end: exactly **3 pages**, the six slugs each once, in `(published_at desc, slug desc)` order recomputed client-side from the returned fields.
3. *Hide two.* Withdraw `P4` (`withdraw_publication`): hidden from list and detail at once. Record a rights revocation on `P5` (`record_rights_review` with `revoked`): hidden at once with no worker having run.
4. *Walk 2.* With `p_limit => 1` follow the cursor: exactly **4 pages** returning `P1`, `P2`, `P3`, `J` once each, in order; `P4` and `P5` absent. With `p_limit => 3`: 2 pages (3 then 1).
5. *Argument errors:* `p_limit => 0`, a half cursor and an unknown difficulty answer `PT422`.
Pass: all as stated. (Calendar expiry is not exercised hosted because it needs row tampering that this procedure forbids; that case stays covered locally by pgTAP.) Local analogue: `local-f2e-checks.mjs` E1 to E5.

### H12. Private-table and private-function isolation (mutating class: it creates Auth sessions, and its POSTs to private functions would run if isolation were broken), with working credentials established first
A refusal proves isolation only if the same credential demonstrably works on something it is allowed to do. The check therefore has three phases per credential, in this order.

*Phase 1: the credential works on an allowed endpoint (must pass before phase 2 counts).*
| Credential | Allowed request | Required |
|---|---|---|
| anonymous (publishable key, no user token) | `POST /rest/v1/rpc/list_public_hacks` | HTTP 200 with a JSON object |
| member (`b1`) | `POST /rest/v1/rpc/whoami` | HTTP 200 |
| staff (`s-rev`, `aal2`) | `POST /rest/v1/rpc/staff_probe` | HTTP 200 |
| secret key | `GET /auth/v1/admin/users?per_page=1` | HTTP 200 |
If a credential fails phase 1 the check **fails as inconclusive** for that credential (no isolation claim is made from its refusals); fix the credential or report.

*Phase 2: forbidden data access (the same credentials).* Requests: `GET $STAGING_URL/rest/v1/<table>` with `Accept-Profile: app` for `hacks`, `publications`, `jobs`, `ai_ledger`, `accounts`, `staff_assignments`; `POST /rest/v1/rpc/public_blockers` with `Content-Profile: app_review`; `POST` to `app_budget.reserve`, `worker.claim_job` and `app_guard.require_member` through their schemas.
Pass: **every one returns a non-2xx status** (expected 401, 403, 404 or 406) and a body with no application rows or column names. A 2xx on any of these is a failure. **The reason must be the expected one:** the schema is not exposed, i.e. HTTP 406 with PostgREST code `PGRST106`, whose exposed-schema list names no private schema and, on staging, is exactly `api`. A 429 (rate limit), a malformed-request error (400, 422), a not-found for a missing function or table (`PGRST202`, `PGRST205`) or a 5xx is **inconclusive** and fails the check: it says nothing about authorization. On staging the same request with `Accept-Profile: public` and `graphql_public` must be refused the same way.

*Phase 3: metadata that is permitted to be visible (HTTP 200 is acceptable here).* `GET $STAGING_URL/rest/v1/` returns the OpenAPI description of the exposed schema **to the secret key only** (the root is not served to a publishable or member credential, HTTP 401), so the description is read once with the secret key in `apikey` and is **metadata inspection, not a per-credential check**. What the anonymous and member credentials can actually reach in `api` is checked through real endpoints instead: `GET /rest/v1/<table>` with `Accept-Profile: api` for each private table must answer "not found" (`PGRST205` or 404) for each of them. It is checked against the **function allowlist**, not for refusal:
* the set of `/rpc/<name>` paths is a subset of the 19 `api` functions: `create_draft`, `delete_draft`, `get_public_hack`, `get_publication`, `get_submission_for_review`, `get_version`, `list_my_versions`, `list_public_hacks`, `list_submissions_for_review`, `publish_version`, `record_decision`, `record_rights_review`, `record_risk_assessment`, `save_draft`, `staff_probe`, `start_review`, `submit_version`, `whoami`, `withdraw_publication`;
* for the anonymous credential a per-credential listing (only `get_public_hack` and `list_public_hacks`, the only functions `anon` may execute) **can no longer be observed**: the description is read with the secret key, so it can list every exposed `api` function regardless of privilege, and that listing is not asserted. What each credential may actually execute is shown by phase 1 (allowed calls succeed), H9/H10, H11 and the privilege inventory H4;
* there is **no** table path, no path outside `/rpc/` other than the root, and no definition for any application table or for any function of `app_review`, `app_budget`, `app_guard`, `app_content`, `app_bridge` or `worker`.
`GET /graphql/v1` (anonymous): expected 404 (extension disabled). If it answers 200, the introspection must show no application type; record the result either way.
Pass: phase 1 passed for every credential, phase 2 had no 2xx, phase 3 holds. Local analogue: `E4`, pgTAP section A.

### H13. Cleanup (mutating)
* **Close the run** (no further fixture creation), then delete the synthetic Auth users (`b1`, `s-sess`, `s-rm`, `s-mfa`, `s-rev`, and the identity-check user) through the admin API (the delete trigger marks accounts `deleted` and revokes staff assignments); confirm no staff assignment remains active. The users are found by their **exact recorded identities**: the e-mail address of every user is written to the run state *before* the creation request, so a creation that was interrupted or whose outcome is uncertain is found again by that exact address (the admin user list is walked page by page; users are never matched by pattern and an unrelated user is never touched). Every step is attempted even when another fails (the overall result still fails), and cleanup also works for a run that stopped before the application tables or the worker role existed.
* Remove the role comment (as `postgres`): `comment on role hackass_worker is null;`.
* Revoke or rotate any key or token created for the run; delete the password files; unset every exported secret in the operator's shell.
* The synthetic content (hacks, versions, publications, decisions, ledgers) **cannot be deleted by design** (append-only, immutable). It is removed by deleting the project (owner action O9). Until then the project stays private, with sign-ups closed and no application pointed at it.
Pass: no synthetic user remains active; no active staff assignment remains; the marker is gone; the owner confirms the deletion date (recorded as a real calendar date that is not in the past; a missing or invalid date leaves the run INCOMPLETE). The evidence reports **script cleanup** (H13a to H13c) separately from the **owner cleanup that is still outstanding** (key revocation or rotation, deletion of the password files, deletion of the project), which the scripts neither perform nor verify.

### H14. Evidence: redacted records are kept, raw output is disposable (local)
* **Raw output** (unredacted: may contain tokens, JWT bodies, connection details, full responses) is written during the run to a directory outside the repository (mode `0700`, one folder per run). It is **disposable**: it is used only to produce the redacted record, is never committed, attached, uploaded or sent, and is deleted once the redacted record has been reviewed.
* **Redacted evidence** is the **retained** record. After redaction (secrets, tokens, JWT bodies, connection strings, passwords, non-synthetic emails) it is saved as `docs/hosted/evidence/<date>-staging-<run id>.md` with: the **outcome** (COMPLETE only when every required check, including the hosted 15-minute MFA test H8-default, ran and passed, no stage failed or was interrupted or raised an unexpected error, script cleanup is done and the deletion date is recorded; INCOMPLETE when a required check is NOT RUN or cleanup or the date is missing; FAILED when any check failed or any stage failed, was interrupted or errored), date, CLI and platform versions, Postgres minor version, region, key model, token algorithm and lifetime, one line per check (status, timing, HTTP statuses and error codes), the exact commit tested, and the output of any failed check. It is added in a separate, reviewed local commit and is kept with the repository after the staging project is gone.
* `docs/foundation/f2-closeout.md` and `docs/spikes/f1-hosted-spikes.md` are updated from the redacted evidence afterwards, not before.
* **Earlier attempts are never forgotten.** A stage that failed or was interrupted and was later re-attempted (a read-only stage, with `--retry-after-review`) stays in the outcome: the evidence lists the earlier attempt and the outcome is FAILED although the retry succeeded. After a killed process, a recovery stage (`evidence` or `cleanup`) must take over the stale lock first; the recovery stage `evidence` may be run more than once, and each record is a new file (`...-<run id>-2.md`, `-3.md`), never an overwrite.
* A failed check stays in the redacted evidence with its redacted output. Evidence is available for a failed or interrupted run too (outcome FAILED); a check that did not run appears as NOT RUN, never as absent. Redaction still applies in the separate evidence process after cleanup has deleted the run's secrets file: the run keeps only salted hashes of the secrets it registered, never the secrets.

## 4. Summary of classifications

| Check | Class |
|---|---|
| H0 preflight | read-only (local) |
| H1a platform and configuration facts | read-only |
| H1b live identity proof | mutating (one throwaway Auth user, deleted at once) |
| H2a apply migrations | mutating |
| H2b exposure of `api` | owner mutation, then read-only verification |
| H2c worker endpoint proof | mutating (one role comment) |
| H3 second runner invocation | read-only dry-run; the real command is a mutating-capable no-op |
| H4 catalog inventory | read-only |
| H5a trigger and bridge presence | read-only |
| H5b trigger behavior | mutating |
| H6 session revocation | mutating |
| H7 staff removal | mutating |
| H8 MFA expiry | mutating |
| H9 worker authentication and privileges | read-only (queries); the password setup is a prior owner mutation |
| H10 worker job functions | mutating (one scoped job update) |
| H11 public catalog eligibility | mutating |
| H12 private isolation | mutating class (Auth sessions; probes that would run if isolation were broken) |
| H13 cleanup | mutating |
| H14 evidence retention | local |

## 5. Order and gating

H0, then H1a (nothing is changed). H1b before any database change. H2a only after the owner confirms H1's facts (version 17, bridge privileges true) and H1b passed. H2b immediately after H2a and before any HTTP check that needs `api`. H2c right after H2a. H3, H4, H5a after H2b. H5b, then H6, H7 and H8 (independent users; H8's long wait may overlap). H9 needs the owner's worker password and H2c. H10 and H11 need H5b and H2b. H12 needs H10/H11 fixtures (it uses `b1` and `s-rev`). H13 and H14 last.
