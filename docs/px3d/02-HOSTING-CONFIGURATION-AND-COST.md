# 02 · The concrete hosting configuration, its restrictions and its cost

**Proposal only. Nothing here was created, contacted or purchased. The indicative budget stands; every price must be confirmed against the owner's own accounts and plans before anything is purchased.** Provider facts were read from the providers' public pages on **2026-10-21** and are marked **V** (read from the provider's own page or docs that day), **S** (quoted in a search result from the provider's site; the page itself did not render in the fetch) or **N** (not verified). They are not a quote: prices change, and a real bill depends on the account.

## 1. The configuration in one table

| Layer | Choice | Settings that matter |
|---|---|---|
| Application host | **Render**, one **web service** on a **Hobby workspace** (owner as the single member), plan **Starter** (0.5 CPU, 512 MB), region next to the database | Node 22.23.3 (`NODE_VERSION`), build `npm ci && node scripts/check-env.mjs && npx next build`, start `npm start`, **health check path `/health`**, **auto-deploy OFF**, no persistent disk, no autoscaling |
| Edge and access protection | **Cloudflare**: the owner's domain on the free plan, `pilot.<domain>` proxied; **Zero Trust Access** (free plan, up to 50 users) with an Allow policy for the named testers' addresses; a **request-header rule** that adds the origin-lock header | SSL/TLS mode Full (strict); HSTS is sent by the application |
| Origin lock | the application refuses (uniform 404) everything that lacks the exact header `x-hackass-edge: <secret>`, except `/health` | secret compiled into the build (`EDGE_LOCK_SECRET`, build time); rotated by redeploy |
| Database and Auth | **Supabase**, a new project **`hackass-pilot`**, **Pro** plan, Postgres 17, direct migration route with verified TLS | `api` schema only exposed; public sign-up off; minimum password 12; `jwt_expiry` 600 s; **session time-box 7 days** (a Pro feature, **V**); custom SMTP |
| Email | **Resend** free plan through SMTP, a sender on the pilot's domain (SPF, DKIM, DMARC) | credentials entered only into Supabase Auth's SMTP settings |
| Application secrets | in Render's environment only: `CURSOR_SIGNING_SECRET`, `AUTH_THROTTLE_SECRET`, `AUTH_SETUP_MARKER_SECRET`, `EDGE_LOCK_SECRET` | each at least 32 random characters |

## 2. Restrictions the owner must accept (explicit)

### 2.1 One process, and what that does and does not give
The sign-in and saved-work throttles keep counters **in process memory**. That is correct for exactly one running process and **only while it keeps running**:

1. **Counters reset on every restart, deploy and crash.** Render restarts an instance that fails its health check for 60 seconds, and every deploy starts a new process (**V**, health-check docs). After a reset an attacker gets a fresh allowance.
2. **Render overlaps the old and the new instance during a normal deploy** (**V**, deploys docs): the old instance keeps taking traffic while the new one starts; when the new one is healthy traffic switches and the old one gets a shutdown signal with a **60-second** grace period. For that window two processes each hold their own counters. The overlap is **not configurable**; attaching a persistent disk disables zero-downtime deploys (**V**) and would remove the overlap at the price of a short outage, which is not chosen here.
3. **A shared throttle store stays deferred** for this small pilot (a database table would be a migration; a platform key-value store would be a new dependency). The risk is accepted **explicitly** (owner acknowledgement, D3 in the README): the pilot has a handful of invited testers behind an access gate and an origin lock, and Supabase Auth applies its own per-IP and per-user limits independently of the application.
4. **Therefore: a maintenance gate during every deployment** (05 §6): a **host-scoped Cloudflare block rule** (not only an Access policy change, which would not by itself end an already issued Access session; proven against an authenticated session in 03 M1) is enabled before the deploy starts and removed only after the new instance is healthy **and the old one is stopped** (a new boot id alone does not show the old process has drained), with owner-only access restored first, so no tester and no attacker is served by two processes with different counters, and no one benefits from the reset.
5. Checks 03 (L-series) prove the lock, the reset behaviour and the gate procedure.

### 2.2 The origin cannot be restricted to the edge on this plan
Render's per-service **inbound IP rules** are documented for **Scale and Enterprise** workspaces (**V**, inbound-IP-rules docs). On Hobby, the service stays reachable at its `onrender.com` address (and by IP with a `Host` header), so an edge in front of it can be **bypassed**. The origin lock in the application (PX-3e) closes this: without the secret header, every request is a uniform 404 (verified on a real build: no header, wrong, partial, extended and empty values are all refused; `/health` is exempt for the host's health check).

### 2.3 Client address and throttling
With the lock in place only requests that passed through Cloudflare reach the application, so the application reads the client address from **`CF-Connecting-IP`** (`TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip`). Cloudflare overwrites that header on every request it forwards (**S**, Render's own article on Cloudflare and client addresses); `X-Forwarded-For` is *not* trusted because a caller controls its leftmost entry. Without the lock this setting would be spoofable: the two settings go together, and the environment check refuses a production configuration without the lock.

## 3. Access protection (defence in depth)

| Layer | Control | Verified how |
|---|---|---|
| 1. Identity-aware gate | Cloudflare Access Allow policy for named addresses (one-time PIN to the address, or the owner's identity provider) | 03 T5 |
| 2. Origin lock | `x-hackass-edge` secret, added by a Cloudflare request-header rule and enforced by the build | 03 L1–L4; local proof in `docs/px3d/results/px3e-local-checks.txt` (G11) |
| 3. Path allowlist | only the preview's routes; legacy pages, `/api/**`, `/auth/login`, `/auth/signup`, `/states` refused with one uniform 404 | local G1, G8; 03 P9 |
| 4. No indexing | `X-Robots-Tag: noindex, nofollow, noarchive` on every response, `robots.txt` disallows all. **Supplementary only**: it does not protect anything | local G4, G6 |
| 5. Invite-only accounts | public sign-up off at the provider; the application has no sign-up route | 03 S10 |
| 6. Transport and headers | HTTPS only (Cloudflare Full (strict), Render TLS), HSTS and `upgrade-insecure-requests` in HTTPS builds, CSP without third parties, no framing | 03 T-series |
| 7. Member protections | T2 verification, database guard, ownership checks, same-origin check (all unchanged and re-run on the gated build) | 03 O-series |
| 8. Throttles | single-process (see §2.1) plus the provider's limits | 03 O12, L5 |

**What the gate does not do:** it does not authenticate members (the application does), it does not stop a tester who passed the gate from abusing the app within the member limits, and a stolen Access session or a stolen edge secret defeats the outer layers (hence rotation in 05 §9).

## 4. Database (the pilot project)

### 4.1 A new project, never the staging project
Create **`hackass-pilot`**. `hackass-staging` is disposable, holds append-only synthetic fixtures and keeps its own history; neither shares keys with the project whose keys appear in git history.

| Setting | Proposal | Source |
|---|---|---|
| Plan | **Pro**, from 25 USD a month; **daily backups kept 7 days** (Free has no automatic backups and pauses after a week of inactivity); point-in-time recovery is a separate add-on (100 USD a month per 7 days) and is **not** chosen | **V** (supabase.com/pricing) |
| Region | one region, chosen once, near the Render region | owner (D5) |
| Direct access | the direct host is IPv6-only unless the **IPv4 add-on** is enabled: **0.0055 USD per hour (about 4 USD a month)**, billed hourly in arrears and **outside the spend cap**. It can be enabled **only for the migration and check windows** | **V** (docs) |
| Exposed schemas | **`api` only**, set after the migrations create it | owner |
| Auth | public sign-up **off**, minimum password 12, `jwt_expiry` 600 s, refresh rotation on (10 s reuse), email confirmations on, anonymous sign-ins off, **time-box 7 days** (Pro), custom SMTP | **V** (session time-boxing, inactivity timeout and single-session are Pro features; custom SMTP is included on both plans) |
| Worker role | created by the migrations **without a password**; the pilot never sets one | owner |

### 4.2 Migrations: the pilot-specific manifest, not the staging runner
* `docs/px3d/pilot-manifest.json` lists the **25 migrations** (the 21 F2 files and the 4 PX-3a files) in order with their SHA-256, the counts the database must have (**120 functions, 28 tables**), and the fingerprint of the expected catalogue inventory. It is **pilot-specific**; the historical staging plan (21 migrations) and the 2026-10-17 staging evidence (committed unchanged in `aee5287`, already an ancestor of `main`) are untouched and a test asserts it.
* `scripts/pilot-apply.mjs` verifies every file against the manifest, requires the ledger to be an exact prefix, refuses anything but the **direct** host at port 5432 as `postgres` with `sslmode=verify-full`, applies **one file per transaction with its ledger row inside it**, and stops at the first failure. Dry run is the default; a hosted write needs `--apply --confirm-pilot <project-ref>`. Rehearsed locally: committed PX-3a rollback, dry run (4 pending), apply, identical inventory, second apply a no-op.
* `docs/px3d/pilot-inventory.sql` is the **exact SQL inventory** (read-only; the function section uses the same catalogue expression as the golden inventory in `010_roles_and_grants.test.sql`, which PX-3a already extended). `scripts/pilot-inventory.mjs` compares its output line for line with `pilot-inventory.expected.txt` (187 lines: 120 functions, 28 tables, 25 ledger rows, 0 table privileges for the API roles, the three `auth.users` triggers, the nine schemas).
* `scripts/pilot-rpc-checks.mjs` verifies **actual RPC calls** for all 11 member functions (it must record a successful owner call for each, including `delete_my_prompt`): anonymous and service-role callers are refused; a member's own calls work; another member gets the identical not-found; a revoked session's still-valid token is refused by the database guard (and, locally, mass revocation by SQL). **The OpenAPI description is not used as proof**: it is not required to list the member functions.
* **What is outdated in the accepted hosted runner** (`scripts/hosted/*`) and why it is not used for the pilot: its schema list lacks `app_work`, its OpenAPI allowlist is the 19 F2 functions, and its selftest and counts assume 21 migrations. The golden inventory it compares against is **already extended** (120). Updating the runner is possible later; the pilot does not depend on it.

### 4.3 F-H9-1 (carried forward)
The pilot never sets a worker password, so a worker login cannot succeed. The username disclosure through the hosted pooler is a property of the platform and stays observable; it remains **open** for the owner's disposition (D5) and is **carried forward, not re-probed automatically**: repeating the login-existence probes produces failed-authentication attempts on the hosted pooler and needs its own explicit instruction (03 P6): accept with a recorded exception, or pursue a remediation. It is not normalized.

## 5. Email (Resend free plan over SMTP)
| Item | Proposal |
|---|---|
| Plan | Resend free: **3,000 emails a month, 100 a day, 3 custom domains, SMTP included, 0 USD** (**V**, resend.com/pricing). Enough for invitations and recoveries to a handful of testers; the daily cap is the limit to watch |
| Sender | `no-reply@<pilot domain>` with **SPF, DKIM** and **DMARC** (start in report-only mode) |
| Where credentials go | only into Supabase Auth's SMTP settings; never the repository, the application or chat |
| Templates | the three reviewed templates; links `{{ .SiteURL }}/auth/callback?type=…&token_hash={{ .TokenHash }}`. The GET page is read-only and does not consume the token (mail scanners that open links cannot use it up); the POST exchange does |
| Site URL, redirects | Site URL = the pilot origin; **no other redirect URL** |
| Access gate and links | an emailed link opens on the gated origin: a tester may have to pass the Access login first and is then returned to the same URL (checked in 03 S9/S10) |
| Invitations | the operator sends them from the dashboard; the application never holds the service key |
| Bounces | watch Resend's reports; remove bouncing addresses |
| Sub-processors | Resend sees tester addresses and mail content: list it (§8) |

## 6. Tokens in logs: what is and is not suppressed
The emailed link carries a one-time token **in the query string**. The application never reads, logs or forwards it beyond the exchange (verified: the gate and the logger do not log it; local G7 and PX-2b L1). **Hosting and proxy logs are different systems:**
* **Render:** HTTP request logs, which show the request path, are recorded only for **Pro workspaces and higher** (**V**, logging docs). On a **Hobby** workspace they are not recorded; the application's own logs contain event names only. This is checked (03 K1) and is a reason to stay on Hobby for the pilot. If the workspace is ever upgraded, request logging must be reviewed before the next invitation is sent.
* **Cloudflare:** the free plan does not provide request-log export (Logpush is an enterprise feature, **N**); Access authentication logs record who logged in to which application. Whether any dashboard or log view shows full URLs with query strings is **checked and recorded** (03 K2), not assumed.
* **Supabase:** the emailed link is generated by Auth and its API logs may record the verification request; the application's exchange uses `verifyOtp` through the API with the token in the request body. This is checked in the project's logs (03 K3).
* **Mitigations if any log does show tokens:** tokens are one-time and short-lived (the provider's default OTP expiry is recorded in 03 P5); the exchange refuses a replay; and the template could be changed to carry the token in the URL fragment (a code change in the accepted email flow, **not** made here).

## 7. Cost (verified as published on 2026-10-21; **not a quote**)

| Component | Monthly | Status |
|---|---|---|
| Supabase Pro (`hackass-pilot`), includes 8 GB disk, 100,000 MAU, daily backups (7 days) and a 10 USD compute credit | **from 25 USD** | **V** |
| Render web service, Starter (0.5 CPU, 512 MB), always on | **7 USD** (Standard, 1 CPU / 2 GB, is 25 USD) | plan names and sizes **V**; prices **S** (a render.com search result; the pricing page itself did not render) |
| Render Hobby workspace | 0 USD (one member, 25 services, 5 GB bandwidth, custom domains, DDoS mitigation) | **S** |
| Cloudflare free plan (DNS, proxy) and Zero Trust **free for up to 50 users** | 0 USD | **S** (the paid tier is 7 USD per user a month; going over 50 users repriced the whole account in the source) |
| Resend free plan (SMTP) | 0 USD | **V** |
| Supabase IPv4 add-on | about 4 USD if left on; about 0.13 USD a day for a migration or check window only | **V** |
| Domain | the owner's; a new `.com` is typically 10 to 20 USD a year | **N** |
| GitHub Actions | included minutes (four job runs per CI run) | unchanged |
| `hackass-staging` until deleted | its plan cost plus its IPv4 add-on; the owner sets a deletion date | **N** (plan not recorded) |
| **Indicative total for the pilot** | **about 32 USD a month** (about 36 with the IPv4 add-on always on), plus the domain | the sum of the above |

Costs that could appear: Render bandwidth above the included amount, a Supabase compute upgrade if the smallest size is not enough, Resend above 3,000 emails, and Render Standard (25 USD) if 512 MB proves too small (watch memory in P0). None is expected for a handful of testers.

## 8. Privacy, retention and data handling
* The note at the Save button is **provisional**: "Private to your account; not shared with other members. Please don't store passwords or other secrets in prompts." It deliberately does not say "only you can see it": database operators and backups are outside the application's restrictions. The final text, the retention statement and tester terms are owner/legal decisions (D9).
* **Retention:** member content is kept until the member deletes it or the account is deleted; **backups keep deleted content for the plan's backup window (7 days on Pro, V)**.
* **Sub-processors:** Supabase (data), Render (application host), Cloudflare (edge, access), Resend (email), GitHub (source and CI).
* **Requests:** export is self-service; deletion is by the operator on request (deleting the Auth user triggers erasure of the member's prompts and results; the account row stays, marked deleted).

## 9. Capacity
One 512 MB process and the smallest database size are sized for **tens of members**. Per-member quotas (100 prompts, 50 results per prompt, 500 results) and the write throttle bound the load. Memory and database size are watched during the internal preview (P0).

## 10. Gate for external testers (every item, recorded)
1. All checks in 03 passed on the pilot, with redacted evidence kept.
2. **Custom SMTP** working with SPF/DKIM/DMARC aligned.
3. **Real HTTPS cookie verification** (03 C-series) and the **confirmed hosted Auth settings** (03 P5, S-series).
4. The smoke-test item (04) closed, and CI green on the final commit.
5. F-H9-1 dispositioned (D5); the origin lock and the legacy-route containment verified on the hosted build.
6. The throttle acknowledgement (§2.1) recorded by the owner.
7. Log checks (§6) recorded, including what Render and Cloudflare actually record.
8. Artwork rights confirmed for every image served: `public/hack/hack-official.png` is confirmed by the owner (2026-10-21, created from scratch); `mascot.png` and the default avatars still need the owner's confirmation.
9. Final privacy text, retention statement and tester terms approved (D9).
10. Backups confirmed (the 7-day daily backup exists; a restore rehearsal on a scratch project is a separate gate).
11. A named person who can close access (05 §8) and who receives the alerts.
