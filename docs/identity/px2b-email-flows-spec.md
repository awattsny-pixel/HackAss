# PX-2b specification: invitation, confirmation and recovery email flows (implemented locally in PX-2b: see px2b-local-verification.md)

Pilot decisions applied: email + password; 12-character minimum; **invite-only** (owner-issued invitations); manual account deletion; session limits (8 hours inactivity, 7 days overall) are **provisional until enforcement is confirmed** (the local config shows them only as commented-out options; hosted support not verified; the application does not promise them).

## 1. Principles
1. **A GET never consumes a one-time token.** Mail scanners, link previewers and browser prefetch issue GETs; if a GET consumed the token the member would find it "already used". The emailed link opens a **callback page** (read-only); the exchange is a **same-origin POST** triggered by a button.
2. **The link points at our own origin** and carries the provider's `token_hash` (email template: `{APP_ORIGIN}/auth/callback?type=<invite|recovery|email_change>&token_hash={{ .TokenHash }}&next=<path>`), not the provider's verification URL, so no tokens arrive in a URL fragment and every step is server-side. (Changing the templates is a provider-configuration change: local config file for development; the hosted project is a separate, held, owner-authorized step.)
3. **No self-registration anywhere** (section 5).
4. **Every redirect target is validated** (`safeReturnPath`); the member never sees technical terms.

## 2. Flows
### 2.1 Invitation (owner-issued)
1. The owner invites an email address from the provider's dashboard (no admin key in the app).
2. The member opens the link: **GET `/auth/callback`**: `parseAuthCallback`; shows "Accept your invitation" with a **Continue** button (a form POST with the token in a hidden field). No state change, `Cache-Control: no-store`, `Referrer-Policy: same-origin` (nothing is sent to other sites; **`no-referrer` was tried first and broke the form: Chrome then sends `Origin: null` on the same-origin POST, which the same-origin check correctly refuses; found by the PX-2c real-browser checks, which the earlier script-based checks could not see**), no third-party resources.
3. **POST `/auth/callback/exchange`**: same-origin check (`assertSameOrigin`); throttle `invite-callback`; `verifyOtp({ type: 'invite', token_hash })`; success sets the session cookies; failure goes through `mapAuthError`.
4. 303 to **`/auth/set-password`**. The exchange handler also issues a **setup marker**: an HttpOnly, `SameSite=Lax`, `Secure` (non-local), `Path=/` cookie holding an HMAC-signed value bound to the user id and the new session id with an expiry of 15 minutes (secret from configuration; same class of secret as the throttle hash secret). The requested `next` is carried as validated data and used only after the password is set.
5. **POST `/auth/set-password`**: T2 session; origin check; throttle `set-password`; `validatePassword` (server-side, authoritative); `updateUser({ password })`; success: the marker is cleared and the response is a 303 to `safeReturnPath(next)`.

### 2.2 Recovery (forgotten password)
1. **POST `/auth/recovery/request`** (email): origin check; throttle `recovery-request` (per address and per email); always answers **202 with the same sentence**, whether or not the email belongs to a member; the provider sends mail only to existing members.
2. Link type `recovery` → the same callback page and exchange as 2.1 (throttle `recovery-callback`) → `/auth/set-password` → `next`.

### 2.3 Confirmation (email change)
Supported by the same callback (`type=email_change`; the provider's double-confirmation setting stays on). **Initiating an email change is not offered in the pilot** (owner handles it manually), so no request screen exists. **Sign-up confirmation does not exist**: a `signup` or `magiclink` link is refused with the "registration is closed" state.

## 3. Callback page states (each with plain wording and the actions it allows)
| State | When | Shown | Actions |
|---|---|---|---|
| ready | valid parameters | "Accept your invitation" / "Reset your password" / "Confirm your new email" | Continue (POST) |
| expired or used | provider refused the token (`otp_expired` and the like), or the POST failed that way, or a repeat click | "This link has expired or has already been used." | invitation: "Ask the owner for a new invitation"; recovery: "Request a new link"; email change: "Ask the owner" |
| invalid | missing, malformed or unsupported parameters | "This link isn't valid." | go to sign-in |
| registration closed | `signup`/`magiclink` type | "Registration is closed for now. Ask the owner for an invitation." | go to sign-in |
| rate limited | throttle or provider limit | "Too many attempts. Please wait a few minutes." (+ retry-after) | retry later |
| unavailable | outage | "This is temporarily unavailable. Please try again." | try again |
| signed in already | a session cookie is present (implemented in revision 2) | the link page says the member is signed in on this browser and that continuing signs them out first; the exchange without the explicit confirmation is 409 and consumes nothing | "Sign out and continue" (explicit), or go back |

A second POST with the same token yields "expired or used": the token is consumed exactly once, by the provider.

## 4. Safe redirects and handling of tokens
`next` passes through `safeReturnPath` at parse time and again when the redirect is built; the `Location` is relative; `next` is never written into HTML unescaped; error paths never redirect to caller-supplied URLs. The token hash appears in the callback URL and in a hidden field: mitigated by `Referrer-Policy: same-origin` (the callback URL is never sent to another site), `no-store`, no external resources, optional removal from the address bar after load, and because it is single-use and short-lived (lifetimes are provider settings, **to be confirmed**).

## 5. Enforcement: who may register, and what an unfinished invitation may do (decided here, before PX-2b)
### 5.1 Public registration (invite-only)
Authoritative layer: **the provider's setting** (public sign-up disabled, `enable_signup = false` for the pilot locally and on the hosted project). There is no application or database backstop that can replace it (the database creates an account for every non-anonymous Auth user by design; an allowlist hook is a possible later layer, unverified for the hosted plan). Therefore:
1. a PX-2b **automated negative test** calls the Auth API's sign-up against the target stack and must be refused (local now; hosted **before any external tester**, as the first hosted check, because a wrong setting there silently opens registration);
2. defence in depth in the application: no sign-up route, handler, action or screen; the identity module has no such capability (test); the callback refuses `signup` and `magiclink`;
3. anonymous sign-ins stay off; invitations are issued by the owner in the provider dashboard (no admin key in the app).

### 5.2 Password setup after an invitation or recovery (what is restricted, how, and how strongly)
* **Purpose of the restriction:** make the member choose a password before using the account, so they can sign in later without a link. It is a consistency and usability rule, **not** a security boundary: the invitation link already proves control of the mailbox, and a member who bypasses the step only ends up with a session that has no password (they recover through the recovery flow).
* **Mechanism:** the signed **setup marker** (section 2.1 step 4). While a valid marker is present for the current session, a single server-side gate in the handler layer allows **only** `GET/POST /auth/set-password`, sign-out and the public pages, and refuses every private read or write with a "set your password first" state (the check is part of resolving a T2 operation, so it cannot be forgotten per route). The marker is cleared by a successful password change, expires after 15 minutes, and is rejected if its user or session binding does not match.
* **What it does not do:** it is not recorded in the database and the database guard does not know about it; deleting the cookie lifts the restriction for that session. This is accepted for the pilot. **If authoritative enforcement is wanted** it needs a database field and guard (`app.accounts` password-set state, checked by `require_member`), which is a **migration** and is therefore a separate, held decision.
* **Required PX-2b tests:** a session obtained from an invitation or recovery cannot read or write private data until the password is set; the marker is bound to user and session and expires; tampering is rejected; set-password is T2, origin-checked, throttled and validated server-side; after success the gate is lifted and `next` is honoured only through `safeReturnPath`.

## 6. Drafts (prompts and reflections live in memory only)
* **Same tab, client navigation** (sign-in screens inside the experience shell): the draft is kept.
* **The email link opens in another tab or window of the same browser:** that page starts empty; the draft **stays in the original tab**, and the session cookie is shared across tabs of the same browser profile, so after exchange the member can return to the original tab (PX-2c: it re-checks the session on focus without reloading).
* **The email is opened on a different device, browser or profile** (for example a phone): **no draft and no session can be carried across**. The page says so: *"Your unsaved work stays in the tab where you started it. If you open this email on another device or browser, sign in there; this tab won't know. Copy anything you want to keep first."*
* **A link opened in the same tab as the draft replaces the page:** the draft is lost (the leave-page warning applies only to navigation away from our pages, not to an emailed link). The existing "Not saved—copy your work before leaving" wording stays everywhere. No browser-storage stash of drafts is proposed.

## 7. Throttling per action (defaults in `DEFAULT_RULES`, provisional)
sign-in: 10 per address per 5 min, 5 per address+email per 15 min, 300 global per 5 min; invite-callback and recovery-callback: 20 per address per 5 min; recovery-request: 5 per address per hour, 3 per email per hour, 60 global per hour; set-password: 10 per address per 5 min. Unknown address (no trusted source): one shared bucket per action governed by the action's own per-address limit (never a looser one), so a trusted source must be configured first. Client address from a trusted source only; no secret-key forwarded-IP mechanism; the in-memory store is single-instance only (see `px2a-identity-module.md`).

## 8. Prerequisites before any external tester
Real SMTP with an authenticated sender domain; real-browser HTTPS verification of the cookie behaviour (S1); provider settings confirmed on the hosted project (sign-up off, token lifetimes, password length, session limits, rate limits); a shared throttle store if more than one instance serves traffic; the email templates pointing at the callback; the invitation process documented for the owner.

## 9. Held
PX-2b and later implementation, commits, migrations, hosted changes, pushes, merges, deployment.
