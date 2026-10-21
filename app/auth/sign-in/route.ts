// POST /auth/sign-in {email, password} (JSON or form). Throttled before the provider; every failure reads the same to the member.
import { NextResponse } from 'next/server';
import { authFailure, mapAuthError } from '@/src/modules/identity';
import { applyCookies, authRoute, bodyProblemJson, failureJson, readFields, throttled, unavailableJson } from '../_server/kit';

export const dynamic = 'force-dynamic';

export const POST = authRoute(async (request, ctx) => {
  const read = await readFields(request, ['email', 'password']);
  if (!read.ok) return bodyProblemJson(read.status);   // a body problem is independent of any credential, so it can say what it is
  const f = read.fields;
  if (typeof f.email !== 'string' || typeof f.password !== 'string' || f.email.length > 254 || f.password.length > 1024 || !f.email.includes('@')) return failureJson(authFailure('invalid_credentials'));
  const r = await throttled(ctx, 'sign-in', f.email, () => ctx.db.client.auth.signInWithPassword({ email: f.email, password: f.password }));
  if (!r.ok) { ctx.rc.log.info('auth_sign_in_refused', { kind: r.kind }); return r.kind === 'rate_limited' ? failureJson(authFailure('rate_limited'), r.retryAfterSec) : unavailableJson(); }
  if (r.value.error || !r.value.data.session) {
    const fail = mapAuthError(r.value.error as never);
    ctx.rc.log.info('auth_sign_in_failed', { kind: fail.kind });
    return failureJson(fail);                       // no cookie is written on a failure
  }
  ctx.rc.log.info('auth_sign_in_ok');
  return applyCookies(ctx, NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } }));
});
