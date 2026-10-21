// GET /auth/session: the PROVISIONAL signed-in indicator (T1: signature and expiry only; may still show a session revoked by sign-out until the token
// expires). This is also where an expired access token is refreshed (cookies can be written here). On an outage nothing is changed or cleared.
import { NextResponse } from 'next/server';
import { applyCookies, authRoute, unavailableJson } from '../_server/kit';

export const dynamic = 'force-dynamic';

export const GET = authRoute(async (_request, ctx) => {
  const r = await ctx.resolve('T1');
  if (!r.ok && r.kind === 'auth_unavailable') return unavailableJson();       // cookies untouched, no redirect, the page and any draft stay as they are
  const pending = r.ok && r.actor.kind === 'member' ? (await ctx.markerStatus()) === 'valid' : false;
  const body = r.ok && r.actor.kind === 'member' ? { state: 'member', verification: 'claims', setupPending: pending } : { state: 'anonymous' };
  return applyCookies(ctx, NextResponse.json(body, { headers: { 'cache-control': 'no-store' } }));
});
