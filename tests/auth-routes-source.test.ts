// PX-2b source-level guarantees for the auth handlers (the live behaviour is in scripts/px2b-local-checks.mjs against a real local Auth stack).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const walk = (d: string): string[] => readdirSync(join(root, d)).flatMap((n) => { const p = join(d, n); return statSync(join(root, p)).isDirectory() ? walk(p) : [p]; });
const authFiles = walk('app/auth').filter((f) => /\.(ts|tsx)$/.test(f) && !/^app\/auth\/(login|signup)\//.test(f)); // legacy pages excluded
const routes = authFiles.filter((f) => /route\.ts$/.test(f));
const src = (f: string) => readFileSync(join(root, f), 'utf8');

test('every new auth route is wrapped by authRoute (environment check, request context, same-origin check) and exports only GET/POST', () => {
  assert.ok(routes.length >= 8, `routes: ${routes.join(', ')}`);
  for (const f of routes) {
    const s = src(f);
    assert.match(s, /authRoute\(/, f);
    for (const m of s.matchAll(/export (?:const|async function|function) (\w+)/g)) assert.ok(['GET', 'POST', 'dynamic'].includes(m[1]), `${f} exports ${m[1]}`);
    assert.doesNotMatch(s, /export (async )?function (PUT|PATCH|DELETE)|export const (PUT|PATCH|DELETE)/, f);
  }
});
test('mutating routes are POST only; read-only routes never call the provider to change anything', () => {
  for (const f of ['sign-in', 'sign-out', 'recovery/request', 'callback/exchange']) assert.doesNotMatch(src(`app/auth/${f}/route.ts`), /export const GET/, f);
  assert.doesNotMatch(src('app/auth/callback/route.ts'), /\.auth\.|ctx\.db|verifyOtp/, 'GET /auth/callback must never touch the provider');
  for (const f of ['session/route.ts', 'session/verified/route.ts']) assert.doesNotMatch(src(`app/auth/${f}`), /export const POST|updateUser|verifyOtp|signIn|signOut/, f);
});
test('no sign-up anywhere in the auth handlers; the only registration words are refusals', () => {
  for (const f of authFiles) { const code = src(f).replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'/g, "''").replace(/"[^"\n]*"/g, '""').replace(/`[^`]*`/g, '``'); assert.doesNotMatch(code, /signUp\b|sign_up|register\(|\bcreateUser\(|inviteUser/i, f); }
  assert.deepEqual(routes.filter((f) => /sign-?up|register/i.test(f)), []);
});
test('the auth composition holds no service-level key and no browser client; the Auth client is built only through the platform', () => {
  for (const f of authFiles) { const s = src(f); assert.doesNotMatch(s, /service_role|SERVICE|SECRET_KEY|admin\.auth|createBrowserClient/, f); assert.doesNotMatch(s, /from ['"]@supabase/, `${f} imports a Supabase package directly`); }
  assert.match(src('app/auth/_server/kit.ts'), /createUserDb\(env,[\s\S]*createBoundedFetch\(\)/, 'every Auth call goes through the bounded fetch');
});
test('handlers log events by name with kinds only: no log call receives a request, header, cookie, body, token, email or password', () => {
  for (const f of authFiles) {
    const s = src(f); assert.doesNotMatch(s, /console\.(log|error|warn|info|debug)/, f);
    for (const m of s.matchAll(/\.log\.(?:info|warn|error)\(([^;]*)\);/g)) assert.doesNotMatch(m[1].replace(/'[^'\n]*'/g, "''"), /request|headers|cookie|body|token|email|password|\bf\b\./i, `${f}: ${m[0].slice(0, 100)}`);
  }
});
test('responses that carry session state or tokens are never cacheable; the email-link pages send no referrer to other sites and cannot be framed', () => {
  assert.match(src('app/auth/_server/pages.ts'), /'cache-control': 'no-store'[\s\S]*'referrer-policy': 'same-origin'[\s\S]*'x-frame-options': 'DENY'/);
  assert.match(src('app/auth/_server/kit.ts'), /const NO_STORE = \{ 'cache-control': 'no-store' \}/);
});
test('the redirects only ever use paths validated by safeReturnPath (relative Location, never a caller-supplied URL)', () => {
  const s = src('app/auth/_server/kit.ts'); assert.match(s, /export function redirectSeeOther\(path: string\)/);
  for (const f of ['callback/exchange/route.ts', 'set-password/route.ts']) { const r = src(`app/auth/${f}`); assert.match(r, /safeReturnPath|parseAuthCallback/, f); assert.doesNotMatch(r, /NextResponse\.redirect|new URL\([^)]*searchParams/, f); }
});

test('REGRESSIONS (source): recovery never reveals membership through provider rate limits; link exchange never replaces a session without confirmation; unknown failures are retryable', () => {
  const rec = src('app/auth/recovery/request/route.ts');
  assert.match(rec, /indistinguishable from success/); assert.doesNotMatch(rec, /failureJson\(fail\)/, 'the provider\'s rate limit must not become a 429 for recovery');
  const ex = src('app/auth/callback/exchange/route.ts');
  assert.match(ex, /hadSession && f\.confirm_switch !== '1'/); assert.ok(ex.indexOf("hadSession && f.confirm_switch !== '1'") < ex.indexOf('verifyOtp'), 'the confirmation check comes before the token is consumed');
  assert.match(ex, /signOut\(\{ scope: 'local' \}\)[\s\S]*verifyOtp/, 'the old session is ended before the token is consumed');
  assert.match(ex, /f2\.kind === 'link_invalid_or_expired' \? callbackProblem\('expired'/); assert.doesNotMatch(ex, /: callbackProblem\('expired', p\.type\);/, 'an unknown failure must not be shown as an expired link');
  for (const f of ['sign-in', 'recovery/request', 'callback/exchange', 'set-password']) assert.match(src(`app/auth/${f}/route.ts`), /readFields\(/, f);
  assert.match(src('app/auth/_server/kit.ts'), /readBodyBounded\(request\)/); assert.doesNotMatch(src('app/auth/_server/kit.ts'), /request\.text\(\)|request\.json\(\)|request\.formData\(\)/, 'bodies are only read through the bounded reader');
});
