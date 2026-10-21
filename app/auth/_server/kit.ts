// PX-2b composition root for the auth handlers. Server-only. It wires the pure identity module (trust, redirects, throttling, failures) to the Auth client:
//  * every network call the Auth client makes (sign-in, token exchange, refresh, signing-key retrieval, user check) goes through a BOUNDED fetch;
//  * cookie writes are COLLECTED and applied to the response only when the outcome is a definite one: an outage must never clear a member's cookies;
//  * the application never holds a service-level key and never exposes a Supabase client to the browser.
import 'server-only';
import { NextResponse } from 'next/server';
import { consoleSink, createBoundedFetch, createUserDb, getEnv, readBodyBounded, withRequestContext } from '@/src/platform/server';
import type { RequestContext, ServerEnv, UserDb } from '@/src/platform/server';
import {
  authFailure, claimsResultFromProvider, createMemoryCounterStore, createThrottle, resolveActor, serverResultFromProvider, SETUP_MARKER_COOKIE, setupIsPending, trustedClientIp, verifySetupMarker,
} from '@/src/modules/identity';
import type { AuthFailure, ClaimsResult, MemberTier, Resolution, ServerResult, SessionSource, SetupMarkerStatus, Throttle } from '@/src/modules/identity';

type PendingCookie = { name: string; value: string; options?: Record<string, unknown> };
export interface AuthCtx {
  readonly env: ServerEnv;
  readonly rc: RequestContext;
  readonly request: Request;
  readonly db: UserDb;
  readonly cookies: ReadonlyMap<string, string>;
  readonly pending: PendingCookie[];
  readonly ip: string | null;
  readonly source: SessionSource;
  /** Resolves `tier`, then applies the "set your password first" nudge to T2. */
  resolve(tier: MemberTier): Promise<Resolution | { readonly ok: false; readonly kind: 'setup_required'; readonly status: 403 }>;
  markerStatus(): Promise<SetupMarkerStatus>;
}

function parseCookieHeader(header: string | null): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('='); if (i < 1) continue;
    const name = part.slice(0, i).trim(); let value = part.slice(i + 1).trim();
    try { value = decodeURIComponent(value); } catch { /* keep the raw value */ }
    if (!m.has(name)) m.set(name, value);
  }
  return m;
}
const AUTH_COOKIE = /^sb-.+-auth-token(\.\d+)?$/;
export const hasAuthCookie = (c: ReadonlyMap<string, string>): boolean => [...c.keys()].some((n) => AUTH_COOKIE.test(n));

const strictEnv = (env: ServerEnv) => env.appEnv === 'staging' || env.appEnv === 'production';

// One throttle per process (single instance only: see docs/identity/px2a-identity-module.md, "Storage strategy").
const g = globalThis as unknown as { __hxAuthThrottle?: { secret: string; throttle: Throttle } };
function throttleFor(env: ServerEnv): Throttle | null {
  if (!env.authThrottleSecret) return null;
  if (!g.__hxAuthThrottle || g.__hxAuthThrottle.secret !== env.authThrottleSecret) g.__hxAuthThrottle = { secret: env.authThrottleSecret, throttle: createThrottle({ secret: env.authThrottleSecret, store: createMemoryCounterStore() }) };
  return g.__hxAuthThrottle.throttle;
}

export function buildCtx(env: ServerEnv, rc: RequestContext, request: Request): AuthCtx {
  const cookies = parseCookieHeader(request.headers.get('cookie'));
  const pending: PendingCookie[] = [];
  const db = createUserDb(env, { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: (list) => { pending.push(...list); } }, { fetch: createBoundedFetch() });
  let claims: Promise<ClaimsResult> | null = null;
  const source: SessionSource = {
    claims: () => (claims ??= (async (): Promise<ClaimsResult> => {
      if (!hasAuthCookie(cookies)) return { ok: false, reason: 'no_session' };       // nothing to verify: no network call at all
      try { return claimsResultFromProvider(await db.client.auth.getClaims()); } catch { return { ok: false, reason: 'unavailable' }; }
    })()),
    serverVerify: async (): Promise<ServerResult> => { try { return serverResultFromProvider(await db.client.auth.getUser()); } catch { return { ok: false, reason: 'unavailable' }; } },
  };
  const markerStatus = async (): Promise<SetupMarkerStatus> => {
    const markerKey = env.authSetupMarkerSecret; if (!markerKey) return 'absent';
    const c = await source.claims(); if (!c.ok) return 'absent';
    return verifySetupMarker(markerKey, cookies.get(SETUP_MARKER_COOKIE), { userId: c.claims.userId, sessionId: c.claims.sessionId }, Date.now());
  };
  return {
    env, rc, request, db, cookies, pending, ip: trustedClientIp(request.headers, env.trustedClientIp), source, markerStatus,
    async resolve(tier) {
      const r = await resolveActor(source, tier);
      if (tier === 'T2' && r.ok && setupIsPending(await markerStatus())) return { ok: false, kind: 'setup_required', status: 403 }; // UX consistency rule, not authorization
      return r;
    },
  };
}

export function throttleOf(ctx: AuthCtx): Throttle | null { return throttleFor(ctx.env); }

/** Wraps a handler: environment check (fail closed), request id, same-origin check for mutations, safe errors. */
export function authRoute(handler: (request: Request, ctx: AuthCtx) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    let env: ServerEnv;
    try { env = getEnv('web'); } catch { return unavailableJson(); }
    return withRequestContext((req, rc) => handler(req, buildCtx(env, rc, req)), { appOrigin: env.appOrigin, sink: consoleSink })(request);
  };
}

// ---- responses ---------------------------------------------------------------------------------------------------------------------------------------------
const NO_STORE = { 'cache-control': 'no-store' };
export function unavailableJson(): Response {
  const f = authFailure('unavailable');
  return NextResponse.json({ error: { code: f.kind, message: f.message } }, { status: 503, headers: { ...NO_STORE, 'retry-after': '5' } });
}
export function failureJson(f: AuthFailure, retryAfterSec?: number): NextResponse {
  return NextResponse.json({ error: { code: f.kind, message: f.message }, ...(retryAfterSec ? { retryAfterSec } : {}) }, { status: f.status, headers: { ...NO_STORE, ...(retryAfterSec ? { 'retry-after': String(retryAfterSec) } : f.status === 503 ? { 'retry-after': '5' } : {}) } });
}

/** Applies the collected cookie writes to a response. Call this ONLY for a definite outcome: never after an outage. */
export function applyCookies(ctx: AuthCtx, res: NextResponse): NextResponse {
  for (const c of ctx.pending) res.cookies.set(c.name, c.value, c.options as never);
  return res;
}
export function setMarkerCookie(ctx: AuthCtx, res: NextResponse, value: string | null): NextResponse {
  if (value) res.cookies.set(SETUP_MARKER_COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: strictEnv(ctx.env), path: '/', maxAge: 15 * 60 });
  else res.cookies.set(SETUP_MARKER_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: strictEnv(ctx.env), path: '/', maxAge: 0 });
  return res;
}
/** Expires every session cookie the request carried (sign-out must work even when the provider cannot be reached). */
export function clearAuthCookies(ctx: AuthCtx, res: NextResponse): NextResponse {
  for (const name of ctx.cookies.keys()) if (AUTH_COOKIE.test(name)) res.cookies.set(name, '', { httpOnly: true, sameSite: 'lax', secure: strictEnv(ctx.env), path: '/', maxAge: 0 });
  return res;
}
export function redirectSeeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: path, ...NO_STORE } });
}

// ---- request bodies ----------------------------------------------------------------------------------------------------------------------------------------
export type Fields = { readonly ok: true; readonly fields: Record<string, string> } | { readonly ok: false; readonly status: 400 | 408 | 413 | 415 };
/** Reads named string fields from a small JSON or form body. The 8 KiB limit and a 3 s deadline are enforced WHILE STREAMING (see src/platform/http/body.ts). */
export async function readFields(request: Request, names: readonly string[]): Promise<Fields> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded') return { ok: false, status: 415 };   // refused before any body is read
  const body = await readBodyBounded(request);
  if (!body.ok) return { ok: false, status: body.status };
  const out: Record<string, string> = {};
  try {
    if (type === 'application/json') { const j = JSON.parse(body.text); if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, status: 400 }; for (const n of names) { const v = (j as Record<string, unknown>)[n]; if (typeof v === 'string') out[n] = v; } }
    else { const p = new URLSearchParams(body.text); for (const n of names) { const v = p.get(n); if (v !== null) out[n] = v; } }
  } catch { return { ok: false, status: 400 }; }
  return { ok: true, fields: out };
}
const BODY_MESSAGE: Record<number, { code: string; message: string }> = {
  413: { code: 'payload_too_large', message: 'That request is too large.' },
  408: { code: 'request_timeout', message: 'The request took too long. Please try again.' },
  415: { code: 'unsupported_media_type', message: 'That request was not understood.' },
  400: { code: 'validation_failed', message: 'That request was not understood.' },
};
export function bodyProblemJson(status: 400 | 408 | 413 | 415): NextResponse {
  return NextResponse.json({ error: BODY_MESSAGE[status] }, { status, headers: { ...NO_STORE, ...(status === 408 || status === 413 ? { connection: 'close' } : {}) } });
}
export const bodyProblemMessage = (status: 400 | 408 | 413 | 415): string => BODY_MESSAGE[status].message;

export const wantsForm = (request: Request): boolean => (request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded');

import { runThrottled } from '@/src/modules/identity';
import type { AuthAction } from '@/src/modules/identity';
/** The throttle ALWAYS runs before the provider call. `null` means the throttle is not configured, which is treated as unavailable (fail closed). */
export async function throttled<T>(ctx: AuthCtx, action: AuthAction, email: string | undefined, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; kind: 'rate_limited'; retryAfterSec: number } | { ok: false; kind: 'unavailable' }> {
  const t = throttleOf(ctx); if (!t) return { ok: false, kind: 'unavailable' };
  return runThrottled(t, action, { ip: ctx.ip, ...(email !== undefined ? { email } : {}) }, fn);
}

/** `session_id` from an access token the provider has just issued to us (not an untrusted input, and not used for any decision about trust). */
export function sessionIdOf(accessToken: string | undefined): string | null {
  try { const p = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString('utf8')); return typeof p.session_id === 'string' ? p.session_id : null; } catch { return null; }
}
