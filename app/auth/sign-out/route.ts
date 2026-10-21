// POST /auth/sign-out: revokes the session at the provider (this device) and ALWAYS expires the session cookies, even when the provider cannot be reached
// (the member's intent is honoured; `revoked: false` tells the caller the provider could not confirm, and the refresh token then lives until it expires).
import { NextResponse } from 'next/server';
import { authRoute, clearAuthCookies, hasAuthCookie, setMarkerCookie } from '../_server/kit';

export const dynamic = 'force-dynamic';

export const POST = authRoute(async (_request, ctx) => {
  let revoked = false;
  if (hasAuthCookie(ctx.cookies)) {
    try { const { error } = await ctx.db.client.auth.signOut({ scope: 'local' }); revoked = !error; } catch { revoked = false; }
  } else revoked = true;
  ctx.rc.log.info('auth_sign_out', { revoked });
  const res = NextResponse.json({ ok: true, revoked }, { headers: { 'cache-control': 'no-store' } });
  clearAuthCookies(ctx, res); setMarkerCookie(ctx, res, null);
  return res;
});
