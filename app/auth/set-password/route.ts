// GET shows the password form (needs a session cookie). POST sets the password: T2 (the Auth server confirms the session), same-origin, throttled,
// validated on the server (the provider enforces the same minimum and a 72-byte maximum). The "set your password first" marker is a UX consistency
// rule only: it is cleared here, and nothing about authorization depends on it.
import { mapAuthError, passwordIssuesMessage, resolveActor, safeReturnPath, validatePassword } from '@/src/modules/identity';
import { applyCookies, authRoute, hasAuthCookie, readFields, redirectSeeOther, setMarkerCookie, throttled } from '../_server/kit';
import { bodyProblemPage, callbackProblem, notSignedIn, passwordForm } from '../_server/pages';

export const dynamic = 'force-dynamic';

export const GET = authRoute(async (request, ctx) => {
  if (!hasAuthCookie(ctx.cookies)) return notSignedIn();
  return passwordForm(safeReturnPath(new URL(request.url).searchParams.get('next')));
});

export const POST = authRoute(async (request, ctx) => {
  const read = await readFields(request, ['password', 'next']);
  if (!read.ok) return bodyProblemPage(read.status);
  const f = read.fields;
  if (typeof f.password !== 'string') return bodyProblemPage(400);
  const next = safeReturnPath(f.next);
  // The marker gate is deliberately NOT applied here (this page is what the marker asks for): only the T2 outcome matters.
  const who = await resolveActor(ctx.source, 'T2');
  if (!who.ok) return who.kind === 'auth_unavailable' ? callbackProblem('unavailable', null) : notSignedIn();
  const v = validatePassword(f.password);
  if (!v.ok) return passwordForm(next, passwordIssuesMessage(v.issues));
  const r = await throttled(ctx, 'set-password', undefined, () => ctx.db.client.auth.updateUser({ password: f.password }));
  if (!r.ok) return r.kind === 'rate_limited' ? callbackProblem('rate_limited', null, r.retryAfterSec) : callbackProblem('unavailable', null);
  if (r.value.error) {
    const fail = mapAuthError(r.value.error as never);
    ctx.rc.log.info('auth_set_password_failed', { kind: fail.kind });
    if (fail.kind === 'weak_password') return passwordForm(next, fail.message);
    if (fail.kind === 'rate_limited') return callbackProblem('rate_limited', null);
    if (fail.kind === 'unauthenticated') return notSignedIn();
    return callbackProblem('unavailable', null);
  }
  const res = redirectSeeOther(next);
  applyCookies(ctx, res); setMarkerCookie(ctx, res, null);
  ctx.rc.log.info('auth_set_password_ok');
  return res;
});
