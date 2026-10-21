// POST /auth/callback/exchange: consumes the one-time token (exactly once, by the provider), starts the session, and for an invitation or recovery
// sends the member to choose a password. Same-origin only; throttled BEFORE the provider is called; failures use fixed wording.
import { NextResponse } from 'next/server';
import { classifyProviderFailure, mapAuthError, parseAuthCallback, signSetupMarker } from '@/src/modules/identity';
import { applyCookies, authRoute, hasAuthCookie, readFields, redirectSeeOther, sessionIdOf, setMarkerCookie, throttled } from '../../_server/kit';
import { bodyProblemPage, callbackProblem, callbackSwitchNeeded } from '../../_server/pages';

export const dynamic = 'force-dynamic';

export const POST = authRoute(async (request, ctx) => {
  const read = await readFields(request, ['type', 'token_hash', 'next', 'confirm_switch']);
  if (!read.ok) return bodyProblemPage(read.status);
  const f = read.fields;
  const p = parseAuthCallback(new URLSearchParams({ type: f.type ?? '', token_hash: f.token_hash ?? '', next: f.next ?? '' }));
  if (!p.ok) return callbackProblem(p.reason === 'signup_unavailable' ? 'closed' : 'invalid', null);

  // A link must never replace an existing session silently. With a session present the member has to confirm; without confirmation NOTHING is consumed.
  const hadSession = hasAuthCookie(ctx.cookies);
  if (hadSession && f.confirm_switch !== '1') { ctx.rc.log.info('auth_exchange_switch_needed'); return callbackSwitchNeeded(p.type, p.tokenHash, p.next); }

  const action = p.type === 'recovery' ? 'recovery-callback' : 'invite-callback';
  const r = await throttled(ctx, action, undefined, async () => {
    if (hadSession) {
      // Confirmed switch: end the current session at the provider FIRST. If that cannot be done now (outage), stop before the one-time token is consumed.
      let ended = false; try { const { error: e0 } = await ctx.db.client.auth.signOut({ scope: 'local' }); ended = !e0 || classifyProviderFailure(e0) !== 'unavailable'; } catch { ended = false; }
      if (!ended) return null;
    }
    return ctx.db.client.auth.verifyOtp({ type: p.type, token_hash: p.tokenHash });
  });
  if (!r.ok) { ctx.rc.log.info('auth_exchange_refused', { kind: r.kind }); return r.kind === 'rate_limited' ? callbackProblem('rate_limited', p.type, r.retryAfterSec) : callbackProblem('unavailable', p.type); }

  if (r.value === null) { ctx.rc.log.info('auth_exchange_refused', { kind: 'unavailable' }); return callbackProblem('unavailable', p.type); }
  const { data, error } = r.value;
  if (error || !data.session) {
    const f2 = mapAuthError(error as never);
    ctx.rc.log.info('auth_exchange_failed', { kind: f2.kind });   // kind only: never the token, the link or the address
    // Only an explicit expired/used/invalid-link verdict is shown as "expired"; anything else is retryable (503). Never guess that a link is dead.
    return f2.kind === 'link_invalid_or_expired' ? callbackProblem('expired', p.type) : f2.kind === 'rate_limited' ? callbackProblem('rate_limited', p.type) : callbackProblem('unavailable', p.type);
  }
  const sessionId = sessionIdOf(data.session.access_token);
  const needsPassword = p.type === 'invite' || p.type === 'recovery';
  const res: NextResponse = redirectSeeOther(needsPassword ? `/auth/set-password?next=${encodeURIComponent(p.next)}` : p.next);
  applyCookies(ctx, res);
  if (hadSession) ctx.rc.log.info('auth_exchange_switched');
  if (!needsPassword && hadSession) setMarkerCookie(ctx, res, null);
  if (needsPassword && ctx.env.authSetupMarkerSecret) setMarkerCookie(ctx, res, signSetupMarker(ctx.env.authSetupMarkerSecret, { userId: data.session.user.id, sessionId }, Date.now()));
  ctx.rc.log.info('auth_exchange_ok', { type: p.type });
  return res;
});
