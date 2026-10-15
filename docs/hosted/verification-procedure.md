# Hosted verification procedure (staging)

**Prepared, not executed.** Each check names what it proves, whether it is **read-only** or **mutating**, the proposed command, the pass criterion and the local result it is compared with. Nothing here has been run against any hosted system.

## 0. Conventions

* **Targets and secrets come from environment variables** set by the owner in the operator's shell for the duration of a run: `STAGING_REF`, `STAGING_URL` (`https://<ref>.supabase.co`), `STAGING_PUBLISHABLE_KEY`, `STAGING_SECRET_KEY`, `STAGING_DB_HOST`/`STAGING_DB_PORT` (the pooler session endpoint used by the migration step), `STAGING_POOLER_HOST`, `STAGING_POOLER_TXN_PORT`, `STAGING_POOLER_SESSION_PORT`, `FORBIDDEN_PROJECT_REFS`. Passwords are passed as `PGPASSWORD` (libpq reads it; it is not on any command line) or on standard input. **No value is written to the repository, printed, or logged.**
* **Proposed tooling.** The checks are run by a new script set under `scripts/hosted/` that does **not exist yet**; it is written and reviewed in the execution slice, before any run. It must: refuse to start unless `H0` passes; read only the variables above; never print a secret; write raw output only to a directory outside the repository; and contain none of the local container, reset or rollback logic. SQL snippets below are inline so they can be reviewed now.
* **Classification.** *Read-only*: sends only queries or GET requests that change nothing. *Mutating*: creates, changes or deletes hosted state (users, sessions, rows, roles, migrations). A mutating check is run only after the previous checks passed and only against the staging project.
* **Stop rule.** Any failed check stops the run. The output (redacted) is the result; nothing is patched by hand on the hosted database and no check is retried until the cause is understood and reviewed.

## 1. Forbidden against staging

These exist for the **local disposable stack** and must never be pointed at a hosted database:

* `supabase db reset`, `supabase stop --no-backup`, `supabase start`, `supabase test db` (local stack lifecycle; `db reset` drops and rebuilds a database).
* every `scripts/local-f2*-checks.mjs` and `scripts/local-auth-spikes.mjs` and `scripts/db-test.mjs` (they `docker exec` into the local container, insert staff by direct SQL, mutate clocks and tamper rows, and include **committed rollback** checks R6, R7, R8).
* every file in `supabase/rollbacks/` (hand-applied local reversal scripts; deleting from `schema_migrations`).
* `supabase link` (writes the project reference into the checkout) and `supabase db push --linked`, `supabase db remote commit`, `supabase db pull`, and any `--include-all` or `--include-seed` flag.
* the pgTAP files under `supabase/tests/database/` (they assume the local role setup and disable triggers).

Hosted scripts must also refuse any SQL containing `drop schema`, `drop role`, `truncate`, `disable trigger` or `schema_migrations` writes.

## 2. Checks

### H0. Preflight guard (read-only, local)
Proves the run is aimed at staging and nothing else.
* Refuse unless `STAGING_REF` is set, `STAGING_URL` equals `https://$STAGING_REF.supabase.co`, no variable names a local container, and `STAGING_REF` is **not** in `FORBIDDEN_PROJECT_REFS`.
* Decode only the `ref` claim of the staging publishable/secret key **if it is a JWT** and require it to equal `STAGING_REF` (a mismatch means the key belongs to another project). Never print the key.
* Pass: all conditions hold. Fail: stop; nothing was contacted.

### H1. Platform and configuration facts (read-only)
Records the facts that replace assumptions (spikes S3, S4, S6). Proposed:
```sql
select version();                                    -- expect Postgres 17.x; record the minor version
select name, installed_version from pg_available_extensions where name in ('pgcrypto','citext','pg_trgm') order by 1;
select rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin from pg_roles where rolname in ('postgres','authenticator','anon','authenticated','service_role','supabase_auth_admin') order by 1;
select schema_name from information_schema.schemata where schema_name in ('app','app_guard','api','worker','app_bridge','app_content','app_review','app_budget') order by 1;   -- before H2: expect none
select has_schema_privilege('postgres','auth','usage') as postgres_auth_usage, has_table_privilege('postgres','auth.sessions','select') as postgres_sessions_select;
```
HTTP (GET): `$STAGING_URL/auth/v1/settings` (disable_signup, external providers, mailer settings) and `$STAGING_URL/auth/v1/.well-known/jwks.json` (signing algorithm). Pass: Postgres major is 17; the three extensions are available; `postgres_auth_usage` and `postgres_sessions_select` are true (the bridge depends on them); sign-ups are disabled; provider list matches section 3 of the staging plan. Record the token lifetime from a real sign-in in H6.

### H2. Apply the 21 migrations (mutating, once)
```
supabase db push --db-url "$STAGING_DB_URL" --dry-run     # lists the 21 pending, in filename order; changes nothing
supabase db push --db-url "$STAGING_DB_URL"               # applies them, stopping at the first failure
```
`STAGING_DB_URL` is assembled in the shell from the environment (the CLI needs the URL as an argument; on a single-user machine it is visible only to that user's process list for the duration of the command, which the owner accepts or replaces with `supabase link`, an alternative the owner must approve because it writes the project reference into `supabase/.temp/`). The `--dry-run` output is compared with the list in `staging-plan.md` section 4 before the real run.
Pass: all 21 apply; `select count(*) from supabase_migrations.schema_migrations where version like '2026%'` is 21; the versions match the filenames. A failure is the **hosted-specific risk** discussed in the staging plan: record the failing file and error, stop, and report. Do not edit the migration or the database to get past it.

### H3. Migration runner invoked again with nothing pending (read-only dry-run; mutating-capable no-op)
Proves G-1 as interpreted in the F2-F review: a second invocation applies nothing already recorded.
1. Before: `select count(*) , md5(string_agg(version, ',' order by version)) from supabase_migrations.schema_migrations;` and a **catalog fingerprint** (md5 over the sorted `pg_get_functiondef` of every function in the application schemas plus the sorted ACLs of the application schemas, tables and functions).
2. `supabase db push --db-url "$STAGING_DB_URL" --dry-run` (read-only): expect a statement that the remote database is up to date and no pending migrations.
3. `supabase db push --db-url "$STAGING_DB_URL"` (the real command; expected to be a no-op).
4. After: the same two queries.
Pass: step 2 lists nothing; ledger count and checksum are unchanged (21); the catalog fingerprint is unchanged; no error.

### H4. Catalog inventory against the golden (read-only)
Runs the function-inventory query from `supabase/tests/database/010_roles_and_grants.test.sql` (the `$golden$` block and the query above it) on staging and diffs it with the golden text. Also: role attributes of `hackass_owner` and `hackass_worker`; no table, column or sequence privilege for `anon`, `authenticated` or `hackass_worker` in the application schemas; `hackass_owner` holds no privilege on `auth`.
Pass: the inventory equals the golden **exactly** (101 functions); zero table privileges; roles have the required attributes (`NOLOGIN`/`LOGIN`, `NOINHERIT`, connection limits 0 and 10). Local analogue: pgTAP 010; `local-f2a-checks.mjs`.

### H5. Auth triggers and the session bridge exist and fire
*H5a (read-only):* `select tgname, tgenabled from pg_trigger where tgrelid = 'auth.users'::regclass and tgname like 'hackass_%' order by 1;` expects `hackass_account_created` and `hackass_account_deleted`, enabled. `select proowner::regrole, prosecdef, proconfig from pg_proc where oid = 'app_bridge.session_valid(uuid,uuid)'::regprocedure;` expects owner `postgres`, `SECURITY DEFINER`, `search_path=""`; `has_function_privilege('hackass_owner','app_bridge.session_valid(uuid,uuid)','execute')` is true and false for `anon`, `authenticated`, `hackass_worker`.
*H5b (mutating):* create two synthetic users with the Auth admin API (secret key; `email_confirm: true`; emails `staging-<run>-1@example.test`, `-2`): expect one `app.accounts` row each with status `active` (read with a `postgres` session using `set role hackass_owner`). Delete user 2 through the admin API: expect its account `status = 'deleted'` and no active staff assignment (the delete trigger). Pass: all as stated. Local analogue: `020`, `local-f2a-checks.mjs`.

### H6. Session revocation and the in-database session check (mutating)
With user 1: password sign-in (`/auth/v1/token?grant_type=password`), record `expires_in` and the token header algorithm. Call `api.whoami` through PostgREST with the access token: expect HTTP 200. Sign out (`/auth/v1/logout`, scope local) with the same token. Call `api.whoami` again with the **same still-unexpired token**.
Pass: before sign-out 200; after sign-out the call is refused inside the database (`session_invalid`, HTTP 403), while the token still decodes with an unexpired `exp` and a valid signature (so the refusal is the database's `auth.sessions` check, not signature or expiry). Also call `/auth/v1/user` with the revoked token: expect the Auth server to refuse it. Local analogue: L3, L4; `local-f2a-checks.mjs`.

### H7. Staff removal takes effect at once (mutating)
Insert a staff assignment for user 1 with a `postgres` session (`set role hackass_owner`; `insert into app.staff_assignments ...`, the same statement the local scripts use). With a fresh aal2 token (H8 steps 1 to 3) call `api.staff_probe`: expect success. Revoke the assignment (`update app.staff_assignments set revoked_at = now(), revoked_by = 'staging-check' ...`). Call `api.staff_probe` again with the **same token**.
Pass: success before, `not_staff` immediately after. Local analogue: `020`, `local-f2c-checks.mjs`.

### H8. Real-token MFA expiry (mutating, time-dependent)
1. Enroll a TOTP factor for user 1 (`/auth/v1/factors`), verify with a computed code (`/auth/v1/factors/{id}/challenge` then `/verify`): the new token has `aal2` and an `amr` entry for `totp` with a timestamp.
2. *Fast path (about 2 minutes):* call `api.staff_probe(p_max_mfa_age_seconds => 60)` immediately: success. Wait 70 seconds (the access token, valid for 600 s, is still unexpired) and call it again with the same token: expect `mfa_stale`.
3. *Default window (about 16 minutes, run once):* refresh the session around minute 9 (expected: a refreshed token keeps the original `amr` timestamp; whether the hosted platform does so is itself a fact to record), then at about minute 16 call `api.staff_probe()` with default arguments: expect `mfa_stale` (default window 15 minutes) while the token is still within its own `exp`.
Pass: step 2 and 3 as stated; token claims show `aal2` and an `amr` timestamp that does not move on refresh. This is the "stale-MFA with a real token" case left open since F2-A.

### H9. Worker authentication and privileges through the hosted pooler (read-only queries; the password is set once by the owner)
Precondition (owner action O4, section 5 of the staging plan): the worker password was set out of band.
For **each** of: pooler transaction mode, pooler session mode (`PGPASSWORD=$STAGING_WORKER_PASSWORD psql "host=$STAGING_POOLER_HOST port=<port> dbname=postgres user=hackass_worker.$STAGING_REF sslmode=require"`):
* `select current_user, session_user;` both `hackass_worker`.
* `show statement_timeout;` is 30s; `show idle_in_transaction_session_timeout;` is 30s; `show search_path;` is empty.
* `select worker.healthcheck();` succeeds.
* each of these is refused with `42501`/`permission denied`: `select 1 from app.accounts limit 1;`, `select 1 from app.jobs limit 1;`, `select api.whoami();`, `select app_budget.today();`, `select app_review.utc_today();`, `set role hackass_owner;`, `select 1 from auth.users limit 1;`, `create table public.x (i int);`.
* a connection with a wrong password is refused and does not reveal whether the role exists.
Pass: all as stated in both modes. Local analogue: `local-f2a-checks.mjs` (worker login), `W6` in `local-f2d1-checks.mjs`.

### H10. Worker job functions through transaction mode (mutating, synthetic)
Publish one synthetic hack through the real staff path (as in H11) so a `publication_recheck` job is queued. Through the **transaction-mode** pooler as `hackass_worker`: `select worker.claim_job('publication_recheck');` then `worker.get_job_subject`, `worker.heartbeat_job`, `worker.complete_job` with the returned job id and lease epoch; then call `worker.complete_job` again with the same epoch and with a wrong epoch.
Pass: the claim returns one job; the subject contains exactly the documented columns; complete succeeds once; the repeat and the wrong epoch answer `lease_lost`. Local analogue: `J1`, `J2` in `local-f2d1-checks.mjs`.

### H11. Public catalog eligibility on staging (mutating, synthetic)
With real staff tokens (reviewer aal2) and a synthetic member: submit, review, publish two hacks through the API; then:
* anonymous (publishable key only), member and staff `api.list_public_hacks` and `api.get_public_hack`: identical content; detail keys equal the documented allowlist; list item keys equal the documented set; no identifier, hash, note or rationale string from the fixtures appears.
* a draft, a submitted-only, an approved-unpublished and a missing slug: the identical `PT404 not_found` body.
* withdraw one publication: hidden from list and detail at once. Record a rights revocation on the other (`record_rights_review` with `revoked`): hidden at once with no worker having run.
* pagination with `p_limit => 1` over the remaining and the withdrawn: cursor walk returns each visible hack once, in `(published_at desc, slug desc)` order; `p_limit => 0`, a half cursor and an unknown difficulty answer `PT422`.
Pass: all as stated. (Calendar expiry is not exercised hosted because it needs row tampering that the staging procedure forbids; that case stays covered locally by pgTAP.) Local analogue: `local-f2e-checks.mjs` E1 to E5.

### H12. Private-table and private-function isolation (read-only)
With anonymous, member, staff and secret-key credentials (each separately): `GET $STAGING_URL/rest/v1/hacks` with `Accept-Profile: app`; the same for `publications`, `jobs`, `ai_ledger`, `accounts`, `staff_assignments`; `POST /rest/v1/rpc/public_blockers` with `Content-Profile: app_review`; `POST` to `app_budget.reserve`, `worker.claim_job` and `app_guard.require_member`; `GET /graphql/v1`; `GET /rest/v1/` (the OpenAPI document).
Pass: none returns data (HTTP is 401, 403, 404 or 406; never 200 with rows); the OpenAPI document lists only `api` routes (the two public reads for anonymous; the authenticated and staff routes for signed-in callers); the secret key cannot read the application tables either (it bypasses RLS on `public` tables only if they are exposed; the `app` schema is not). Local analogue: `E4`, pgTAP section A.

### H13. Cleanup (mutating)
* Delete synthetic Auth users through the admin API (the delete trigger marks accounts `deleted` and revokes staff assignments).
* Revoke or rotate any key or token created for the run; unset every exported secret in the operator's shell.
* The synthetic content (hacks, versions, publications, decisions, ledgers) **cannot be deleted by design** (append-only, immutable). It is removed by deleting the project (owner action O9). Until then the project stays private, with sign-ups closed and no application pointed at it.
Pass: no synthetic user remains active; no active staff assignment remains; owner confirms the deletion date.

### H14. Evidence retention (local)
* Raw outputs are written outside the repository during the run. After redaction (secrets, tokens, JWT bodies, connection strings, non-synthetic emails), the redacted results are saved as `docs/hosted/evidence/<date>-staging.md`, with: date, CLI and platform versions, Postgres minor version, region, key model, token algorithm and lifetime, one line per check (status, timing, HTTP statuses/error codes) and the exact commit tested.
* The evidence is added in a separate, reviewed local commit. `docs/foundation/f2-closeout.md` and `docs/spikes/f1-hosted-spikes.md` are updated from it afterwards, not before.
* A failed check is kept in the evidence with its redacted output.

## 3. Summary of classifications

| Check | Class |
|---|---|
| H0 preflight | read-only (local) |
| H1 platform and configuration facts | read-only |
| H2 apply migrations | mutating |
| H3 second runner invocation | read-only dry-run; the real command is a mutating-capable no-op |
| H4 catalog inventory | read-only |
| H5a trigger and bridge presence | read-only |
| H5b trigger behavior | mutating |
| H6 session revocation | mutating |
| H7 staff removal | mutating |
| H8 MFA expiry | mutating |
| H9 worker authentication and privileges | read-only (queries); the password setup is a prior owner mutation |
| H10 worker job functions | mutating |
| H11 public catalog eligibility | mutating |
| H12 private isolation | read-only |
| H13 cleanup | mutating |
| H14 evidence retention | local |

## 4. Order and gating

H0 to H1 first (nothing is changed). H2 only after the owner confirms H1's facts (version 17, bridge privileges true). H3, H4, H5a immediately after H2. H5b to H8 after H4 passes. H9 needs the owner's worker password; H10 and H11 need H5b to H8. H12 any time after H2. H13 and H14 last.
