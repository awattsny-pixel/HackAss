// What the member is told when Auth fails. One small, stable set of kinds with fixed wording, so the response never reveals whether an email
// belongs to a member (unknown email, wrong password, banned and unconfirmed all read the same) and never carries provider text, codes or internals.
export type AuthFailureKind = 'invalid_credentials' | 'link_invalid_or_expired' | 'weak_password' | 'rate_limited' | 'unauthenticated' | 'unavailable';
export interface AuthFailure { readonly kind: AuthFailureKind; readonly status: number; readonly message: string }
export interface ProviderError { readonly code?: unknown; readonly status?: unknown }

const FAILURES: Record<AuthFailureKind, AuthFailure> = {
  invalid_credentials: { kind: 'invalid_credentials', status: 401, message: 'The email or password is not correct.' },
  link_invalid_or_expired: { kind: 'link_invalid_or_expired', status: 400, message: 'This link has expired or has already been used.' },
  weak_password: { kind: 'weak_password', status: 400, message: 'Choose a password of at least 12 characters.' },
  rate_limited: { kind: 'rate_limited', status: 429, message: 'Too many attempts. Please wait a few minutes and try again.' },
  unauthenticated: { kind: 'unauthenticated', status: 401, message: 'Please sign in again.' },
  unavailable: { kind: 'unavailable', status: 503, message: 'This is temporarily unavailable. Please try again in a moment.' },
};
export const authFailure = (kind: AuthFailureKind): AuthFailure => FAILURES[kind];

const BY_CODE: Readonly<Record<string, AuthFailureKind>> = {
  invalid_credentials: 'invalid_credentials', email_not_confirmed: 'invalid_credentials', user_not_found: 'invalid_credentials', user_banned: 'invalid_credentials',
  signup_disabled: 'invalid_credentials', email_address_invalid: 'invalid_credentials',
  otp_expired: 'link_invalid_or_expired', otp_disabled: 'link_invalid_or_expired', flow_state_not_found: 'link_invalid_or_expired', flow_state_expired: 'link_invalid_or_expired', bad_code_verifier: 'link_invalid_or_expired',
  weak_password: 'weak_password',
  over_request_rate_limit: 'rate_limited', over_email_send_rate_limit: 'rate_limited', over_sms_send_rate_limit: 'rate_limited',
  session_not_found: 'unauthenticated', session_expired: 'unauthenticated', refresh_token_not_found: 'unauthenticated', refresh_token_already_used: 'unauthenticated',
};

/** Precedence: server failure (5xx) > rate limit (429) > known code > everything else. Unknown or missing information is 'unavailable': no guess is ever made about the member's input. */
export function mapAuthError(err: ProviderError | null | undefined): AuthFailure {
  const code = typeof err?.code === 'string' ? err.code : null;
  const status = typeof err?.status === 'number' ? err.status : null;
  // The HTTP status is the more reliable signal: a server failure is never a statement about the member's input, whatever code came with it.
  if (status !== null && status >= 500) return FAILURES.unavailable;
  if (status === 429) return FAILURES.rate_limited;
  if (code && BY_CODE[code]) return FAILURES[BY_CODE[code]];
  return FAILURES.unavailable;
}

/** The answer to "send me a recovery link", identical whether or not the email belongs to a member. */
export const RECOVERY_REQUEST_RESPONSE = Object.freeze({ status: 202, message: 'If that email belongs to an invited member, we have sent a link to it.' } as const);
