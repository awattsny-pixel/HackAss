// Pure translation of what the Auth client returns into the resolver's vocabulary. Structural only: it inspects `name`, `status` and
// `code`, never imports the client, so it is testable with plain objects. The rule that matters: only an explicit, interpretable verdict about the
// credential is "denied" (-> 401). Network failures, timeouts, rate limits, 5xx and anything unrecognised are "unavailable" (-> retryable 503) and must
// never sign a member out or look like a bad credential.
import type { Aal } from '@/src/platform';
import type { ClaimsResult, ServerResult } from './resolver.ts';

export type ProviderVerdict = 'session_missing' | 'revoked' | 'unavailable';
const DENIED_CODES: ReadonlySet<string> = new Set(['session_not_found', 'session_expired', 'bad_jwt', 'invalid_jwt', 'refresh_token_not_found', 'refresh_token_already_used', 'user_not_found', 'user_banned']);
const UNAVAILABLE_NAMES: ReadonlySet<string> = new Set(['AuthRetryableFetchError', 'AuthUnknownError', 'AbortError', 'TimeoutError', 'TypeError', 'AuthRefreshDiscardedError', 'AuthInvalidTokenResponseError']);

export function classifyProviderFailure(err: unknown): ProviderVerdict {
  if (!err || typeof err !== 'object') return 'unavailable';
  const e = err as { name?: unknown; status?: unknown; code?: unknown };
  const name = typeof e.name === 'string' ? e.name : ''; const code = typeof e.code === 'string' ? e.code : '';
  const status = typeof e.status === 'number' ? e.status : null;
  // AVAILABILITY FIRST: a network failure, a timeout, a rate limit or a server-side error is never a verdict about the credential, whatever name or code
  // the error carries (an `AuthSessionMissingError` that arrives with a 503 is an outage, not "no session").
  if (UNAVAILABLE_NAMES.has(name)) return 'unavailable';
  if (status !== null && (status === 0 || status === 429 || status >= 500)) return 'unavailable';
  if (name === 'AuthSessionMissingError') return 'session_missing';
  // Only EXPLICIT verdicts about the credential count as revocation. An unknown code, a missing code or any other 4xx is NOT a verdict: it stays unavailable (retryable).
  if (name === 'AuthInvalidJwtError') return 'revoked';
  if (code && DENIED_CODES.has(code)) return 'revoked';
  return 'unavailable';
}

interface ClaimsPayload { readonly sub?: unknown; readonly session_id?: unknown; readonly aal?: unknown; readonly exp?: unknown }
/** From `auth.getClaims()`. `{ data: null, error: null }` is how the client reports "no session in the cookies". */
export function claimsResultFromProvider(res: { data: { claims?: ClaimsPayload | null } | null; error: unknown } | null | undefined): ClaimsResult {
  if (!res || typeof res !== 'object') return { ok: false, reason: 'unavailable' };
  const claims = res.data?.claims;
  if (claims && !res.error) {
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return { ok: false, reason: 'unavailable' };
    const aal: Aal = claims.aal === 'aal2' ? 'aal2' : 'aal1';
    return { ok: true, claims: { userId: claims.sub, sessionId: typeof claims.session_id === 'string' ? claims.session_id : null, aal, expiresAt: claims.exp } };
  }
  if (res.error) {
    const v = classifyProviderFailure(res.error);
    if (v === 'unavailable') return { ok: false, reason: 'unavailable' };
    if (v === 'session_missing') return { ok: false, reason: 'no_session' };
    const msg = typeof (res.error as { message?: unknown }).message === 'string' ? (res.error as { message: string }).message : '';
    return { ok: false, reason: /expired/i.test(msg) ? 'expired' : 'invalid' };
  }
  return { ok: false, reason: 'no_session' };
}

/** From `auth.getUser()` (asks the Auth server). Both fields empty is NOT a verdict: it is treated as unavailable. */
export function serverResultFromProvider(res: { data: { user?: { id?: unknown } | null } | null; error: unknown } | null | undefined): ServerResult {
  if (!res || typeof res !== 'object') return { ok: false, reason: 'unavailable' };
  if (res.error) { const v = classifyProviderFailure(res.error); return v === 'unavailable' ? { ok: false, reason: 'unavailable' } : { ok: false, reason: v === 'session_missing' ? 'no_session' : 'revoked' }; }
  const id = res.data?.user?.id;
  return typeof id === 'string' && id.length > 0 ? { ok: true, userId: id } : { ok: false, reason: 'unavailable' };
}
