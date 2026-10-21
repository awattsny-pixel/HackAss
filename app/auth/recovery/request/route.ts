// POST /auth/recovery/request {email}: ALWAYS 202 with the same sentence whether or not the address belongs to a member. Only throttling or an outage
// changes the answer, and neither depends on whether the address exists.
import { NextResponse } from 'next/server';
import { authFailure, mapAuthError, RECOVERY_REQUEST_RESPONSE } from '@/src/modules/identity';
import { authRoute, bodyProblemJson, failureJson, readFields, throttled, unavailableJson } from '../../_server/kit';

export const dynamic = 'force-dynamic';

export const POST = authRoute(async (request, ctx) => {
  const read = await readFields(request, ['email']);
  if (!read.ok) return bodyProblemJson(read.status);
  const f = read.fields;
  if (typeof f.email !== 'string' || f.email.length > 254 || !f.email.includes('@')) return NextResponse.json({ error: { code: 'validation_failed', message: 'Enter a valid email address.' } }, { status: 400, headers: { 'cache-control': 'no-store' } });
  const r = await throttled(ctx, 'recovery-request', f.email, () => ctx.db.client.auth.resetPasswordForEmail(f.email));
  if (!r.ok) { ctx.rc.log.info('auth_recovery_refused', { kind: r.kind }); return r.kind === 'rate_limited' ? failureJson(authFailure('rate_limited'), r.retryAfterSec) : unavailableJson(); }
  if (r.value.error && mapAuthError(r.value.error as never).kind === 'unavailable') return unavailableJson();
  // EVERYTHING else is deliberately indistinguishable from success, including the provider's own rate limits: its per-user cooldown (about a minute) applies
  // only to addresses that belong to a member, so answering 429 for it would reveal that an address is a member. Existence-independent limits (our throttle,
  // an outage) still answer 429 / 503 above.
  ctx.rc.log.info('auth_recovery_requested');
  return NextResponse.json({ message: RECOVERY_REQUEST_RESPONSE.message }, { status: RECOVERY_REQUEST_RESPONSE.status, headers: { 'cache-control': 'no-store' } });
});
