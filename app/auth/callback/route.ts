// GET /auth/callback: READ-ONLY. Shows what the emailed link is for and a Continue button. It never calls the Auth provider and never consumes the
// one-time token (mail scanners, previews and prefetch issue GETs). The exchange happens in POST /auth/callback/exchange.
import { parseAuthCallback } from '@/src/modules/identity';
import { authRoute, hasAuthCookie } from '../_server/kit';
import { callbackProblem, callbackReady } from '../_server/pages';

export const dynamic = 'force-dynamic';

export const GET = authRoute(async (request, ctx) => {
  const p = parseAuthCallback(new URL(request.url).searchParams);
  if (p.ok) return callbackReady(p.type, p.tokenHash, p.next, hasAuthCookie(ctx.cookies)); // a cookie check only: no network call, nothing consumed
  if (p.reason === 'signup_unavailable') return callbackProblem('closed', null);
  if (p.reason === 'link_invalid_or_expired') return callbackProblem('expired', null);
  return callbackProblem('invalid', null);
});
