// GET /auth/session/verified: a stand-in for any PRIVATE READ or WRITE (T2): the Auth server confirms the session just now, and the "set your password
// first" nudge applies. Replaced by real operations in PX-3. An Auth outage is a retryable 503, never a downgrade to the provisional T1 answer.
import { NextResponse } from 'next/server';
import { authFailure } from '@/src/modules/identity';
import { applyCookies, authRoute, failureJson, unavailableJson } from '../../_server/kit';

export const dynamic = 'force-dynamic';

export const GET = authRoute(async (_request, ctx) => {
  const r = await ctx.resolve('T2');
  if (r.ok) return applyCookies(ctx, NextResponse.json({ state: 'member', verification: 'server' }, { headers: { 'cache-control': 'no-store' } }));
  if (r.kind === 'auth_unavailable') return unavailableJson();
  if (r.kind === 'setup_required') return NextResponse.json({ error: { code: 'setup_required', message: 'Please set your password first.' } }, { status: 403, headers: { 'cache-control': 'no-store' } });
  return applyCookies(ctx, failureJson(authFailure('unauthenticated')));
});
