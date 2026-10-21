// PX-2b unit tests: provider-result translation, the setup marker (a UX rule, not authorization), bounded fetch, env additions, cookie options.
import test from 'node:test';
import assert from 'node:assert/strict';
import { claimsResultFromProvider, classifyProviderFailure, serverResultFromProvider, setupIsPending, signSetupMarker, verifySetupMarker, passwordIssuesMessage, validatePassword } from '../src/modules/identity/index.ts';
import { createBoundedFetch } from '../src/platform/http/bounded-fetch.ts';
import { loadEnv } from '../src/platform/env-validate.ts';
import { SESSION_COOKIE_MAX_AGE_SECONDS } from '../src/platform/db/clients.ts';

const err = (name: string, status?: number, code?: string, message = '') => ({ name, status, code, message });

test('provider failures: only explicit credential verdicts are "revoked"; network, timeout, 5xx, 429 and unknowns are "unavailable"', () => {
  assert.equal(classifyProviderFailure(err('AuthSessionMissingError', 400)), 'session_missing');
  for (const e of [err('AuthApiError', 401, 'session_not_found'), err('AuthApiError', 403, 'session_not_found'), err('AuthApiError', 400, 'refresh_token_not_found'), err('AuthApiError', 400, 'refresh_token_already_used'), err('AuthApiError', 400, 'bad_jwt'), err('AuthApiError', 401, 'invalid_jwt'), err('AuthInvalidJwtError', 401)]) assert.equal(classifyProviderFailure(e), 'revoked', JSON.stringify(e));
  // REGRESSION: availability failures take precedence over the error's name and code
  for (const e of [err('AuthSessionMissingError', 503), err('AuthSessionMissingError', 502), err('AuthSessionMissingError', 0), err('AuthSessionMissingError', 429), err('AuthInvalidJwtError', 503), err('AuthApiError', 500, 'refresh_token_not_found'), err('AuthApiError', 429, 'bad_jwt')]) assert.equal(classifyProviderFailure(e), 'unavailable', JSON.stringify(e));
  assert.deepEqual(serverResultFromProvider({ data: null, error: err('AuthSessionMissingError', 503) }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(claimsResultFromProvider({ data: null, error: err('AuthSessionMissingError', 503) }), { ok: false, reason: 'unavailable' });
  // REGRESSION: an unknown or missing code, or any other 4xx, is NOT a verdict about the credential: it is retryable, never revocation
  for (const e of [err('AuthApiError', 403), err('AuthApiError', 401), err('AuthApiError', 400, 'mystery_code'), err('AuthApiError', 404), err('AuthApiError', 422, 'validation_failed'), err('AuthApiError', 400), err('AuthApiError', 409, 'conflict')]) assert.equal(classifyProviderFailure(e), 'unavailable', JSON.stringify(e));
  for (const e of [err('AuthRetryableFetchError', 0), err('AuthRetryableFetchError', 503), err('AuthApiError', 500), err('AuthApiError', 502, 'session_not_found'), err('AuthApiError', 429, 'over_request_rate_limit'), err('AbortError'), err('TimeoutError'), err('TypeError'), err('AuthUnknownError', 200), err('AuthRefreshDiscardedError', 409), err('Weird'), null, undefined, 'x', 42])
    assert.equal(classifyProviderFailure(e), 'unavailable', JSON.stringify(e));
});
test('claims from the provider: valid claims; signing-key failure is unavailable; no session is no_session; expired vs invalid; garbage is unavailable', () => {
  const ok = claimsResultFromProvider({ data: { claims: { sub: 'u', session_id: 's', aal: 'aal2', exp: 123 } }, error: null });
  assert.deepEqual(ok, { ok: true, claims: { userId: 'u', sessionId: 's', aal: 'aal2', expiresAt: 123 } });
  assert.equal((claimsResultFromProvider({ data: { claims: { sub: 'u', exp: 1 } }, error: null }) as { claims: { aal: string } }).claims.aal, 'aal1');
  assert.deepEqual(claimsResultFromProvider({ data: null, error: err('AuthRetryableFetchError', 0, undefined, 'fetch failed') }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(claimsResultFromProvider({ data: null, error: null }), { ok: false, reason: 'no_session' });
  assert.deepEqual(claimsResultFromProvider({ data: null, error: err('AuthSessionMissingError', 400) }), { ok: false, reason: 'no_session' });
  assert.deepEqual(claimsResultFromProvider({ data: null, error: err('AuthInvalidJwtError', 401, undefined, 'JWT expired') }), { ok: false, reason: 'expired' });
  assert.deepEqual(claimsResultFromProvider({ data: null, error: err('AuthInvalidJwtError', 401, undefined, 'Invalid JWT signature') }), { ok: false, reason: 'invalid' });
  for (const bad of [undefined, null, 'x', { data: { claims: { sub: 1, exp: 'x' } }, error: null }, { data: { claims: { exp: 1 } }, error: null }]) assert.deepEqual(claimsResultFromProvider(bad as never), { ok: false, reason: 'unavailable' });
});
test('user check from the provider: ok needs a real id; empty answers are unavailable; 401 is revoked; 5xx is unavailable', () => {
  assert.deepEqual(serverResultFromProvider({ data: { user: { id: 'u1' } }, error: null }), { ok: true, userId: 'u1' });
  assert.deepEqual(serverResultFromProvider({ data: { user: null }, error: null }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(serverResultFromProvider({ data: null, error: null }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(serverResultFromProvider({ data: null, error: err('AuthApiError', 401, 'session_not_found') }), { ok: false, reason: 'revoked' });
  assert.deepEqual(serverResultFromProvider({ data: null, error: err('AuthSessionMissingError', 400) }), { ok: false, reason: 'no_session' });
  assert.deepEqual(serverResultFromProvider({ data: null, error: err('AuthApiError', 400, 'mystery_code') }), { ok: false, reason: 'unavailable' }, 'an unknown provider failure is not revocation');
  assert.deepEqual(claimsResultFromProvider({ data: null, error: err('AuthApiError', 403) }), { ok: false, reason: 'unavailable' }, 'a 403 without a known code is not revocation');
  assert.deepEqual(serverResultFromProvider({ data: null, error: err('AuthRetryableFetchError', 503) }), { ok: false, reason: 'unavailable' });
});

const SECRET = 'm'.repeat(40);
test('setup marker: valid for the bound user and session; absent, tampered, malformed, expired and mismatched never block; it is documented as a UX rule', () => {
  const b = { userId: 'u1', sessionId: 's1' }; const t = 1_000_000;
  const m = signSetupMarker(SECRET, b, t);
  assert.equal(verifySetupMarker(SECRET, m, b, t + 1000), 'valid'); assert.ok(setupIsPending('valid'));
  assert.equal(verifySetupMarker(SECRET, undefined, b, t), 'absent');
  assert.equal(verifySetupMarker(SECRET, m, b, t + 15 * 60 * 1000), 'expired', 'expiry lifts it');
  assert.equal(verifySetupMarker(SECRET, m, { userId: 'u2', sessionId: 's1' }, t + 1), 'mismatch'); assert.equal(verifySetupMarker(SECRET, m, { userId: 'u1', sessionId: 's2' }, t + 1), 'mismatch');
  const parts = m.split('.'); assert.equal(verifySetupMarker(SECRET, `${parts[0]}.${Buffer.from('{"u":"u1","s":"s1","e":9999999999999}').toString('base64url')}.${parts[2]}`, b, t), 'invalid', 'edited payload');
  assert.equal(verifySetupMarker('z'.repeat(40), m, b, t), 'invalid', 'other secret'); for (const junk of ['x', 'v1..', 'v2.a.b', 'v1.a.b.c', '']) assert.ok(['invalid', 'absent'].includes(verifySetupMarker(SECRET, junk, b, t)), junk);
  for (const s of ['absent', 'expired', 'invalid', 'mismatch'] as const) assert.equal(setupIsPending(s), false, `${s} must not block anything`);
  assert.throws(() => signSetupMarker('short', b, t));
});
test('bounded fetch: a call is aborted after the per-call timeout; the request budget caps the total; success passes through', async () => {
  const keepAlive = setInterval(() => {}, 20); // AbortSignal.timeout timers are unref'd: keep the test process alive so they can fire
  try {
  const hang: typeof fetch = (_i, init) => new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)); });
  const t0 = Date.now(); await assert.rejects(() => createBoundedFetch(80, 1000, Date.now, hang)('http://x/'), (e: unknown) => (e as { name: string }).name === 'TimeoutError'); assert.ok(Date.now() - t0 < 500, 'aborted quickly');
  let clock = 0; const bf = createBoundedFetch(1000, 100, () => clock, (async () => new Response('ok')) as typeof fetch);
  assert.equal(await (await bf('http://x/')).text(), 'ok'); clock = 150; await assert.rejects(() => bf('http://x/'), (e: unknown) => (e as { name: string }).name === 'TimeoutError', 'budget spent: refused without a network call');
  const caller = new AbortController(); const withCaller = createBoundedFetch(5000, 5000, Date.now, hang)('http://x/', { signal: caller.signal }); caller.abort(new Error('caller')); await assert.rejects(() => withCaller, /caller/);
  } finally { clearInterval(keepAlive); }
});
const baseEnv = { APP_ENV: 'local', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55421', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abcdefgh', APP_ORIGIN: 'http://localhost:3100', CURSOR_SIGNING_SECRET: 'c'.repeat(40) };
test('env: the new auth variables are optional, validated, and never required to be public', () => {
  const e = loadEnv(baseEnv).env; assert.equal(e.authThrottleSecret, null); assert.equal(e.authSetupMarkerSecret, null); assert.deepEqual(e.trustedClientIp, { kind: 'none' });
  assert.equal(loadEnv({ ...baseEnv, AUTH_THROTTLE_SECRET: 'a'.repeat(32), AUTH_SETUP_MARKER_SECRET: 'b'.repeat(32), TRUSTED_CLIENT_IP_HEADER: 'X-Real-IP' }).env.trustedClientIp.kind, 'header');
  assert.deepEqual(loadEnv({ ...baseEnv, TRUSTED_PROXY_HOPS: '2' }).env.trustedClientIp, { kind: 'forwarded-for', trustedHops: 2 });
  for (const bad of [{ AUTH_THROTTLE_SECRET: 'short' }, { AUTH_SETUP_MARKER_SECRET: 'short' }, { TRUSTED_PROXY_HOPS: '0' }, { TRUSTED_PROXY_HOPS: 'x' }, { TRUSTED_CLIENT_IP_HEADER: 'bad header!' }, { TRUSTED_CLIENT_IP_HEADER: 'x-real-ip', TRUSTED_PROXY_HOPS: '1' }, { NEXT_PUBLIC_AUTH_THROTTLE_SECRET: 'a'.repeat(40) }])
    assert.throws(() => loadEnv({ ...baseEnv, ...bad }), /Invalid environment configuration/, JSON.stringify(bad));
});
test('session cookie lifetime is the provisional 7 days; password wording', () => {
  assert.equal(SESSION_COOKIE_MAX_AGE_SECONDS, 7 * 24 * 3600);
  assert.match(passwordIssuesMessage(['too_short']), /12 characters/); assert.match(passwordIssuesMessage(['too_long']), /72 bytes/);
  const v = validatePassword('short'); assert.ok(!v.ok);
});
