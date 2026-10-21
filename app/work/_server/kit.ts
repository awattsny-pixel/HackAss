// PX-3b composition root for the saved-work handlers. Server-only. Every route here:
//   1. is wrapped like the auth handlers (environment check that fails closed, request id, same-origin check on every mutation, no-store, safe errors);
//   2. verifies the member at T2 (the Auth server confirms the session just now) for EVERY private read AND write, with the "set your password first" nudge;
//      an Auth outage is a retryable 503 that touches no cookie and never falls back to the provisional T1 answer;
//   3. throttles writes, then reads a BOUNDED body (limit enforced while streaming, deadline), then validates it with the strict `mywork` schemas;
//   4. calls the database ONLY through the member's own cookie client (no service key exists in this application), where the guard re-checks the session
//      and account and the owner is derived from the session: there is no owner parameter anywhere on this path;
//   5. answers with uniform errors and logs the operation name and outcome kind only: never a body, id, title, prompt text, cookie or token.
import 'server-only';
import { NextResponse } from 'next/server';
import { consoleSink, getEnv, readBodyBounded, withRequestContext } from '@/src/platform/server';
import type { ServerEnv } from '@/src/platform/server';
import { authFailure } from '@/src/modules/identity';
import { failureResponse } from '@/src/modules/mywork';
import type { WorkFailure, WorkResult, WorkRpc } from '@/src/modules/mywork';
import { applyCookies, bodyProblemJson, buildCtx, unavailableJson } from '../../auth/_server/kit';
import type { AuthCtx } from '../../auth/_server/kit';
import { writeThrottleFor } from './throttle';

const NO_STORE = { 'cache-control': 'no-store' };
export type WorkOp = 'list_prompts' | 'create_prompt' | 'get_prompt' | 'update_prompt' | 'delete_prompt' | 'save_result' | 'save_both' | 'list_results' | 'get_result' | 'update_result' | 'delete_result' | 'export';

/** Wraps a handler. `params` are the dynamic route segments (an id is validated by the module: a malformed id is a plain not_found). */
export function workRoute<P extends Record<string, string> = Record<string, never>>(handler: (request: Request, ctx: AuthCtx, params: P) => Promise<Response>) {
  return async (request: Request, context?: { params: Promise<P> }): Promise<Response> => {
    let env: ServerEnv;
    try { env = getEnv('web'); } catch { return unavailableJson(); }
    return withRequestContext(async (req, rc) => handler(req, buildCtx(env, rc, req), (await context?.params ?? {}) as P), { appOrigin: env.appOrigin, sink: consoleSink })(request);
  };
}

/** The member's database handle: it can call the eleven `api` member functions and nothing else. */
export const workDb = (ctx: AuthCtx): WorkRpc => ({ rpc: (fn, args) => ctx.db.client.schema('api').rpc(fn, args) });

// ---- member gate -----------------------------------------------------------------------------------------------------------------------------------
/** `null` = proceed. Otherwise the response to send. T2 first; for writes the throttle comes next, before any body is read. */
export async function gate(ctx: AuthCtx, op: WorkOp, write: boolean): Promise<Response | null> {
  const r = await ctx.resolve('T2');
  if (!r.ok) {
    if (r.kind === 'auth_unavailable') { ctx.rc.log.info('work_refused', { op, kind: 'auth_unavailable' }); return unavailableJson(); } // cookies untouched
    if (r.kind === 'setup_required') { ctx.rc.log.info('work_refused', { op, kind: 'setup_required' }); return NextResponse.json({ error: { code: 'setup_required', message: 'Please set your password first.' } }, { status: 403, headers: NO_STORE }); }
    ctx.rc.log.info('work_refused', { op, kind: 'unauthenticated' });
    const f = authFailure('unauthenticated');
    return applyCookies(ctx, NextResponse.json({ error: { code: f.kind, message: f.message } }, { status: 401, headers: NO_STORE }));
  }
  if (r.actor.kind !== 'member') return applyCookies(ctx, NextResponse.json({ error: { code: 'unauthenticated', message: authFailure('unauthenticated').message } }, { status: 401, headers: NO_STORE }));
  if (write) {
    const t = writeThrottleFor(ctx.env.authThrottleSecret);
    if (!t) { ctx.rc.log.warn('work_refused', { op, kind: 'throttle_unconfigured' }); return applyCookies(ctx, NextResponse.json({ error: { code: 'unavailable', message: failureResponse('unavailable').message } }, { status: 503, headers: { ...NO_STORE, 'retry-after': '5' } })); }
    const d = await t.check({ userId: r.actor.userId, ip: ctx.ip });
    if (!d.allowed) {
      ctx.rc.log.info('work_refused', { op, kind: 'rate_limited' });
      return applyCookies(ctx, NextResponse.json({ error: { code: 'rate_limited', message: 'Too many saves. Please wait a moment and try again.' }, retryAfterSec: d.retryAfterSec }, { status: 429, headers: { ...NO_STORE, 'retry-after': String(d.retryAfterSec) } }));
    }
  }
  return null;
}

// ---- body ------------------------------------------------------------------------------------------------------------------------------------------
export type Body = { readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly res: Response };
/** JSON only (refused before any byte is read otherwise); size limited while streaming; 3 s deadline. */
export async function readJson(request: Request, maxBytes: number): Promise<Body> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return { ok: false, res: bodyProblemJson(415) };
  const body = await readBodyBounded(request, maxBytes);
  if (!body.ok) return { ok: false, res: bodyProblemJson(body.status) };
  try { return { ok: true, json: JSON.parse(body.text) }; } catch { return { ok: false, res: bodyProblemJson(400) }; }
}

// ---- responses -------------------------------------------------------------------------------------------------------------------------------------
export function invalidRequest(ctx: AuthCtx, op: WorkOp, fields: readonly { path: string; code: string }[]): Response {
  ctx.rc.log.info('work_invalid', { op, fields: fields.length });
  return applyCookies(ctx, NextResponse.json({ error: { code: 'validation_failed', message: 'The request is invalid.', fields } }, { status: 400, headers: NO_STORE }));
}
function failureJson(f: WorkFailure): NextResponse {
  const r = failureResponse(f.kind);
  return NextResponse.json({ error: { code: r.code, message: r.message, ...(f.field ? { field: f.field } : {}) } }, { status: r.status, headers: { ...NO_STORE, ...(r.status === 503 ? { 'retry-after': '5' } : {}) } });
}
/** Turns a module result into a response. Cookies are applied here (a token refresh during the request must reach the browser); only the outcome KIND is logged. */
export function reply<T>(ctx: AuthCtx, op: WorkOp, result: WorkResult<T>, status = 200): Response {
  if (!result.ok) { ctx.rc.log.info('work_failed', { op, kind: result.kind }); return applyCookies(ctx, failureJson(result)); }
  ctx.rc.log.info('work_ok', { op });
  return applyCookies(ctx, NextResponse.json(result.data, { status, headers: NO_STORE }));
}
