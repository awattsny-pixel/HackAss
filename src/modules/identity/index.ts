// Module boundary: other code may import only this file (see docs/adr/0001-foundation.md).
// PX-2a: the identity module's trust, redirect, password, error and throttling rules. It holds no Auth client, no cookie access and no
// environment access: the composition root (PX-2b, held) supplies a SessionSource and a counter store. There is deliberately NO sign-up
// capability here: the pilot is invite-only (see docs/identity/px2b-email-flows-spec.md).
export const MODULE_NAME = 'identity' as const;
export { authorize, OPERATION_TIER, resolveActor, tierFor } from './resolver.ts';
export type { ClaimsResult, MemberTier, Operation, ResolveOptions, Resolution, ServerResult, SessionSource, VerifiedClaims } from './resolver.ts';
export { DEFAULT_RETURN_PREFIXES, safeReturnPath } from './redirect.ts';
export { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH, passwordIssuesMessage, validatePassword } from './password.ts';
export type { PasswordIssue, PasswordResult } from './password.ts';
export { authFailure, mapAuthError, RECOVERY_REQUEST_RESPONSE } from './errors.ts';
export type { AuthFailure, AuthFailureKind, ProviderError } from './errors.ts';
export { classifyProviderFailure, claimsResultFromProvider, serverResultFromProvider } from './provider.ts';
export type { ProviderVerdict } from './provider.ts';
export { SETUP_MARKER_COOKIE, SETUP_MARKER_TTL_MS, setupIsPending, signSetupMarker, verifySetupMarker } from './setup-marker.ts';
export type { SetupBinding, SetupMarkerStatus } from './setup-marker.ts';
export { parseAuthCallback } from './callback.ts';
export type { CallbackParse, CallbackType } from './callback.ts';
export { CounterCapacityError, createMemoryCounterStore, createThrottle, DEFAULT_RULES, keyedHash, normalizeEmail, normalizeIp, runThrottled, trustedClientIp } from './throttle.ts';
export type { ActionRules, AuthAction, ClientIpPolicy, CounterStore, Rule, Throttle, ThrottleConfig, ThrottleContext, ThrottleDecision } from './throttle.ts';
