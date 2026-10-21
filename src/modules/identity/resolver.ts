// Resolves "who is this request, and how sure are we?" from an injected session source. No Auth client, cookie or environment access here:
// the composition root (PX-2b) supplies a SessionSource. Trust levels follow the foundation's tiers (src/platform/actor.ts):
//   T0 anyone (signed-in members are still recognised, never required) · T1 member whose access-token CLAIMS verify (signature and expiry only) ·
//   T2 member whose session the AUTH SERVER confirmed just now.
// Rules that must never be weakened:
//   * T1 is a provisional signed-in indicator only. It accepts a token revoked by sign-out for up to the token lifetime.
//   * Reading or writing a member's saved data is T2 (plus the database's own account and session guard, invariant I-3).
//   * A T2 operation is NEVER served at T1 level: if the Auth server cannot confirm (outage, timeout, error, malformed answer), the result is
//     `auth_unavailable` (503, retryable), not a downgrade.
import { z } from 'zod';
import type { Aal, AnonymousActor, MemberActor, UserId } from '@/src/platform'; // types only: erased at runtime, so this file also runs under the plain Node test runner

const ANONYMOUS: AnonymousActor = Object.freeze({ kind: 'anonymous' });
const userIdSchema = z.uuid();
const parseUserId = (v: unknown): UserId => userIdSchema.parse(v) as UserId;

export type MemberTier = 'T0' | 'T1' | 'T2';

export interface VerifiedClaims { readonly userId: string; readonly sessionId: string | null; readonly aal: Aal; /** seconds since the epoch */ readonly expiresAt: number }
/** `no_session`, `expired`, `invalid` are DEFINITE verdicts about the credential. `unavailable` means the verification itself could not be done (for example the signing keys could not be fetched): not a verdict about the member. */
export type ClaimsResult = { readonly ok: true; readonly claims: VerifiedClaims } | { readonly ok: false; readonly reason: 'no_session' | 'expired' | 'invalid' | 'unavailable' };
export type ServerResult = { readonly ok: true; readonly userId: string } | { readonly ok: false; readonly reason: 'no_session' | 'revoked' | 'unavailable' };

/** What the composition root provides for one request. `claims` checks the signature and expiry locally; `serverVerify` asks the Auth server. */
export interface SessionSource {
  claims(): ClaimsResult | Promise<ClaimsResult>;
  serverVerify(): Promise<ServerResult>;
}

export type Resolution =
  | { readonly ok: true; readonly actor: AnonymousActor | MemberActor }
  | { readonly ok: false; readonly kind: 'unauthenticated'; readonly status: 401 }
  | { readonly ok: false; readonly kind: 'auth_unavailable'; readonly status: 503; readonly retryable: true };

export interface ResolveOptions { readonly now?: () => number; readonly serverTimeoutMs?: number }
const DEFAULT_SERVER_TIMEOUT_MS = 3000;

const UNAUTHENTICATED: Resolution = Object.freeze({ ok: false, kind: 'unauthenticated', status: 401 });
const UNAVAILABLE: Resolution = Object.freeze({ ok: false, kind: 'auth_unavailable', status: 503, retryable: true });

/** The operations the experience will perform, and the tier each requires. Reading private data is NOT a lighter operation than writing it. */
export const OPERATION_TIER = Object.freeze({
  'public-read': 'T0',
  'show-signed-in-indicator': 'T1',
  'read-private': 'T2',
  'write-private': 'T2',
  'change-account': 'T2',
} as const satisfies Record<string, MemberTier>);
export type Operation = keyof typeof OPERATION_TIER;
export const tierFor = (op: Operation): MemberTier => OPERATION_TIER[op];

type ClaimsRead = { readonly kind: 'ok'; readonly claims: VerifiedClaims } | { readonly kind: 'none' } | { readonly kind: 'unavailable' };
/**
 * `none` only for a DEFINITE verdict (no session, expired, invalid credential). Anything we cannot interpret (the source throws, answers with
 * something malformed, reports `unavailable`) is `unavailable`: a broken verification service must not look like a bad credential.
 */
async function readClaims(source: SessionSource, nowMs: number): Promise<ClaimsRead> {
  let r: ClaimsResult;
  try { r = await source.claims(); } catch { return { kind: 'unavailable' }; }
  if (!r || typeof r !== 'object') return { kind: 'unavailable' };
  if (r.ok === false) return r.reason === 'no_session' || r.reason === 'expired' || r.reason === 'invalid' ? { kind: 'none' } : { kind: 'unavailable' };
  if (r.ok !== true) return { kind: 'unavailable' };
  const c = r.claims;
  if (!c || typeof c.userId !== 'string' || typeof c.expiresAt !== 'number' || !Number.isFinite(c.expiresAt) || (c.aal !== 'aal1' && c.aal !== 'aal2') || !userIdSchema.safeParse(c.userId).success) return { kind: 'unavailable' };
  if (c.expiresAt * 1000 <= nowMs) return { kind: 'none' }; // expired, whatever the source said: a definite verdict
  return { kind: 'ok', claims: c };
}

type Confirmed = 'confirmed' | 'denied' | 'unavailable';
async function askAuthServer(source: SessionSource, userId: string, timeoutMs: number): Promise<Confirmed> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), timeoutMs); });
    const r = await Promise.race([source.serverVerify(), timeout]);
    if (r === 'timeout' || !r || typeof r !== 'object') return 'unavailable';
    if (r.ok === true) {
      if (typeof r.userId !== 'string' || r.userId.length === 0) return 'unavailable'; // a "success" we cannot read is not a verdict
      return r.userId === userId ? 'confirmed' : 'denied';     // a different, readable user is a definite refusal
    }
    if (r.reason === 'no_session' || r.reason === 'revoked') return 'denied';
    return 'unavailable'; // 'unavailable' or any unknown reason: not a verdict about the session
  } catch { return 'unavailable'; } finally { if (timer) clearTimeout(timer); }
}

export async function resolveActor(source: SessionSource, tier: MemberTier, opts: ResolveOptions = {}): Promise<Resolution> {
  const nowMs = (opts.now ?? Date.now)();
  const read = await readClaims(source, nowMs);
  const member = (claims: VerifiedClaims, verification: 'claims' | 'server'): MemberActor => Object.freeze({ kind: 'member', userId: parseUserId(claims.userId), aal: claims.aal, verification });

  if (tier === 'T0') return { ok: true, actor: read.kind === 'ok' ? member(read.claims, 'claims') : ANONYMOUS }; // public pages never depend on Auth
  if (read.kind === 'unavailable') return UNAVAILABLE;
  if (read.kind === 'none') return UNAUTHENTICATED;     // a definite "no usable session": no need to ask the server
  if (tier === 'T1') return { ok: true, actor: member(read.claims, 'claims') };

  const verdict = await askAuthServer(source, read.claims.userId, opts.serverTimeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS);
  if (verdict === 'unavailable') return UNAVAILABLE;    // never downgrade to T1
  if (verdict === 'denied') return UNAUTHENTICATED;
  return { ok: true, actor: member(read.claims, 'server') };
}

/** Resolve for a named operation, so call sites say what they do rather than which tier they believe it needs. */
export const authorize = (source: SessionSource, op: Operation, opts?: ResolveOptions): Promise<Resolution> => resolveActor(source, tierFor(op), opts);
