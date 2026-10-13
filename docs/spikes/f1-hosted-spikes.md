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
