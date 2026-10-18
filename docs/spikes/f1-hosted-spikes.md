# F1 hosted spikes (require the authorized staging Supabase project)

Status: **BLOCKED — no hosted staging project or credentials are available.** Nothing below has been run, and none of
the design assumptions it covers should be described as validated.

Run only against the new `hackass-staging` project (never the project whose keys appeared in git history). Record results
in this file with date, Supabase CLI/platform versions and the exact commands.

| # | Spike | Procedure | Pass criteria | Result |
|---|---|---|---|---|
| S1 | Server-centric session cookies | Using `createUserDb` from a throwaway route in a scratch app, sign up, verify, sign in, refresh, sign out through server handlers only | session persists across requests with an HttpOnly cookie; refresh works; no flow needs token access in the browser; sign-out revokes the session | BLOCKED |
| S2 | Revocation vs signature | Sign in, copy the access token, sign out elsewhere; call a JWT-verifying path and the Auth server `getUser` | claims verification still succeeds until expiry while `getUser` fails immediately; documents the T1 window | BLOCKED |
| S3 | In-database session check | From a SECURITY DEFINER test function owned by a non-superuser role, read `auth.sessions` for the `session_id` claim | the check can detect a signed-out session inside the database (needs the grant on `auth.sessions`) | BLOCKED |
| S4 | MFA claims | Enroll TOTP, elevate to aal2 | `aal` and `amr` (with timestamps) appear in the JWT as the step-up check assumes | BLOCKED |
| S5 | Worker role over the pooler | Create a login role `hackass_worker`, grant `EXECUTE` on one test function in schema `worker` only, connect through the transaction pooler | connection works with that username form; the role can call the function and nothing else (no table access, no other schema) | BLOCKED |
| S6 | Keys and projections | Confirm the project's key model (publishable/secret vs legacy anon/service_role), token lifetime, SMTP and rate limits | recorded facts replace the assumptions in B3 | BLOCKED |

Local equivalents of S2–S4 can run on the CLI stack once Docker is available; S1's cookie behaviour and S5 are the
hosted-only checks.

## Local results (real local Supabase stack, 2026-10-13)
Run by `npm run db:test:auth` (stack: CLI 2.120.0, GoTrue v2.197.0, PostgREST v16.4, Postgres 17.11). These do **not** change
the hosted statuses above; the hosted rows stay BLOCKED. They show what holds on the local stack.

| ID | Local check | Result | Fact established |
|---|---|---|---|
| L0 | token lifetime and algorithm | PASS | `expires_in` = 600 as configured; access tokens are **ES256** (asymmetric; verify via JWKS), claims include `aal`, `amr`, `session_id` |
| L1 | email confirmation | PASS | sign-up returns no session; password sign-in is refused (`email_not_confirmed`) until the Mailpit link is followed |
| L2 | server-centric cookie session via `createUserDb` | PASS | cookies carry `httpOnly: true`, `sameSite: lax`, `path: /`; a second client built from the same cookies sees the user; refresh rotates the refresh token; sign-out clears the cookies and revokes the refresh token. **Not shown:** a real browser honouring HttpOnly over HTTPS (S1 stays BLOCKED) |
| L3 | revocation vs signature (S2, local) | PASS | after sign-out the access token still verifies by signature, has not expired, and **PostgREST still accepts it (HTTP 200)**; only the Auth server rejects it. Signature checks alone do not detect revocation |
| L4 | in-database session check (S3, local) | PASS, **for the `postgres` owner only** | a `SECURITY DEFINER` function owned by `postgres` (not a superuser) reads `auth.sessions` by the JWT's `session_id`: true before sign-out, false after. `authenticated` has no direct SELECT on `auth.sessions`. **This proves the behaviour under `postgres`, not under our minimally privileged `hackass_owner`.** The application-owner proof is F2-A (below). Hosted feasibility is still unverified |
| L5 | MFA claims (S4, local) | PASS | TOTP enrol + verify gives `aal2`; `amr` holds `totp` and `password` entries with a Unix timestamp (age 0 s at verify); `auth.jwt()` inside the database shows both; a wrong code is rejected |

Effect on the design: L3 + L4 confirm that a web-handler `getUser()` cannot protect a function callable directly with a JWT, and
that the in-database check of invariant I-3 is both necessary and feasible on the local stack.

Still BLOCKED (need the hosted staging project or a real browser): S1 browser-side HttpOnly behaviour over HTTPS; the hosted
variants of S2-S4 (the hosted platform may differ); S5 the `hackass_worker` role through the pooler; S6 hosted key model,
token lifetime, SMTP and rate limits.

## F2-A: the same check under the application owner (local stack, 2026-10-13)
`hackass_owner` (NOLOGIN, no privilege on the `auth` schema) cannot run the L4 check itself: **`postgres` holds USAGE on schema `auth`
without grant option** (`postgres=U/supabase_admin`), so it cannot delegate that USAGE, and `hackass_owner` can therefore not be
given `SELECT` on `auth.sessions`. The design therefore routes the check through one tiny `postgres`-owned function,
`app_bridge.session_valid(session_id, user_id) -> boolean`, executable only by `hackass_owner`. Everything else (claims parsing,
account status, staff assignment, MFA) runs as `hackass_owner` inside the guards. Evidence: `supabase/tests/database/010_roles_and_grants.test.sql`
(owner holds no `auth` privilege, direct reads fail with 42501, the bridge is its only route), `020_authorization.test.sql` (the guard matrix as
the real `anon`/`authenticated`/`service_role` roles) and `scripts/local-f2a-checks.mjs` (real signed JWTs through PostgREST).
Hosted feasibility of the same arrangement (a `postgres`-owned bridge reading `auth.sessions`, triggers on `auth.users`) is still unverified.
