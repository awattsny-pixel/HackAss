// Typed actors and the access tiers from the foundation design. Interfaces and pure helpers only: nothing here
// authenticates anyone. The resolver that produces actors (Supabase Auth, F3) is deliberately not implemented yet.
import { z } from 'zod';

export type StaffRole = 'reviewer' | 'admin';
export type Aal = 'aal1' | 'aal2';
/** How the session behind an actor was verified. Signature checks do not detect revocation; the server does. */
export type Verification = 'claims' | 'server';
export type Tier = 'T0' | 'T1' | 'T2' | 'T3';
export type WorkerCapability = 'job-runner' | 'cache-invalidation';

export type UserId = string & { readonly __brand: 'UserId' };
const userIdSchema = z.uuid();
export function parseUserId(value: unknown): UserId {
  return userIdSchema.parse(value) as UserId;
}

export interface AnonymousActor { readonly kind: 'anonymous' }
export interface MemberActor { readonly kind: 'member'; readonly userId: UserId; readonly aal: Aal; readonly verification: Verification }
export interface StaffActor {
  readonly kind: 'staff';
  readonly userId: UserId;
  readonly roles: readonly StaffRole[];
  readonly aal: Aal;
  readonly verification: Verification;
  /** When the most recent MFA factor was verified (from the token's amr entries), if known. */
  readonly mfaVerifiedAt: Date | null;
}
export interface WorkerActor { readonly kind: 'worker'; readonly capability: WorkerCapability }
export type Actor = AnonymousActor | MemberActor | StaffActor | WorkerActor;

export const ANONYMOUS: AnonymousActor = Object.freeze({ kind: 'anonymous' });

/** Resolves the caller. The real implementation (F3) must verify the session as the tier requires. */
export interface ActorResolver {
  resolve(request: Request, minTier: Tier): Promise<Actor>;
}

export const isMember = (a: Actor): a is MemberActor => a.kind === 'member';
export const isStaff = (a: Actor): a is StaffActor => a.kind === 'staff';

/**
 * Whether an already-resolved actor satisfies a tier on the application side. This is defence in depth: consequential
 * operations are ALSO authorized inside the database (a web-handler check cannot protect a function that can be
 * called directly with a JWT).
 *   T0 anyone · T1 member/staff with verified claims · T2 member/staff verified by the Auth server ·
 *   T3 staff, server-verified, aal2, with a fresh MFA timestamp.
 */
export function satisfiesTier(actor: Actor, tier: Tier, opts: { now?: Date; stepUpWindowMs?: number } = {}): boolean {
  switch (tier) {
    case 'T0': return true;
    case 'T1': return actor.kind === 'member' || actor.kind === 'staff';
    case 'T2': return (actor.kind === 'member' || actor.kind === 'staff') && actor.verification === 'server';
    case 'T3': {
      if (actor.kind !== 'staff' || actor.verification !== 'server' || actor.aal !== 'aal2' || actor.roles.length === 0) return false;
      const now = (opts.now ?? new Date()).getTime();
      const window = opts.stepUpWindowMs ?? 15 * 60 * 1000;
      return actor.mfaVerifiedAt !== null && now - actor.mfaVerifiedAt.getTime() <= window && actor.mfaVerifiedAt.getTime() <= now + 60_000;
    }
  }
}

export type RequestId = string & { readonly __brand: 'RequestId' };

/** What every module service function receives. `db` is supplied by the composition root; modules never build clients. */
export interface ModuleContext<A extends Actor = Actor, Db = unknown> {
  readonly actor: A;
  readonly requestId: RequestId;
  readonly db: Db;
}
