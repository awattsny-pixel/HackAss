// Application-level throttling for the auth actions, with honest limits. READ docs/identity/px2a-identity-module.md ("Throttling") for what this does NOT do.
//  * Why it exists: the Auth provider's per-IP limits see the APPLICATION SERVER's address for every member (our calls are server-to-server), so one abusive
//    client could exhaust the provider's limit for everyone. This throttle rejects abuse BEFORE the provider is called. The provider's forwarded-client-IP
//    mechanism needs the secret key; that key is not part of the application boundary and is deliberately not used here.
//  * Client address: only from a source we trust (a header set by infrastructure we control, or a fixed number of trusted proxy hops). Never from a
//    client-supplied header by default. With no trusted source configured, every request shares ONE bucket per action that is governed by the action's own
//    per-address rule (never a looser one); an optional extra restriction may be added on top, never substituted.
//  * Stored keys are keyed hashes (HMAC) of the address and of the email, never the values themselves; counters are bounded in size and in time.
//  * Storage: the in-memory store is per process. That is correct only for a single running instance. A shared store (the database or a platform KV)
//    is required before more than one instance serves traffic; it is not implemented here (a database table would be a migration, which is held).
//  * Active counters are NEVER evicted to make room (that would reset a limit under pressure). When the store is full, NEW keys are refused and the request is
//    denied; entries are reclaimed only when their window has ended. A store error always FAILS CLOSED (denies); there is no option to allow.
import 'server-only'; // uses Node crypto/net and holds counters: a Client Component importing this module fails the build
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

export type AuthAction = 'sign-in' | 'invite-callback' | 'recovery-request' | 'recovery-callback' | 'set-password';
export interface Rule { readonly max: number; readonly windowMs: number }
/** `ip`: per client address. `pair`: per address AND email (credential guessing). `identifier`: per email across addresses (email bombing); keep it off sign-in, because it lets an attacker lock a member out. `global`: per action. */
export interface ActionRules { readonly ip: Rule; readonly pair?: Rule; readonly identifier?: Rule; readonly global: Rule }
const MIN = 60_000; const HOUR = 60 * MIN;
/** PROVISIONAL starting values, to be tuned with real traffic. */
export const DEFAULT_RULES: Readonly<Record<AuthAction, ActionRules>> = Object.freeze({
  'sign-in':           { ip: { max: 10, windowMs: 5 * MIN }, pair: { max: 5, windowMs: 15 * MIN }, global: { max: 300, windowMs: 5 * MIN } },
  'invite-callback':   { ip: { max: 20, windowMs: 5 * MIN }, global: { max: 300, windowMs: 5 * MIN } },
  'recovery-request':  { ip: { max: 5, windowMs: HOUR }, identifier: { max: 3, windowMs: HOUR }, global: { max: 60, windowMs: HOUR } },
  'recovery-callback': { ip: { max: 20, windowMs: 5 * MIN }, global: { max: 300, windowMs: 5 * MIN } },
  'set-password':      { ip: { max: 10, windowMs: 5 * MIN }, global: { max: 200, windowMs: 5 * MIN } },
});

// ---- trusted client address ----------------------------------------------------------------------------------------------------------------------------
export type ClientIpPolicy =
  | { readonly kind: 'none' }                                           // no trusted source: the address is unknown
  | { readonly kind: 'header'; readonly name: string }                  // a header set (overwritten) by infrastructure we control
  | { readonly kind: 'forwarded-for'; readonly trustedHops: number };   // X-Forwarded-For with exactly N proxies we control appending to the right

function expandV6(addr: string): string[] | null {
  let a = addr.toLowerCase();
  const zone = a.indexOf('%'); if (zone !== -1) a = a.slice(0, zone);
  const v4 = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) { const p = v4[1].split('.').map(Number); a = a.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16); }
  const halves = a.split('::'); if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : []; const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length; if ((halves.length === 1 && fill !== 0) || fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  return groups.length === 8 ? groups.map((g) => g.padStart(4, '0')) : null;
}
/** A comparable key for an address: IPv4 as-is (also when IPv4-mapped); IPv6 reduced to its /64 so one subscriber cannot rotate through addresses. */
export function normalizeIp(raw: string): string | null {
  const s = raw.trim();
  const kind = isIP(s);
  if (kind === 4) return s;
  if (kind !== 6) return null;
  const g = expandV6(s); if (!g) return null;
  if (g.slice(0, 5).every((x) => x === '0000') && g[5] === 'ffff') return `${parseInt(g[6].slice(0, 2), 16)}.${parseInt(g[6].slice(2), 16)}.${parseInt(g[7].slice(0, 2), 16)}.${parseInt(g[7].slice(2), 16)}`;
  return g.slice(0, 4).join(':') + '::/64';
}
export function trustedClientIp(headers: { get(name: string): string | null }, policy: ClientIpPolicy): string | null {
  switch (policy.kind) {
    case 'none': return null;
    case 'header': { const v = headers.get(policy.name); return v ? normalizeIp(v) : null; }
    case 'forwarded-for': {
      if (!Number.isInteger(policy.trustedHops) || policy.trustedHops < 1) return null;
      const v = headers.get('x-forwarded-for'); if (!v) return null;
      const parts = v.split(',').map((x) => x.trim());
      if (parts.length < policy.trustedHops) return null;           // fewer hops than we trust: the header is not what we configured for
      return normalizeIp(parts[parts.length - policy.trustedHops]); // counted from the right: the left side is client-controlled
    }
  }
}

// ---- keyed hashes --------------------------------------------------------------------------------------------------------------------------------------
const MIN_SECRET_LENGTH = 32;
export function keyedHash(secret: string, purpose: string, value: string): string {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) throw new Error('throttle secret must be at least 32 characters');
  return createHmac('sha256', secret).update(`${purpose}\0${value.slice(0, 320)}`).digest('hex').slice(0, 32);
}
export const normalizeEmail = (email: string): string => email.normalize('NFKC').trim().toLowerCase();

// ---- counters ------------------------------------------------------------------------------------------------------------------------------------------
export interface CounterStore { hit(key: string, windowMs: number, nowMs: number): Promise<{ count: number; resetAtMs: number }> }

/** Raised when a NEW counter cannot be created because the store is full of active counters. The throttle turns it into a denial. */
export class CounterCapacityError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) { super('counter store is full'); this.name = 'CounterCapacityError'; this.retryAfterMs = retryAfterMs; }
}

/**
 * Fixed-window counters in memory, bounded to `maxKeys` entries. Only EXPIRED entries are ever dropped. If a new key is needed while every entry is
 * still active, the new key is refused (CounterCapacityError): existing counters, including the global one, keep counting. Single-instance only.
 * Trade-off, stated plainly: an attacker with many distinct addresses can fill the store and make new keys (new addresses) fail until windows end, which
 * denies service rather than letting limits be bypassed.
 */
export function createMemoryCounterStore(opts: { maxKeys?: number } = {}): CounterStore & { readonly size: number } {
  const maxKeys = opts.maxKeys ?? 10_000;
  const m = new Map<string, { count: number; resetAtMs: number }>();
  return {
    get size() { return m.size; },
    async hit(key, windowMs, nowMs) {
      let e = m.get(key);
      if (e && e.resetAtMs <= nowMs) { m.delete(key); e = undefined; }
      if (!e) {
        if (m.size >= maxKeys) {
          let earliest = Infinity;
          for (const [k, v] of m) { if (v.resetAtMs <= nowMs) m.delete(k); else if (v.resetAtMs < earliest) earliest = v.resetAtMs; }
          if (m.size >= maxKeys) throw new CounterCapacityError(Math.max(1000, earliest - nowMs));
        }
        e = { count: 0, resetAtMs: nowMs + windowMs }; m.set(key, e);
      }
      e.count += 1;
      return { count: e.count, resetAtMs: e.resetAtMs };
    },
  };
}

export interface ThrottleConfig {
  readonly secret: string;
  readonly store: CounterStore;
  readonly rules?: Readonly<Record<AuthAction, ActionRules>>;
  /** OPTIONAL extra restriction for requests with no trusted address. It is applied IN ADDITION to the action's own per-address rule, which always applies to the shared unknown bucket. */
  readonly unknownIpExtra?: Rule;
  readonly now?: () => number;
}
export type ThrottleDecision = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSec: number; readonly scope: 'ip' | 'pair' | 'identifier' | 'global' | 'store' };
export interface ThrottleContext { /** from trustedClientIp(); null when no trusted source is configured or it was malformed */ readonly ip: string | null; /** the email being acted on, when there is one */ readonly email?: string }

export function createThrottle(cfg: ThrottleConfig) {
  const rules = cfg.rules ?? DEFAULT_RULES; const now = cfg.now ?? Date.now;
  keyedHash(cfg.secret, 'self-test', 'x'); // fail at construction, not at the first request
  async function check(action: AuthAction, ctx: ThrottleContext): Promise<ThrottleDecision> {
    const r = rules[action]; const t = now();
    const ipKey = ctx.ip ? keyedHash(cfg.secret, 'ip', ctx.ip) : null;
    const emailKey = ctx.email !== undefined ? keyedHash(cfg.secret, 'email', normalizeEmail(ctx.email)) : null;
    const probes: { scope: 'ip' | 'pair' | 'identifier' | 'global'; key: string; rule: Rule }[] = [{ scope: 'global', key: `${action}|g`, rule: r.global }];
    // No trusted address: all such requests share one bucket governed by the action's own per-address rule (never a looser one), plus any extra restriction.
    probes.push({ scope: 'ip', key: ipKey ? `${action}|ip|${ipKey}` : `${action}|ip|unknown`, rule: r.ip });
    if (!ipKey && cfg.unknownIpExtra) probes.push({ scope: 'ip', key: `${action}|ip|unknown-extra`, rule: cfg.unknownIpExtra });
    if (r.pair && emailKey) probes.push({ scope: 'pair', key: `${action}|pair|${ipKey ?? 'unknown'}|${emailKey}`, rule: r.pair });
    if (r.identifier && emailKey) probes.push({ scope: 'identifier', key: `${action}|id|${emailKey}`, rule: r.identifier });
    let worst: ThrottleDecision = { allowed: true };
    try {
      for (const p of probes) {
        const { count, resetAtMs } = await cfg.store.hit(p.key, p.rule.windowMs, t); // every probe is counted, so no scope can be skipped by tripping another
        if (count > p.rule.max) {
          const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - t) / 1000));
          if (worst.allowed || retryAfterSec > worst.retryAfterSec) worst = { allowed: false, retryAfterSec, scope: p.scope };
        }
      }
    } catch (e) {
      // Fail closed, always: a store we cannot trust must not become a way around the limits.
      return { allowed: false, retryAfterSec: e instanceof CounterCapacityError ? Math.max(1, Math.ceil(e.retryAfterMs / 1000)) : 30, scope: 'store' };
    }
    return worst;
  }
  return { check };
}
export type Throttle = ReturnType<typeof createThrottle>;

/** Runs `fn` (the call to the Auth provider) only if the throttle allows it: the throttle always comes FIRST. */
export async function runThrottled<T>(throttle: Throttle, action: AuthAction, ctx: ThrottleContext, fn: () => Promise<T>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly kind: 'rate_limited'; readonly retryAfterSec: number }> {
  const d = await throttle.check(action, ctx);
  if (!d.allowed) return { ok: false, kind: 'rate_limited', retryAfterSec: d.retryAfterSec };
  return { ok: true, value: await fn() };
}
