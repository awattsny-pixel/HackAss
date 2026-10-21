// PX-3e: the private-preview gate (route allowlist, headers, mode), the stricter preview environment rules, the health route and robots, and the proxy wiring.
// The gate is a SAFETY NET: the preview's protection is access control in front of it (docs/px3d).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_SOURCES, decidePath, EDGE_LOCK_HEADER, EDGE_LOCK_SECRET_PATTERN, gateConfig, gateModeFrom, previewHeaders, PUBLIC_ASSETS } from '../src/platform/preview-gate.ts';
import { createRequire } from 'node:module';
import { EnvError, loadEnv, PREVIEW_FORBIDDEN_NAMES } from '../src/platform/env-validate.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const walk = (d: string): string[] => readdirSync(join(root, d)).flatMap((n) => { const p = join(d, n); return statSync(join(root, p)).isDirectory() ? walk(p) : [p]; });
const q = (s = '') => new URLSearchParams(s);
const kind = (method: string, path: string, search = '') => decidePath(method, path, q(search)).kind;
const code = (f: string) => readFileSync(join(root, f), 'utf8').replace(/\/\/.*$/gm, '');

test('gate mode: only an explicit local/ci environment is open; everything else fails closed; PREVIEW_GATE can force the gate on but can never switch it off outside local/ci', () => {
  assert.equal(gateModeFrom('local', undefined), 'open'); assert.equal(gateModeFrom('ci', undefined), 'open'); assert.equal(gateModeFrom('local', 'off'), 'open');
  assert.equal(gateModeFrom('local', 'on'), 'preview'); assert.equal(gateModeFrom('ci', 'on'), 'preview');
  for (const e of ['staging', 'production', undefined, '', 'prod', 'LOCAL', 'development', 'test']) for (const o of [undefined, 'on', 'off', 'whatever']) assert.equal(gateModeFrom(e, o), 'preview', `${e}/${o}`);
});
test('allowlist: every route the preview serves is allowed (each method) and nothing else is', () => {
  const allowed = ['/health', '/robots.txt', '/spark', '/spark/catalog/some-slug', '/spark/demo', '/spark/demo/meal', '/lab', '/reveal', '/account/sign-in', '/account/recover', '/account/prompts', '/account/results',
    '/account/prompts/3f2a6b1c-8d4e-4f60-9a7b-1c2d3e4f5a6b', '/account/results/3f2a6b1c-8d4e-4f60-9a7b-1c2d3e4f5a6b', '/auth/callback', '/auth/callback/exchange', '/auth/recovery/request', '/auth/session', '/auth/session/verified',
    '/auth/set-password', '/auth/sign-in', '/auth/sign-out', '/work/prompts', '/work/prompts/x', '/work/prompts/x/results', '/work/saves', '/work/results', '/work/results/x', '/work/export', '/_next/static/chunks/app.js', ...PUBLIC_ASSETS];
  for (const p of allowed) for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) assert.equal(kind(m, p), 'allow', `${m} ${p}`);   // the route itself decides the method
  const blocked = ['/browse', '/categories', '/hack/12', '/hack', '/profile', '/profile/x', '/submit', '/admin', '/admin/x', '/top-creators', '/manifesto', '/states', '/auth/login', '/auth/signup', '/auth', '/auth/', '/account', '/account/', '/account/sign-up', '/account/prompts/x/y',
    '/api', '/api/hacks', '/api/hacks/1', '/api/users/x', '/api/auth/login', '/api/auth/signup', '/api/admin/hacks', '/api/me/profile', '/api/follow/1', '/work', '/work/', '/work/prompts/x/y/z', '/work/other', '/spark/other', '/spark/catalog', '/spark/demo/a/b', '/lab/x', '/reveal/x',
    '/Lab', '/LAB', '//lab', '/health/x', '/gate-blocked', '/robots.txt/x', '/_next', '/_next/data/x.json', '/_next/webpack-hmr', '/favicon.ico', '/mascot.PNG', '/public/mascot.png', '/hack/hack-official.PNG', '/hack/other.png', '/..%2Flab', '/lab%2F', '/%2e%2e/admin', '/.env', '/.git/config', '/package.json', '/proxy.ts', '/sitemap.xml'];
  for (const p of blocked) assert.equal(kind('GET', p), 'block', `GET ${p}`);
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal(kind(m, '/'), 'block');
});
test('the root redirects to /spark for GET/HEAD only; the image optimizer serves only the preview\'s own artwork (no outbound fetch)', () => {
  assert.deepEqual(decidePath('GET', '/', q()), { kind: 'redirect', to: '/spark' }); assert.deepEqual(decidePath('HEAD', '/', q()), { kind: 'redirect', to: '/spark' });
  assert.equal(kind('GET', '/_next/image', 'url=%2Fhack%2Fhack-official.png&w=96&q=75'), 'allow'); assert.equal(kind('GET', '/_next/image', `url=${encodeURIComponent('/hack/hack-official.png')}`), 'allow');
  for (const u of ['https://evil.example/x.png', 'http://169.254.169.254/latest', '//evil.example/x.png', '/hack/../../etc/passwd', '/hack/other.png', '/', '', '/mascot.png/../x', 'file:///etc/passwd']) assert.equal(kind('GET', '/_next/image', `url=${encodeURIComponent(u)}&w=96&q=75`), 'block', u);
  assert.equal(kind('GET', '/_next/image'), 'block');
});
test('query strings never influence the decision (an emailed-link token is not read): the same path is decided identically with any query', () => {
  for (const [p, d] of [['/auth/callback', 'allow'], ['/browse', 'block'], ['/api/hacks', 'block']] as const) for (const s of ['', 'type=invite&token_hash=abc', 'next=/admin', 'x=%2e%2e']) assert.equal(kind('GET', p, s), d, `${p}?${s}`);
});
test('headers: noindex, nosniff, no framing, same-origin referrer and resource policy, a CSP that forbids framing/plugins/third-party connections; HSTS and upgrade-insecure-requests only over HTTPS', () => {
  const h = previewHeaders(false), s = previewHeaders(true);
  assert.equal(h['x-robots-tag'], 'noindex, nofollow, noarchive'); assert.equal(h['x-content-type-options'], 'nosniff'); assert.equal(h['x-frame-options'], 'DENY'); assert.equal(h['referrer-policy'], 'same-origin');
  assert.equal(h['cross-origin-opener-policy'], 'same-origin'); assert.equal(h['cross-origin-resource-policy'], 'same-origin'); assert.match(h['permissions-policy'], /camera=\(\)/);
  for (const d of ["default-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'", "connect-src 'self'", "img-src 'self' data:"]) assert.ok(h['content-security-policy'].includes(d), d);
  assert.doesNotMatch(h['content-security-policy'], /\*|https?:|unsafe-eval|blob:/, 'no wildcard, no third-party origin, no eval');
  assert.equal(h['strict-transport-security'], undefined); assert.ok(!h['content-security-policy'].includes('upgrade-insecure-requests'));
  assert.equal(s['strict-transport-security'], 'max-age=15552000'); assert.ok(s['content-security-policy'].includes('upgrade-insecure-requests')); assert.ok(Object.isFrozen(h));
});

// ---- environment ---------------------------------------------------------------------------------------------------------------------------------------------
const SECRET = 'S'.repeat(40);
const pubKey = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url'), 'sig-sig-sig-sig'].join('.');
const prod = (over: Record<string, string | undefined> = {}) => ({ APP_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://proj.example.test', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: pubKey, APP_ORIGIN: 'https://pilot.example.test',
  CURSOR_SIGNING_SECRET: SECRET, AUTH_THROTTLE_SECRET: SECRET, AUTH_SETUP_MARKER_SECRET: SECRET, TRUSTED_PROXY_HOPS: '1', EDGE_LOCK_SECRET: SECRET, ...over });
const issues = (src: Record<string, string | undefined>) => { try { loadEnv(src); } catch (e) { assert.ok(e instanceof EnvError); return e.issues.map((i) => i.name); } return [] as string[]; };
test('private-preview environment: a clean configuration loads; each forbidden name (service-level key, worker URL, database URL, legacy URL) is refused BY NAME, never by value', () => {
  assert.doesNotThrow(() => loadEnv(prod())); assert.doesNotThrow(() => loadEnv(prod({ APP_ENV: 'staging' })));
  for (const n of PREVIEW_FORBIDDEN_NAMES) { const bad = issues(prod({ [n]: 'x'.repeat(30) })); assert.ok(bad.includes(n), `${n} must be refused`); }
  const fake = ['THE', 'SECRET', 'VALUE', '1234567890123456'].join('-');   // assembled at run time: no credential-shaped literal in the file
  const err = (() => { try { loadEnv(prod({ SUPABASE_SERVICE_ROLE_KEY: fake })); } catch (e) { return e as EnvError; } return null; })();
  assert.ok(err && !err.message.includes(fake) && !JSON.stringify(err.issues).includes(fake), 'values never appear in the error');
  assert.ok(issues(prod({ SUPABASE_SERVICE_KEY: 'x'.repeat(30) })).includes('SUPABASE_SERVICE_KEY'), 'the legacy tolerance does not apply in preview mode');
  assert.ok(issues(prod({ APP_ENV: undefined })).includes('APP_ENV'), 'an unset APP_ENV is an error, and the gate is closed');
});
test('private-preview requirements: the throttle and marker secrets and a declared client-address source are mandatory; PREVIEW_GATE is validated', () => {
  assert.ok(issues(prod({ AUTH_THROTTLE_SECRET: undefined })).includes('AUTH_THROTTLE_SECRET')); assert.ok(issues(prod({ AUTH_SETUP_MARKER_SECRET: undefined })).includes('AUTH_SETUP_MARKER_SECRET'));
  assert.ok(issues(prod({ TRUSTED_PROXY_HOPS: undefined })).includes('TRUSTED_CLIENT_IP_HEADER'), 'no client-address source would put every tester in one bucket');
  assert.doesNotThrow(() => loadEnv(prod({ TRUSTED_PROXY_HOPS: undefined, TRUSTED_CLIENT_IP_HEADER: 'x-real-ip' })));
  assert.ok(issues(prod({ PREVIEW_GATE: 'off' })).includes('PREVIEW_GATE'), 'the gate cannot be switched off in production'); assert.ok(issues(prod({ PREVIEW_GATE: 'maybe' })).includes('PREVIEW_GATE'));
  const local = { APP_ENV: 'local', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: pubKey, APP_ORIGIN: 'http://localhost:3000', CURSOR_SIGNING_SECRET: SECRET };
  assert.doesNotThrow(() => loadEnv(local), 'local development is unchanged'); assert.doesNotThrow(() => loadEnv({ ...local, PREVIEW_GATE: 'off' }));
  assert.ok(issues({ ...local, PREVIEW_GATE: 'on' }).includes('AUTH_THROTTLE_SECRET'), 'PREVIEW_GATE=on applies the preview rules locally (used by the local verification)');
  assert.doesNotThrow(() => loadEnv({ ...local, SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(30), SUPABASE_URL: 'https://x.example.test' }), 'local development still tolerates the legacy names (warning only)');
});

// ---- wiring and source ---------------------------------------------------------------------------------------------------------------------------------
test('NO proxy.ts / middleware.ts: Next.js buffers every request body in memory when one exists, which would defeat the streaming body limit and the 3-second deadline of the Auth and saved-work handlers', () => {
  for (const f of ['proxy.ts', 'proxy.js', 'middleware.ts', 'middleware.js', 'src/proxy.ts', 'src/middleware.ts']) assert.ok(!existsSync(join(root, f)), `${f} must not exist`);
  const cfg = code('next.config.js'); assert.match(cfg, /gateConfig\(/); assert.match(cfg, /beforeFiles: \[\.\.\.gate\.rewrites\]/); assert.match(cfg, /async redirects\(\)/); assert.match(cfg, /env: \{ PX_BUILT_GATE: gateMode, PX_BUILT_EDGE_LOCK:/); assert.match(cfg, /gateConfig\([^)]*edgeLock\)/);
  assert.doesNotMatch(cfg, /proxyClientMaxBodySize/);
});
test('built rules: the rewrite allowlist is generated from the SAME sources as decidePath (so they cannot drift), the image rule is limited to the preview\'s artwork, `/` redirects (307), headers exclude /auth/** for the page-only set', () => {
  const g = gateConfig(false);
  const block = g.rewrites[1]; assert.equal(block.destination, '/gate-blocked'); for (const s of ALLOWED_SOURCES) assert.ok(block.source.includes(s), `allowlist source missing from the rewrite: ${s}`); assert.match(block.source, /^\/:gate\(\(\?!\(\?:gate-blocked\|/);
  // the rewrite's negative lookahead, evaluated as a regex, agrees with decidePath on a broad set of paths (`/gate-blocked` itself is excluded from the rule so it cannot loop; it answers 404 directly)
  const re = new RegExp(`^/(${block.source.slice('/:gate('.length, -1)})$`);
  for (const p of ['/lab', '/lab/x', '/spark', '/spark/demo/a', '/spark/demo/a/b', '/browse', '/api/hacks', '/auth/login', '/auth/sign-in', '/work/prompts', '/work/prompts/x/y', '/mascot.png', '/mascot.PNG', '/hack/hack-official.png', '/hack/12', '/_next/static/a/b.js', '/health', '/x', '/.env', '/account/prompts/x', '/account/sign-up'])
    assert.equal(re.test(p), decidePath('GET', p, q()).kind === 'block', `rewrite and decidePath disagree on ${p}`);
  const img = g.rewrites[0]; assert.equal(img.source, '/_next/image'); assert.equal(img.missing?.[0].key, 'url'); const imgRe = new RegExp(`^${img.missing![0].value}$`);
  for (const a of PUBLIC_ASSETS) assert.ok(imgRe.test(a), a); for (const u of ['https://evil.example/x.png', '/hack/other.png', '//evil.example/x.png', '/hack/hack-official.png/../x']) assert.ok(!imgRe.test(u), u);
  assert.deepEqual(g.redirects, [{ source: '/', destination: '/spark', permanent: false }]);
  const base = g.headers[0], pages = g.headers[1]; assert.equal(base.source, '/:path*'); assert.match(pages.source, /\(\?!auth\(\?:\/\|\$\)\)/);
  const keys = (r: { headers: readonly { key: string }[] }) => r.headers.map((h) => h.key.toLowerCase());
  assert.deepEqual(keys(base).filter((k) => ['content-security-policy', 'x-frame-options', 'referrer-policy'].includes(k)), [], 'the email-link pages keep their own CSP, framing and referrer headers');
  assert.deepEqual(keys(pages).sort(), ['content-security-policy', 'referrer-policy', 'x-frame-options']);
  const https = gateConfig(true); assert.ok(https.headers[0].headers.some((h) => h.key === 'Strict-Transport-Security' && h.value === 'max-age=15552000')); assert.ok(https.headers[1].headers.some((h) => h.value.includes('upgrade-insecure-requests')));
  assert.ok(!g.headers[0].headers.some((h) => h.key === 'Strict-Transport-Security') && !g.headers[1].headers.some((h) => h.value.includes('upgrade-insecure-requests')), 'only HTTPS builds send HSTS / upgrade-insecure-requests');
});
test('next.config.js, loaded the way Next loads it, builds the preview rules only in preview mode and keeps the open-mode headers otherwise', () => {
  const load = (env: Record<string, string>) => { const saved = { ...process.env }; for (const k of ['APP_ENV', 'PREVIEW_GATE', 'NEXT_DIST_DIR']) delete process.env[k]; Object.assign(process.env, env); try { const req = createRequire(import.meta.url); delete req.cache[req.resolve('../next.config.js')]; return req('../next.config.js'); } finally { process.env = saved; } };
  const open = load({ APP_ENV: 'local' }), preview = load({ APP_ENV: 'production' }), forced = load({ APP_ENV: 'local', PREVIEW_GATE: 'on' }), unset = load({});
  assert.equal(open.env.PX_BUILT_GATE, 'open'); assert.equal(preview.env.PX_BUILT_GATE, 'preview'); assert.equal(forced.env.PX_BUILT_GATE, 'preview'); assert.equal(unset.env.PX_BUILT_GATE, 'preview', 'an unset APP_ENV fails closed');
  return Promise.all([open.rewrites(), preview.rewrites(), preview.redirects(), open.redirects(), open.headers(), preview.headers(), forced.headers()]).then(([ro, rp, dp, dopen, ho, hp, hf]) => {
    assert.deepEqual(ro, []); assert.equal(rp.beforeFiles.length, 2); assert.equal(dp.length, 1); assert.deepEqual(dopen, []); assert.ok(ho.length >= 1 && ho.every((r: { headers: { key: string }[] }) => !r.headers.some((h) => h.key === 'X-Robots-Tag')), 'open mode keeps the old headers only');
    assert.ok(hp.some((r: { headers: { key: string; value: string }[] }) => r.headers.some((h) => h.key === 'Strict-Transport-Security')), 'a production build sends HSTS'); assert.ok(!hf.some((r: { headers: { key: string }[] }) => r.headers.some((h) => h.key === 'Strict-Transport-Security')), 'a local build with the gate forced on does not');
  });
});
test('/gate-blocked answers every method with the same uniform 404', async () => {
  const mod = await import('../app/gate-blocked/route.ts');
  for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) { const r = (mod[m] as () => Response)(); assert.equal(r.status, 404, m); assert.equal(await r.text(), 'Not found'); assert.equal(r.headers.get('cache-control'), 'no-store'); }
});
test('public/: exactly the files the preview serves are allowlisted, and every static asset the new UI references is allowed', () => {
  const pub = walk('public').map((f) => '/' + f.slice('public/'.length)).filter((f) => !f.endsWith('.DS_Store')).sort();
  for (const a of PUBLIC_ASSETS) assert.ok(pub.includes(a), `${a} must exist in public/`);
  const refs = walk('src/ui').filter((f) => /\.(tsx|ts|css)$/.test(f)).flatMap((f) => [...readFileSync(join(root, f), 'utf8').matchAll(/["'(`](\/(?:hack|mascot|default)[A-Za-z0-9_./-]*\.(?:png|svg|jpg|webp))/g)].map((m) => m[1]));
  for (const r of refs) assert.ok(PUBLIC_ASSETS.includes(r), `${r} is referenced by the UI but not served by the preview`);
});
test('health and robots: /health touches no database or user data and reports only readiness and a process id; /robots.txt disallows everything', async () => {
  const h = code('app/health/route.ts'); assert.match(h, /getEnv\('web'\)/); assert.match(h, /runtimeGateMode\(\) === 'preview' && built !== 'preview'/); assert.doesNotMatch(h, /supabase|cookies|headers\(|fetch\(|createUserDb|createPublicDb|serverDb/, 'no data access'); assert.match(h, /'cache-control': 'no-store'/);
  const r = (await import('../app/robots.ts')).default(); assert.deepEqual(r.rules, { userAgent: '*', disallow: '/' });
});
test('the email-link and same-origin protections are untouched: the Auth routes still go through authRoute, the callback GET still never calls the provider, the Origin check is unchanged', () => {
  assert.match(code('app/auth/callback/route.ts'), /authRoute\(/); assert.doesNotMatch(code('app/auth/callback/route.ts'), /\.auth\.|ctx\.db|verifyOtp/);
  assert.match(code('src/platform/http/origin.ts'), /origin !== appOrigin\) throw new AppError\('forbidden'/);
  for (const f of walk('app/auth').filter((x) => /route\.ts$/.test(x))) assert.match(code(f), /authRoute\(/, f);
});

test('ORIGIN LOCK: with a secret the first rewrite refuses everything (except /health) that does not carry the exact edge header; without one the rules are unchanged; a malformed secret is refused at build time', () => {
  const secret = 'L'.repeat(40);
  const base = gateConfig(true), locked = gateConfig(true, secret);
  assert.equal(locked.rewrites.length, base.rewrites.length + 1); assert.deepEqual(locked.rewrites.slice(1), base.rewrites, 'only one rule is added, in front');
  const r = locked.rewrites[0]; assert.equal(r.destination, '/gate-blocked'); assert.equal(r.missing?.[0].type, 'header'); assert.equal(r.missing?.[0].key, EDGE_LOCK_HEADER); assert.equal(r.missing?.[0].value, `^${secret}$`);
  const re = new RegExp(`^/(${r.source.slice('/:gate('.length, -1)})$`); assert.ok(!re.test('/health'), '/health is exempt (the host\'s own health check)'); for (const p of ['/lab', '/auth/callback', '/work/prompts', '/mascot.png', '/_next/static/x.js', '/browse', '/spark/demo/a']) assert.ok(re.test(p), p);
  assert.doesNotMatch(JSON.stringify(base), new RegExp(EDGE_LOCK_HEADER), 'no lock rule without a secret');
  for (const bad of ['', 'short', 'x'.repeat(31), 'x'.repeat(129), 'has space ' + 'x'.repeat(30), 'dot.' + 'x'.repeat(30), 'x'.repeat(30) + '$(', 'a|b' + 'x'.repeat(30)]) assert.throws(() => gateConfig(true, bad), /EDGE_LOCK_SECRET/, JSON.stringify(bad).slice(0, 20));
  assert.ok(EDGE_LOCK_SECRET_PATTERN.test(secret) && !EDGE_LOCK_SECRET_PATTERN.test('x'.repeat(31)));
});
test('ORIGIN LOCK in the environment: mandatory and well-formed in staging/production (the value is only checked, never printed); optional for a local gate; /health also requires the built lock', () => {
  assert.ok(issues(prod({ EDGE_LOCK_SECRET: undefined })).includes('EDGE_LOCK_SECRET'), 'required in production'); assert.ok(issues(prod({ APP_ENV: 'staging', EDGE_LOCK_SECRET: undefined })).includes('EDGE_LOCK_SECRET'), 'required in staging');
  for (const bad of ['short', 'bad chars here ' + 'x'.repeat(30), 'x'.repeat(200)]) assert.ok(issues(prod({ EDGE_LOCK_SECRET: bad })).includes('EDGE_LOCK_SECRET'), bad.slice(0, 12));
  const err = (() => { try { loadEnv(prod({ EDGE_LOCK_SECRET: 'bad value with spaces and a-long-enough-length-1234567890' })); } catch (e) { return e as EnvError; } return null; })(); assert.ok(err && !err.message.includes('bad value'), 'the value never appears');
  const local = { APP_ENV: 'local', PREVIEW_GATE: 'on', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: pubKey, APP_ORIGIN: 'http://localhost:3000', CURSOR_SIGNING_SECRET: SECRET, AUTH_THROTTLE_SECRET: SECRET, AUTH_SETUP_MARKER_SECRET: SECRET, TRUSTED_CLIENT_IP_HEADER: 'x-test-client-ip' };
  assert.doesNotThrow(() => loadEnv(local), 'a local gate does not need the lock'); const h = code('app/health/route.ts'); assert.match(h, /edgeLockRequired\(\) && lock !== 'on'/);
});
