// Validates the parameters of an emailed link BEFORE anything is exchanged. Parsing is pure and consumes nothing: the one-time token is only
// exchanged by a later, same-origin POST (docs/identity/px2b-email-flows-spec.md). Public registration is unavailable in the pilot, so a
// `signup` or `magiclink` link is refused outright.
import { safeReturnPath } from './redirect.ts';

export type CallbackType = 'invite' | 'recovery' | 'email_change';
const ALLOWED: ReadonlySet<string> = new Set<CallbackType>(['invite', 'recovery', 'email_change']);
const TOKEN_HASH = /^[A-Za-z0-9_-]{20,128}$/;

export type CallbackParse =
  | { readonly ok: true; readonly type: CallbackType; readonly tokenHash: string; readonly next: string }
  | { readonly ok: false; readonly reason: 'missing' | 'malformed' | 'unsupported_type' | 'signup_unavailable' | 'link_invalid_or_expired' };

export function parseAuthCallback(params: { get(name: string): string | null }): CallbackParse {
  if (params.get('error') || params.get('error_code')) return { ok: false, reason: 'link_invalid_or_expired' }; // the provider already refused the link
  const type = params.get('type'); const token = params.get('token_hash');
  if (!type || !token) return { ok: false, reason: 'missing' };
  if (type === 'signup' || type === 'magiclink') return { ok: false, reason: 'signup_unavailable' };
  if (!ALLOWED.has(type)) return { ok: false, reason: 'unsupported_type' };
  if (!TOKEN_HASH.test(token)) return { ok: false, reason: 'malformed' };
  // After an invitation or recovery the member must set a password first; the requested destination is only used afterwards.
  return { ok: true, type: type as CallbackType, tokenHash: token, next: safeReturnPath(params.get('next')) };
}
