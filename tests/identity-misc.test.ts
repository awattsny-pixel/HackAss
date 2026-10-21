// PX-2a: password rule, uniform failures, callback parsing, and module-level guarantees (invite-only, no Auth client, no environment).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authFailure, mapAuthError, parseAuthCallback, RECOVERY_REQUEST_RESPONSE, validatePassword } from '../src/modules/identity/index.ts';

test('password: 12 code points minimum, 72 bytes maximum, no composition rules, not the email', () => {
  assert.deepEqual(validatePassword('correct horse battery'), { ok: true });
  assert.deepEqual(validatePassword('abcdefghijkl'), { ok: true });
  assert.deepEqual(validatePassword('abcdefghijk'), { ok: false, issues: ['too_short'] });
  assert.deepEqual(validatePassword('日本語日本語日本語日本語'), { ok: true }, 'counted in characters, 12 here');
  assert.deepEqual(validatePassword('é'.repeat(37)), { ok: false, issues: ['too_long'] }, '74 bytes');
  assert.deepEqual(validatePassword('é'.repeat(36)), { ok: true }, '72 bytes');
  assert.deepEqual(validatePassword('a'.repeat(12) + '\u0000'), { ok: false, issues: ['control_characters'] });
  assert.deepEqual(validatePassword('Alice@Example.com', { email: ' alice@example.com ' }), { ok: false, issues: ['same_as_email'] });
  assert.deepEqual(validatePassword(123456789012 as unknown), { ok: false, issues: ['not_text'] });
});
test('failures are uniform: unknown email, wrong password, banned and unconfirmed read the same; provider text never leaks', () => {
  const same = ['invalid_credentials', 'user_not_found', 'user_banned', 'email_not_confirmed', 'signup_disabled'].map((code) => mapAuthError({ code, status: 400 }));
  for (const f of same) assert.deepEqual(f, authFailure('invalid_credentials'));
  assert.equal(mapAuthError({ code: 'otp_expired' }).kind, 'link_invalid_or_expired'); assert.equal(mapAuthError({ code: 'weak_password' }).kind, 'weak_password');
  assert.equal(mapAuthError({ code: 'over_email_send_rate_limit' }).kind, 'rate_limited'); assert.equal(mapAuthError({ status: 429 }).kind, 'rate_limited');
  assert.equal(mapAuthError({ code: 'refresh_token_already_used' }).kind, 'unauthenticated');
  for (const unknown of [null, undefined, {}, { code: 'brand_new_code', status: 500 }, { status: 502 }, { code: 42 }]) assert.equal(mapAuthError(unknown as never).kind, 'unavailable');
  // REGRESSION: a server failure takes precedence over any code that came with it; a 429 over a code; both are statements about the server, not the member
  for (const status of [500, 502, 503, 504, 599]) for (const code of ['invalid_credentials', 'otp_expired', 'weak_password', 'user_not_found', 'refresh_token_already_used', undefined]) assert.equal(mapAuthError({ status, code }).kind, 'unavailable', `${status} ${code}`);
  assert.equal(mapAuthError({ status: 429, code: 'invalid_credentials' }).kind, 'rate_limited');
  assert.equal(mapAuthError({ status: 401, code: 'invalid_credentials' }).kind, 'invalid_credentials'); assert.equal(mapAuthError({ status: 400, code: 'otp_expired' }).kind, 'link_invalid_or_expired');
  assert.equal(mapAuthError({ status: 503, code: 'invalid_credentials' }).status, 503, 'the HTTP status we return is 503 too');
  for (const k of ['invalid_credentials', 'link_invalid_or_expired', 'weak_password', 'rate_limited', 'unauthenticated', 'unavailable'] as const) assert.doesNotMatch(authFailure(k).message, /supabase|gotrue|jwt|token|sql|stack/i);
  assert.equal(RECOVERY_REQUEST_RESPONSE.status, 202); assert.doesNotMatch(RECOVERY_REQUEST_RESPONSE.message, /not found|unknown|no account|does not exist/i);
});
const q = (s: string) => new URLSearchParams(s);
test('callback parsing: valid invite/recovery/email_change links; everything else refused before anything is exchanged', () => {
  const tok = 'a'.repeat(40);
  assert.deepEqual(parseAuthCallback(q(`type=invite&token_hash=${tok}&next=/lab`)), { ok: true, type: 'invite', tokenHash: tok, next: '/lab' });
  assert.deepEqual(parseAuthCallback(q(`type=recovery&token_hash=${tok}&next=https://evil.example`)), { ok: true, type: 'recovery', tokenHash: tok, next: '/spark' });
  assert.ok(parseAuthCallback(q(`type=email_change&token_hash=${tok}`)).ok);
  assert.equal((parseAuthCallback(q(`type=signup&token_hash=${tok}`)) as { reason: string }).reason, 'signup_unavailable', 'public registration is unavailable');
  assert.equal((parseAuthCallback(q(`type=magiclink&token_hash=${tok}`)) as { reason: string }).reason, 'signup_unavailable');
  assert.equal((parseAuthCallback(q(`type=admin&token_hash=${tok}`)) as { reason: string }).reason, 'unsupported_type');
  assert.equal((parseAuthCallback(q('type=invite')) as { reason: string }).reason, 'missing');
  assert.equal((parseAuthCallback(q('token_hash=abc')) as { reason: string }).reason, 'missing');
  for (const bad of ['short', 'a'.repeat(129), 'has space ' + 'a'.repeat(30), 'a'.repeat(40) + '<', '../' + 'a'.repeat(40)]) assert.equal((parseAuthCallback(q(`type=invite&token_hash=${encodeURIComponent(bad)}`)) as { reason: string }).reason, 'malformed', bad);
  assert.equal((parseAuthCallback(q('error=access_denied&error_code=otp_expired')) as { reason: string }).reason, 'link_invalid_or_expired');
});
const root = fileURLToPath(new URL('..', import.meta.url));
const files = readdirSync(join(root, 'src/modules/identity')).filter((f) => f.endsWith('.ts')).map((f) => [f, readFileSync(join(root, 'src/modules/identity', f), 'utf8')] as const);
test('the module has no Auth or database client, no environment access and no browser storage', () => {
  for (const [f, s] of files) {
    assert.doesNotMatch(s, /from ['"]@supabase|supabase-js|@supabase\/ssr/, f);
    assert.doesNotMatch(s, /process\.env|getEnv|createUserDb|createPublicDb|createWorkerDb|service_role|SERVICE/, f);
    assert.doesNotMatch(s, /localStorage|sessionStorage|document\.cookie|fetch\(/, f);
  }
});
test('invite-only pilot: the module has no sign-up capability (a hidden button is not the control)', () => {
  for (const [f, s] of files) {
    const code = s.replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'/g, "''"); // comments and string literals removed: only identifiers and calls count
    assert.doesNotMatch(code, /signUp\b|sign_up|\bregister\(|createAccount|signup\(/i, f);
  }
  // the only mention is the refusal of `signup`/`magiclink` callback types (a string literal)
  assert.match(readFileSync(join(root, 'src/modules/identity/callback.ts'), 'utf8'), /signup_unavailable/);
});
