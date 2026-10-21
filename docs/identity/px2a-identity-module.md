# PX-2a: the identity module (rules only; no Auth client, no routes, no cookies)

Status: implemented locally on branch `px2a-identity` (from `c423aa4`), **uncommitted**. PX-2b and later are held. Everything here is pure application logic with injected inputs; nothing has been exercised against a real Auth server, a real browser or any hosted service.

## 1. What the module contains (`src/modules/identity`)
| File | Purpose |
|---|---|
| `resolver.ts` | `resolveActor(source, tier)` / `authorize(source, operation)`: trust levels T0, T1, T2 and failure handling |
| `redirect.ts` | `safeReturnPath`: the only way a `next` value may become a destination |
| `password.ts` | pilot password rule (12 characters minimum, 72 bytes maximum) |
| `errors.ts` | uniform member-facing failures; fixed recovery-request response |
| `callback.ts` | `parseAuthCallback`: validates an emailed link's parameters without consuming anything |
| `throttle.ts` | trusted client address, keyed hashes, bounded counters, `runThrottled` (server-only) |

There is **no sign-up capability** in the module (pilot is invite-only, see the PX-2b spec) and the module never builds an Auth or database client; a test scans the source for both.

## 2. Trust levels and what each may do
| Tier | Established by | May be used for | Known limit |
|---|---|---|---|
| T0 | nothing required | public pages; a signed-in member is still recognised (at claims level) | none |
| T1 | access-token **claims**: signature and expiry verified locally | **only** a provisional signed-in indicator | accepts a token revoked by sign-out until it expires (10 minutes by the current setting) |
| T2 | the **Auth server** confirmed the session just now, for the same user the claims name | everything that reads or writes a member's saved data, and account changes | needs the Auth server to be reachable |

Operations are named (`OPERATION_TIER`): `public-read` T0; `show-signed-in-indicator` T1; **`read-private` T2; `write-private` T2; `change-account` T2**. Reading saved prompts or reflections is not a lighter operation than writing them. Every T2 operation must **also** pass the database's own account and session guard (invariant I-3: `require_member`, `app_bridge.session_valid`); the application tier is defence in depth, not the boundary.

## 3. Failure handling (T2 is never downgraded)
| Situation | Result |
|---|---|
| a **definite** verdict that there is no usable credential: no session, expired (also by the clock), invalid | `unauthenticated` 401; the Auth server is not asked |
| Auth server says the session is revoked or gone | `unauthenticated` 401 |
| Auth server confirms a **different, readable** user than the claims name | `unauthenticated` 401 |
| the **verification itself could not be done**: the claims source reports `unavailable` (for example signing keys unreachable), throws, rejects, or returns something uninterpretable (malformed claims, unknown reason) | **`auth_unavailable` 503, retryable** (T1 and T2; T0 stays anonymous) |
| Auth server unreachable, slow (timeout, default 3 s), throws, reports "unavailable", or answers with something malformed, **including a "success" with no usable user id** | **`auth_unavailable` 503, retryable** |

Rule: only an explicit, interpretable verdict about the credential may produce a 401. Anything we cannot interpret is "unavailable". **Neither outcome ever produces a member, and a T2 request is never served at T1 level.**

A page can therefore show "we can't check your session right now, try again" for private data during an outage, while public pages and the provisional indicator keep working.

**For PX-2b (the composition root) the mapping from the Auth client to `SessionSource` is the risky part and must be explicit:** network failure, timeout, HTTP 5xx, a failure to fetch signing keys and any unrecognised error are `unavailable` (in both `claims()` and `serverVerify()`); only a definite "session not found / invalid / expired" answer from the Auth server is `revoked` or `no_session`. Misclassifying an outage as `revoked` would sign members out during an incident; misclassifying a revocation as `unavailable` is safe but noisy. `claims()` must verify the token signature (asymmetric keys, JWKS) and expiry itself, not just decode it.

## 4. Redirects
`safeReturnPath(next)` returns a path inside an allowlisted area (`/spark`, `/lab`, `/reveal`, `/states`, `/account`) or `/spark`. Refused: any scheme or host, `//`, backslashes, whitespace and control characters (also after up to three rounds of percent-decoding), `%` or `:` or `@` in the path, `.`/`..` segments, empty segments, unknown areas, over-long values, malformed escapes, non-strings. A bad query string is dropped while a good path is kept; fragments are dropped. About 50 hostile inputs are in the test corpus.

## 5. Throttling: what it does, and what it does not
**Why it is needed.** The Auth provider rate-limits per IP address. Our Auth calls are server-to-server, so the provider sees the **application server's** address for every member: one abusive client can exhaust that limit for everyone. The provider's mechanism for forwarding the real client IP requires the **secret key**, which is outside our application boundary (the app never holds a service-level key). **That key is not used here and must not be introduced as a shortcut.** The application therefore rejects abuse itself, before the provider is called (`runThrottled` always checks first; a test proves a denied request never reaches the provider call).

* **Client address:** only from a source configured as trusted: `{kind:'header', name}` (a header our own infrastructure sets/overwrites), or `{kind:'forwarded-for', trustedHops:N}` (counted **from the right**; the client-controlled left side is ignored; fewer entries than hops means "not trusted"). Default `{kind:'none'}`: the address is unknown and **all such requests share one bucket per action that is governed by that action's own per-address limit** (for example recovery requests: 5 per hour in total for all unknown-address traffic; tested to deny the sixth exactly like a known address). An optional `unknownIpExtra` restriction is applied **in addition**, never instead. Consequence to be understood: with no trusted source configured, unknown-address traffic competes for one small bucket, so a trusted source must be configured before the pilot. Which source is correct depends on the hosting platform, which is not chosen yet (deployment is held). IPv6 is reduced to its /64; IPv4-mapped IPv6 is treated as IPv4.
* **Identifiers:** emails are normalized (NFKC, trim, lower-case) and, like addresses, stored only as **keyed hashes** (HMAC-SHA256 with a secret of at least 32 characters, purpose-separated, truncated to 128 bits). No stored key contains an address or an email (tested). The secret is a new configuration value the composition root must supply in PX-2b (env validation change, held).
* **Counters:** fixed windows, **bounded** (10,000 keys by default) **without ever evicting an active counter**: only expired entries are reclaimed; when the store is full of active counters a request that needs a NEW key is **denied** (`scope: 'store'`, with a retry time) while existing counters, including the global one, keep counting. Stated trade-off: an attacker using very many distinct addresses can fill the store and deny new addresses until windows end; that is denial of service, chosen over any way of resetting a limit under pressure. Per action: per address; per address+email (sign-in guessing); per email across addresses (recovery requests only, to stop email bombing; deliberately **not** on sign-in, where an email-wide limit would let an attacker lock a member out); global. All probes are counted every time. Default numbers are **provisional** and in `DEFAULT_RULES`.
* **Storage strategy (documented limit):** the memory store is **per process**. It is correct for **one running instance** only; with several instances or serverless functions each has its own counters and the effective limits multiply. A shared store (a database table behind a guarded function, which is a **migration**, held; or a platform key-value store) is required before more than one instance serves traffic. Not implemented in PX-2a.
* **Store failure:** always fails **closed** (deny, retry after 30 s, or the capacity retry time). There is no option to allow.
* **Not done:** CAPTCHA, per-account lock-out, anomaly detection, hosted rate-limit facts (unknown until verified), distributed counters.

## 6. Other rules
* **Password:** at least 12 characters (counted as characters), at most 72 UTF-8 bytes (bcrypt limit, to be confirmed against the provider), no composition rules, no control characters, not equal to the email. A leaked-password check is provider-side and **not** assumed.
* **Failures:** unknown email, wrong password, banned, unconfirmed and sign-up-disabled all read the same ("The email or password is not correct."); provider codes and text never reach the member; unknown or 5xx errors are "temporarily unavailable". The recovery request always answers 202 with the same sentence.
* **Callback parsing:** accepts `invite`, `recovery`, `email_change`; refuses `signup` and `magiclink` (public registration is unavailable) and anything else; token hash shape-checked; `next` through `safeReturnPath`; provider error parameters become "expired".

## 7. Tests (`tests/identity-*.test.ts`, 35)
Resolver (T0/T1/T2 matrix, definite verdicts vs verification-service failures in both the claims and the server paths, unreadable "success" answers, revoked, user mismatch, never producing a member on any failure, the documented T1 limitation, private reads are T2, agreement with the platform's `satisfiesTier`); redirect corpus; throttle (trusted address policies, IPv6 /64, keyed hashes and key contents, limits and windows, per-email limit vs sign-in, **unknown-address limits equal to the action's limit for every action**, **regressions for capacity pressure (6,000 distinct requests, global limit 300; small store)**, bounded store without eviction, fail-closed store with no allow option, throttle-before-provider); password; uniform failures including **server failures taking precedence over any error code**; callback parsing; module guarantees (no Auth client, no environment, no browser storage, no sign-up capability). `tests/lint-boundaries.test.ts` was updated to list the identity module's files.

## 8. Not in PX-2a (held)
Handlers/actions, cookies, refresh, the Auth client composition, screens, the env variable for the hashing secret, email templates, any provider setting, a shared counter store, any migration, hosted verification (real-browser HTTPS cookies, SMTP, hosted rate limits, hosted session limits), commits, pushes, deployment.
