# F2-A — database roles, permissions and authorization foundations

Branch `f2a-db-authority`, from `78d4bfa`. Migrations `supabase/migrations/20261013130000…130200`. Rollback:
`supabase/rollbacks/20261013130000_f2a_down.sql`. No product table, UI, or catalog exists yet; the two exposed functions are
conformance exemplars (`api.whoami`, `api.staff_probe`) that later slices replace with real, guarded functions.

## Roles
| Role | Attributes | Purpose | Holds |
|---|---|---|---|
| `hackass_owner` | NOLOGIN, no superuser/createrole/createdb/replication/bypassrls, NOINHERIT, connection limit 0, member of no role | owns every application object; SECURITY DEFINER functions run as it | all privileges on its own schemas and tables; `USAGE` on `app_bridge` and `EXECUTE` on `app_bridge.session_valid` — **nothing on `auth`**, nothing in `public`, no database-level CREATE |
| `hackass_worker` | LOGIN, same exclusions, NOINHERIT, connection limit 10, **created without a password** (set by the operator out of band), session defaults: `statement_timeout 30s`, `idle_in_transaction_session_timeout 30s`, `search_path ''` | the job worker | `USAGE` on schema `worker`; `EXECUTE` on `worker.healthcheck()` only. No table privilege anywhere |
| `postgres` | platform admin (break-glass) | operations, migrations | may `SET ROLE hackass_owner` (not inherited). Reads `app.*` only through the platform's `pg_read_all_data` membership |
| `anon`, `authenticated`, `service_role`, `authenticator`, `supabase_auth_admin` | platform roles | API access | `anon`/`authenticated`: `USAGE` on `api` and `EXECUTE` on the exposed functions (`authenticated` only). `supabase_auth_admin`: `USAGE` on `app_guard` and `EXECUTE` on the two trigger functions. `service_role` holds nothing of ours |

## Schemas and objects
| Schema | Owner | Contents | Reachable by |
|---|---|---|---|
| `app` | hackass_owner | `accounts`, `staff_assignments` (RLS on, no policies, no grants) | owner only |
| `app_guard` | hackass_owner | `require_member`, `require_staff`, types, 2 trigger functions | owner; `supabase_auth_admin` for the triggers |
| `api` | hackass_owner | `whoami()`, `staff_probe(text, integer)` | `authenticated` (EXECUTE); exposed through PostgREST |
| `worker` | hackass_owner | `healthcheck()` | `hackass_worker` |
| `app_bridge` | **postgres** | `session_valid(uuid, uuid) -> boolean` | `hackass_owner` only |

The exact, reviewed inventory is the golden text in `010_roles_and_grants.test.sql`; the live catalog dump is printed by
`scripts/local-f2a-checks.mjs` and recorded in the review package.

## The authorization guards
`app_guard.require_member()` reads the verified claims from `request.jwt.claims` and requires, in order: role `authenticated`; a
UUID `sub` and `session_id`; `app_bridge.session_valid(session_id, sub)` (the session exists, **belongs to that user**, is unexpired, and
the user is neither deleted nor banned); not an anonymous user; an `active` row in `app.accounts`. Failures raise `28000`
(`not_authenticated`, `session_invalid`) or `42501` (`anonymous_forbidden`, `account_inactive`). `require_staff(min_role, require_mfa,
max_mfa_age)` adds an active `app.staff_assignments` row of at least `min_role`, `aal2`, and a TOTP `amr` timestamp no older than
the window (default 15 min) and not in the future (`not_staff`, `mfa_required`, `mfa_stale`). Staff assignments are changed only through
the owner role; no exposed function writes them.

## Findings that shaped the design
1. **`postgres` cannot delegate USAGE on schema `auth`.** So the application owner cannot read `auth.sessions` directly. A tiny
   `postgres`-owned bridge returns one boolean. These two bridge-adjacent facts are the only `postgres`-owned objects.
2. **PostgREST accepts a revoked-but-unexpired token** (signature only). Only the in-database session check refuses it.
3. **`postgres` is a `pg_read_all_data` member** on this platform, so it can read `app.*` (break-glass); it holds no write path
   except `SET ROLE hackass_owner`.
4. **A connection made from inside the database container is trusted** (no password check); worker authentication is therefore
   tested from a sibling container on the stack network, where scram-sha-256 applies.
5. `statement_timeout` and friends on the worker are role *defaults*; a login can `SET` them. The limits that hold are the grants
   and the connection limit.
6. The platform does not let a non-superuser name `SUPERUSER`/`REPLICATION`/`BYPASSRLS` in `ALTER ROLE`; the migration asserts them
   instead and fails if any is set.

## Rollback
Migrations are forward-only. To undo F2-A on a local database: `supabase stop --no-backup` (discards it) or run the rollback script
as `postgres` (`psql -f supabase/rollbacks/20261013130000_f2a_down.sql`); it drops the triggers, the five schemas, both roles and the
migration ledger rows, and never touches `auth`/`storage`/`public`. It **drops `app.accounts` and `app.staff_assignments` with their
data**. On a linked project, afterwards run `supabase migration repair --status reverted 20261013130000 20261013130100 20261013130200`.
`scripts/local-f2a-checks.mjs` (check R1) rehearses the script inside a transaction that is rolled back and asserts the before and
after state.

## What this does not establish
Hosted behaviour (pooler login, whether hosted `postgres` can create the same triggers, bridge and grants), application permissions
beyond these two exemplar functions (F2-B and later), and the F2 acceptance rows that need tables that do not exist yet.
