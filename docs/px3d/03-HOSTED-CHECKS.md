# 03 · Hosted pilot checks: HTTPS, session and ownership

**Proposal only; none of these checks has been run on a hosted system.** Revised for PX-3e: the member-function and denial checks are **actual RPC calls plus the exact SQL inventory** (`scripts/pilot-rpc-checks.mjs --hosted`, `scripts/pilot-inventory.mjs --libpq`), not the OpenAPI listing, which is not required to show member functions; key rotation and session revocation are separate checks (X3, X5); hosting and proxy logs are checked for emailed tokens (K-series); the single-process behaviour has its own checks (L-series). Each local equivalent that already passed is named so the reviewer can see what is being re-proved on real infrastructure and what is new.

## 0. Conventions
* **Class:** **R** = read-only (nothing is created, changed or deleted); **M** = mutating (creates sessions, members or content, or time-dependent). Every M check names its cleanup. A step that contains an M check is authorized as mutating.
* **Accounts:** two members, **A** and **B**, with addresses the owner controls (they receive the real invitation emails). Optional **C** for the disabled-account check. **No real tester data** is used in these checks; the checks create labelled content (`PX3D-<run>`) and delete it.
* **Secrets:** the operator's shell or `0600` files only; never an argument, URL, chat or log. The secret (service) key is used only by the operator for the denial probes and invitations, never by the application.
* **Evidence:** a redacted record per check (outcome, observed status/headers, no values of cookies, tokens, keys, addresses or content), kept; raw output is disposable (the M-HOST rules).
* **Stop rule:** a failing check stops the run; it is recorded and fixed through a reviewed change, never by hand-editing the hosted database or the host.
* **Prerequisites:** the pilot project and host exist (A7 to A9 in the README); migrations applied; the edge gate is in front; owner-controlled test members exist.

## 1. Platform and configuration (P)

| ID | Check | Class | Expected |
|---|---|---|---|
| P1 | Project identity: reference, region and Postgres version equal the recorded values; not a forbidden reference | R | exact match; major version 17 |
| P2 | Migration ledger against `docs/px3d/pilot-manifest.json` | R | **25** versions with the manifest's names and hashes; 120 functions, 28 tables; no extra, none missing; historical staging records untouched (they live in another project) |
| P3 | Exposed schemas: **expose only `api`, then read the setting back** (this precedes every RPC check); an anonymous API call to another schema is refused | R | `api` only; `public`/`graphql_public` refused. **The OpenAPI listing is not used as proof of the member functions**; P4 and O4 are |
| P4 | **Exact SQL inventory** (`pilot-inventory.mjs --libpq`, read-only) compared line for line with `pilot-inventory.expected.txt` | R | 187 lines identical: 120 functions (owner, `SECURITY DEFINER`, `search_path = ''`, EXECUTE grants), RLS on 28 tables, **no table privilege for any application role**, trigger `hackass_work_content_deleted` on `auth.users`, anonymous executes only the two public catalogue reads |
| P5 | Auth settings read back | R | public sign-up **off**; minimum password 12; `jwt_expiry` 600 s; refresh rotation on (10 s reuse); confirmations on; Site URL = the pilot origin and **no other** redirect URL; custom SMTP set; template text hash equals the reviewed templates; anonymous sign-ins off |
| P6 | Worker role | R | no password is set (read from the catalogue/ledger evidence; **no failed-authentication probe is sent automatically**). F-H9-1 is **carried forward as an open finding** with its recorded disposition (D5); repeating the login-existence probes on the hosted pooler needs its own explicit instruction, because they produce failed-authentication attempts |
| P7 | Host environment audit (names only; `scripts/check-env.mjs` output at build, plus the dashboard list) | R | exactly the names in 05 §4; **none** of `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_URL`, `WORKER_DATABASE_URL`, `JOB_ENDPOINT_SECRET`, a database URL; `EDGE_LOCK_SECRET` present |
| P8 | One instance | R | the host reports one instance, autoscaling off, no disk; repeated requests show the same boot identifier from `/health` |
| P9 | Legacy and admin paths | R | a fixed list (`/`→307 `/spark`, `/browse`, `/categories`, `/hack/x`, `/profile/x`, `/submit`, `/admin`, `/top-creators`, `/manifesto`, `/api/hacks`, `/api/users/x`, `/api/admin/x`, `/api/auth/login`, `/auth/login`, `/auth/signup`, `/states`) answers the **uniform 404** body from the application itself (through the edge **and** direct to the origin with the header); disabled legacy routes are not reactivated |
| P10 | No indexing | R | `X-Robots-Tag: noindex, nofollow, noarchive` on every response; `robots.txt` disallows all. **Supplementary: the real protection is T5** |

## 2. Transport (T)

| ID | Check | Class | Expected |
|---|---|---|---|
| T1 | `http://` | R | permanent redirect to `https://`; no page content over HTTP |
| T2 | TLS | R | TLS 1.2 or newer (1.3 preferred); valid chain and host name; more than 30 days to expiry |
| T3 | HSTS | R | present on HTTPS responses (value and `includeSubDomains` decided and recorded) |
| T4 | Alias hosts | R | `www`/apex/any alias **redirects** and never serves; a mutation sent with an alias `Origin` is refused (the `APP_ORIGIN` rule) |
| T5 | Edge gate and origin lock | R | (a) an unauthenticated request to every path gets the Access challenge, never application content; (b) a request to the **`onrender.com` origin without** `x-hackass-edge` (and with a wrong value) gets the uniform 404 for every path except `/health`; (c) `/health` answers only readiness fields (no secrets, no values) |
| T6 | Page loads | R | only same-origin requests (plus anything the CSP explicitly allows); no mixed content; no third-party script |
| T7 | Response headers on `/spark`, `/lab`, `/reveal`, `/account/**`, `/auth/**`, `/work/**` | R | security headers present; `/auth/**` and `/work/**` are `Cache-Control: no-store` and JSON/HTML as designed; no framework or version leak |

## 3. Cookies over real HTTPS (C)  *(the item the local work could not prove)*

| ID | Check | Class | Expected |
|---|---|---|---|
| C1 | Sign-in cookies | M | **every** `sb-…-auth-token` chunk is `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` with **no `Domain`** attribute (host-only) |
| C2 | Setup-marker cookie (invitation/recovery exchange) | M | `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=900` |
| C3 | Sign-out | M | every session cookie is expired with the same attributes; the old cookie values are then refused (401) on a private read **and** write |
| C4 | Size and chunking through the edge and host | M | no 4xx for oversized headers; chunked session cookies round-trip |
| C5 | Cookie scope | R | **no state-changing GET anywhere, with one explicit exception: `GET /auth/session`**, which may rewrite the session cookies when it refreshes an expired access token (it changes no stored data; the source test asserts the exception and nothing else); a cross-origin or origin-less mutation is refused (403) |
| C6 | No shared caching of private responses | M | alternating requests by A and B to `/work/prompts` through the edge never return the other's body; no cache-hit headers; `no-store` honoured |
| C7 | Cookies are not script-readable | R | `document.cookie` lists no `sb-` name (browser) |

## 4. Session and Auth behaviour on the hosted provider (S)

| ID | Check | Class | Local evidence it repeats | Expected on hosted |
|---|---|---|---|---|
| S1 | Sign-in: wrong password and unknown address answer identically; no cookie on failure | M | PX-2b S1 | same |
| S2 | T2 on private calls: signed in → 200; signed out → 401 | M | PX-3b G1–G3 | same |
| S3 | Signing keys: the host can fetch them within the bounded timeouts; the token algorithm and the presence of a key set are **recorded** | R | PX-2b (ES256 locally) | record; stop and report if the verification path needs the secret key |
| S4 | Token refresh after expiry (`jwt_expiry` 600 s): idle past 10 minutes, then one request | M (time) | PX-2b refresh checks | one refresh, rotated cookies set once, no sign-out |
| S5 | Concurrent refresh: several parallel requests with the same expired session | M | PX-2b (8 parallel) | all succeed; behaviour recorded (the local finding is that no single-flight exists and the family is not revoked) |
| S6 | Revocation: sign out in tab 1; tab 2's next private call | M | PX-3b G3, PX-3c F2 | 401 on the next call; no stale private content shown (UI) |
| S7 | Session lifetime: the cookie lives 7 days; the provider's time-box / inactivity settings are **read back**; whether the provider enforces a 7-day overall limit is **recorded** (CONFIRM availability on the plan) | R | open item since PX-2b | record; if not enforceable, state the actual limit |
| S8 | Password rules: 11 characters refused, 12 accepted; 72 bytes accepted, 73 refused | M | PX-2b | same |
| S9 | Recovery end to end with a **real email**; replay of the link refused; unknown address gets the same answer; per-user cool-down | M | PX-2b (Mailpit) | same; mail arrives; link host is the pilot origin |
| S10 | Invitation end to end; public sign-up refused by the provider with 422 `signup_disabled` | M | PX-2b R1/R2 | same |
| S11 | Account switching: signed in as A, open B's link | M | PX-2b | explicit confirmation required; A's session intact until confirmed |
| S12 | Auth outage behaviour | — | PX-2b O1/O2, PX-3b G4 | **not testable on hosted without fault injection**; the local evidence stands (outage = retryable 503, no cookie touched, nothing written) and is stated as such |
| S13 | Clock | R | — | the host's clock agrees with the provider's `Date` within seconds; recorded |

## 5. Hosted ownership and isolation (O)  *(over HTTPS, real Auth and PostgREST, two members)*

| ID | Check | Class | Local evidence it repeats | Expected |
|---|---|---|---|---|
| O1 | A creates a prompt and a result (UI journey) | M | PX-3c S1, R1 | saved; visible only to A |
| O2 | B tries to read, update, delete, attach to and combine with A's items: 8 operations × (A's id, a missing id, a **malformed path id**) | M | PX-3b X1 | A's id and a missing id give **identical 404** bodies; a malformed id in the **path** is the same plain 404; **a malformed id in a request body** (for example `prompt_id`) stays **400** `validation_failed` (as built and tested in PX-3b); A's data unchanged; nothing written for B |
| O3 | B's lists, export and crafted cursors | M | PX-3b X2 | empty; A's rows never appear |
| O4 | **Actual RPC calls**: `node scripts/pilot-rpc-checks.mjs --hosted --confirm-pilot <ref>` (after `api` is exposed and read back): the 11 member functions with **no session** and with the **secret key** are refused (401/403/permission denied) and nothing is written; member A's own calls **succeed for all 11 functions, including `delete_my_prompt`**; B gets the identical not-found for A's ids. The run stops at the first failure, cleans up and **verifies** the removal of its fixture users (exit 3 if not) | M-class (denials; would write if isolation broke) | PX-3a pgTAP grants, local R0–R7 | as stated; the OpenAPI document is not consulted |
| O5 | The database guard with a **valid token on a revoked session**, and on a **disabled account** (operator flips the status as `postgres`, then restores it) | M | PX-3a pgTAP, PX-3b G5 | session invalid (28000-class) and forbidden (42501-class); both refused **by the database** |
| O6 | Tables are not reachable through the API (`/rest/v1/saved_prompts`, `/rest/v1/saved_reflections`, with and without a profile header) for anonymous, member and secret-key callers | R-class denial | PX-3a | refused or not found |
| O7 | Receipts: create, move the prompt on (another edit), replay the create; update with the receipt's version | M | PX-3a, PX-3b W2 | original receipt flagged `replay` and `superseded`; the update is a conflict (409); the newer text intact |
| O8 | Concurrency over real latency: two parallel updates with the same version; two identical creates; competing combined saves | M | PX-3a two-connection checks, PX-3b W3 | one wins, one 409; one row for identical creates |
| O9 | Quotas on a scratch member (prompts at 99/100, results at 49/50): the loser gets `quota_exceeded` | M | PX-3a | exactly one succeeds; distinct from rate limiting |
| O10 | Erasure: delete a test member (dashboard or admin API) | M | PX-3a pgTAP | their prompts and results are gone, the account row remains marked deleted, other members unaffected |
| O11 | Export: paged, at most 50 rows, own data only, no owner id or request internals | M-class reads | PX-3b E1, PX-3c X1 | same |
| O12 | Throttles behind the edge: (a) the 61st write in 5 minutes → 429 with `Retry-After`; (b) two client addresses counted separately (the address comes from `CF-Connecting-IP`); (c) a **spoofed** `X-Forwarded-For` or `CF-Connecting-IP` sent by a client **through the edge** does not change the bucket, and one sent **direct to the origin** is refused by the lock; (d) many members behind one address share the address rule | M | PX-3b T1; unit tests; G11 | as stated; the trusted-address setting is recorded |
| O13 | CSRF on every mutating route: foreign and missing `Origin`, and the alias origin | M-class (refusals) | PX-3b G6 | 403 everywhere; nothing written |
| O14 | Application logs after the journeys: search for the test markers, test addresses, cookie and token fragments | R | none; only operation names and outcome kinds. **Hosting and proxy logs are checked separately in K1–K4** |
| O15 | Backups | R | — | a backup exists; retention in days recorded (feeds the privacy text) |

## 6. Email (E)

| ID | Check | Class | Expected |
|---|---|---|---|
| E1 | SPF, DKIM and DMARC alignment in the headers of received invitations/recoveries | M (sends mail) | pass/aligned |
| E2 | Delivery to the inbox (not spam) at two mailbox providers | M | delivered |
| E3 | Link host and path | M | the pilot origin, `/auth/callback?type=…&token_hash=…`; the GET page does not consume the token |
| E4 | Bounce/complaint reporting reachable by a named person | R | yes |

## 7. Rollback readiness (X)

| ID | Check | Class | Expected |
|---|---|---|---|
| X1 | Redeploy the previous build; sign-in and a saved prompt still work | M | works; no data change |
| X2 | The host-scoped block rule closes access for new visitors **and** for an already authenticated Access session (M1); the origin lock keeps the origin closed meanwhile | M | closed within the time recorded; reopened afterwards |
| X3 | **Key rotation only**: rotate the three application secrets (`CURSOR_SIGNING_SECRET`, `AUTH_THROTTLE_SECRET`, `AUTH_SETUP_MARKER_SECRET`) and `EDGE_LOCK_SECRET` (redeploy with the new value, then update the Cloudflare rule) | M | members stay signed in (secrets do not hold sessions); outstanding pagination cursors and in-flight setup markers are invalidated; the old edge secret is refused. **This is not session revocation** |
| X4 | The provider's backup/restore procedure is read and the retention recorded (a restore rehearsal on a scratch project is a separate gate) | R | recorded |

| X5 | **Session revocation** (separate from X3): (a) member A signs in on two devices; the operator revokes A's sessions (admin global sign-out); both devices get 401 on the next private call and the database guard refuses A's still-unexpired token; (b) **mass revocation** by the operator (`delete from auth.sessions`, run as `postgres`, the exact statement in 05 §9) on the test members; every test member must sign in again; (c) the JWT signing-key rotation is **not** used as revocation (it is documented not to sign users out) | M | all test sessions refused by the database guard until sign-in again |

## 6a. Maintenance gate (M)  *(the gate must work against a session that already exists)*

| ID | Check | Class | Expected |
|---|---|---|---|
| M1 | A browser holds a **live Access session** for an allowed address and a **live application session**; enable the prepared host-scoped block rule; repeat a page load, a `/work/prompts` call and an `/auth/session` call from that browser | M | **all blocked at the edge**; changing the Access policy alone is **not** accepted as proof. If the authenticated session is not blocked, the procedure fails and the owner decides (fallback: revoke the Access application's tokens as well, recorded here) |
| M2 | A request without any session from another network | M | blocked; `/health` at the edge is blocked too, and `/health` at the origin with the lock header still answers (this is how a deploy is observed) |
| M3 | Disable the rule | M | the same browser works again; the owner-only variant (rule with the owner's address excluded) admits only that address, tested from a second address |

## 6b. Logs: emailed callback tokens and sensitive query parameters (K)  *(hosting and proxy logs, not only application logs)*

Method: send real invitation and recovery emails to the owner-controlled test members, complete one, leave one unused, then search every log the platform offers for a unique fragment of the `token_hash` value (taken from the received email, not recorded), the `/auth/callback` path with a query string, and the test addresses.

| ID | Check | Class | Expected |
|---|---|---|---|
| K1 | Render: service logs (stdout/stderr) and, if the workspace shows them, HTTP request logs | R | no token fragment, no address; **record whether HTTP request logs exist at all** (Hobby: not recorded; Pro and higher: recorded, which would show paths and queries and must then be reviewed before further invitations) |
| K2 | Cloudflare: Access authentication logs and analytics/traffic views available on the plan | R | no token fragment; **record** whether any view shows full URLs with query strings |
| K3 | Supabase: Auth and API logs for the verification step | R | **record** what is retained; token values must not appear in clear text (if they do, it is a finding for the owner, with the fragment-in-URL mitigation in 02 §6) |
| K4 | Sensitive query parameters in general: `code`, `token`, `token_hash`, `access_token`, `refresh_token`, `error_description` in any log | R | none visible, or the finding recorded with the mitigation chosen |

## 6c. Single process behaviour (L)

| ID | Check | Class | Expected |
|---|---|---|---|
| L1 | Origin lock matrix on the hosted origin: no header, wrong, partial, extended, empty | R | uniform 404; `/health` still answers |
| L2 | Counter reset is real and acknowledged: fill the sign-in throttle for a test address, restart the service from the dashboard, observe the counter is empty | M | confirms the documented behaviour; the owner's acknowledgement (D3) is on record |
| L3 | Deploy overlap: with the maintenance rule **enabled** (M1 proven), run a deploy: no tester request reaches either instance; the old instance is seen **stopped** (dashboard) and at least 90 s have passed before the owner-only reopening; only then the owner journey and the general reopening | M | procedure in 05 §6 followed; times recorded |
| L4 | `/health` is the host's check target: a deliberately wrong environment on a throwaway deploy makes `/health` return 503 and the deploy fail (the old instance keeps serving) | M | deploy cancelled; no downtime beyond the gate |

## 8. Order and cleanup
1. **R checks first:** P1–P10 (P3 only after `api` is exposed), T1–T7, C7, O6, O14 (before use), O15, E4, X4, L1.
2. **M checks with the test members:** C1–C6, S1–S11, O1–O13, E1–E3, M1–M3 (before the first L3 deploy test), K1–K4 (after the emails), L2–L4, X1–X3, X5 (S4 and S5 need a 10-minute wait).
3. **Cleanup:** delete the labelled content and the test members the owner does not want to keep (O10 doubles as the erasure proof); revoke any key or file created for the run; unset exported variables; keep the redacted evidence; delete the raw output.
4. **Result:** every check passes, or the failure is recorded and the run stops. There is **no "mostly passed"**: an open finding (for example F-H9-1) is recorded as an explicit, owner-approved exception.

## 9. What stays unverified even after these checks
Behaviour under real load or several instances (the throttle is single-instance by design); a provider or edge outage; a restore from backup (a separate rehearsal); screen-reader testing beyond roles and live regions; long-term cookie behaviour across browser updates; anything about deliverability to mailbox providers not tried.
