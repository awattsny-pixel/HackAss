// Write throttle for saved work (PX-3b). Applied to every POST/PUT/DELETE AFTER the member is verified at T2 and BEFORE the body is read or the database is called.
// It reuses the identity module's building blocks (keyed hashes, bounded counter store, fail-closed rules) with its own limits. Same honest limits as the auth
// throttle: counters live in this process (single instance only), and a full or failing store DENIES. Keys are keyed hashes, never ids or addresses.
// PROVISIONAL starting values, to be tuned with real traffic. A member's own editing never comes near them; they exist to stop a script.
import { CounterCapacityError, createMemoryCounterStore, keyedHash } from '../../../src/modules/identity/index.ts';
import type { CounterStore } from '../../../src/modules/identity/index.ts';

export interface WriteRule { readonly max: number; readonly windowMs: number }
const MIN = 60_000;
export const WRITE_RULES = Object.freeze({
  member: { max: 60, windowMs: 5 * MIN },     // one member
  ip: { max: 150, windowMs: 5 * MIN },        // one client address (or the shared bucket when no trusted address is configured: never looser)
  global: { max: 2000, windowMs: 5 * MIN },   // the whole process
} as const);

export type WriteDecision = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSec: number };
export interface WriteThrottle { check(who: { readonly userId: string; readonly ip: string | null }): Promise<WriteDecision> }

export function createWriteThrottle(cfg: { secret: string; store: CounterStore; now?: () => number; rules?: typeof WRITE_RULES }): WriteThrottle {
  const now = cfg.now ?? Date.now, rules = cfg.rules ?? WRITE_RULES;
  keyedHash(cfg.secret, 'work-self-test', 'x'); // fail at construction, not at the first request
  return {
    async check({ userId, ip }) {
      const t = now();
      const probes = [
        { key: 'work|g', rule: rules.global },
        { key: `work|ip|${ip ? keyedHash(cfg.secret, 'work-ip', ip) : 'unknown'}`, rule: rules.ip },
        { key: `work|member|${keyedHash(cfg.secret, 'work-member', userId)}`, rule: rules.member },
      ];
      let retry = 0;
      try {
        for (const p of probes) { // every probe is counted, so tripping one scope never lets another go uncounted
          const { count, resetAtMs } = await cfg.store.hit(p.key, p.rule.windowMs, t);
          if (count > p.rule.max) retry = Math.max(retry, Math.max(1, Math.ceil((resetAtMs - t) / 1000)));
        }
      } catch (e) { return { allowed: false, retryAfterSec: e instanceof CounterCapacityError ? Math.max(1, Math.ceil(e.retryAfterMs / 1000)) : 30 }; } // fail closed, always
      return retry ? { allowed: false, retryAfterSec: retry } : { allowed: true };
    },
  };
}

const g = globalThis as unknown as { __hxWorkThrottle?: { secret: string; throttle: WriteThrottle } };
/** One throttle per process. `null` when no secret is configured: the caller treats that as unavailable (fail closed). */
export function writeThrottleFor(secret: string | null | undefined): WriteThrottle | null {
  if (!secret) return null;
  if (!g.__hxWorkThrottle || g.__hxWorkThrottle.secret !== secret) g.__hxWorkThrottle = { secret, throttle: createWriteThrottle({ secret, store: createMemoryCounterStore() }) };
  return g.__hxWorkThrottle.throttle;
}
