// PX-3b source-level guarantees for the saved-work handlers (live behaviour: scripts/px3b-local-checks.mjs against the real local stack with two members).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const walk = (d: string): string[] => readdirSync(join(root, d)).flatMap((n) => { const p = join(d, n); return statSync(join(root, p)).isDirectory() ? walk(p) : [p]; });
const files = walk('app/work');
const routes = files.filter((f) => /route\.ts$/.test(f));
const src = (f: string) => readFileSync(join(root, f), 'utf8');
const code = (f: string) => src(f).replace(/\/\/.*$/gm, '');
const EXPECTED: Record<string, string[]> = {
  'app/work/export/route.ts': ['GET'], 'app/work/prompts/route.ts': ['GET', 'POST'], 'app/work/prompts/[id]/route.ts': ['DELETE', 'GET', 'PUT'], 'app/work/prompts/[id]/results/route.ts': ['POST'],
  'app/work/results/route.ts': ['GET'], 'app/work/results/[id]/route.ts': ['DELETE', 'GET', 'PUT'], 'app/work/saves/route.ts': ['POST'],
};

test('the route set and methods are exactly the planned ones, each wrapped by workRoute', () => {
  assert.deepEqual([...routes].sort(), Object.keys(EXPECTED).sort());
  for (const f of routes) {
    const s = code(f);
    const methods = [...s.matchAll(/export const (\w+) = workRoute/g)].map((m) => m[1]).sort();
    assert.deepEqual(methods, EXPECTED[f], f);
    assert.deepEqual([...s.matchAll(/export (?:const|async function|function) (\w+)/g)].map((m) => m[1]).filter((n) => n !== 'dynamic').sort(), EXPECTED[f], `${f} exports only its handlers`);
    assert.match(s, /export const dynamic = 'force-dynamic'/, f);
  }
});
test('EVERY handler verifies the member (gate = T2) first, and writes are throttled; reads are not skipped', () => {
  for (const f of routes) {
    const s = code(f);
    for (const m of s.matchAll(/export const (GET|POST|PUT|DELETE) = workRoute(?:<[^>]*>)?\(async \(([^)]*)\) => \{\n([\s\S]*?)\n\}\);/g)) {
      const body = m[3];
      assert.match(body.split('\n')[0], new RegExp(`const refused = await gate\\(ctx, '\\w+', ${m[1] === 'GET' ? 'false' : 'true'}\\); if \\(refused\\) return refused;`), `${f} ${m[1]}: the first statement is the gate (writes pass write=true)`);
      assert.ok(body.indexOf('gate(') < body.indexOf('readJson(') || !body.includes('readJson('), `${f}: the gate comes before the body is read`);
      assert.ok(body.indexOf('gate(') < body.indexOf('workDb('), `${f}: the gate comes before any database call`);
    }
  }
  const kit = code('app/work/_server/kit.ts');
  assert.match(kit, /ctx\.resolve\('T2'\)/); assert.doesNotMatch(kit, /resolve\('T[01]'\)/, 'never a lower tier');
  assert.match(kit, /auth_unavailable[\s\S]{0,120}unavailableJson\(\)/, 'an Auth outage is a 503 that touches no cookie');
  assert.match(kit, /if \(write\)[\s\S]*writeThrottleFor[\s\S]*\.check\(/); assert.match(kit, /throttle_unconfigured/, 'a missing throttle secret fails closed');
});
test('no owner or service shortcut: handlers never read an owner/user id from the request and the application holds no service key', () => {
  for (const f of files) {
    const s = code(f);
    assert.doesNotMatch(s, /service_role|SERVICE|SECRET_KEY|admin\.auth|createBrowserClient|createClient|from ['"]@supabase|createWorkerDb|createPublicDb/, f);
    assert.doesNotMatch(s.replace(/'[^'\n]*'/g, "''"), /owner|searchParams\.get\(['"]?(user|owner)/i, `${f} reads no owner from the request`);
    for (const m of s.matchAll(/headers\.get\(([^)]*)\)/g)) assert.equal(m[1], "'content-type'", `${f} reads only the content type from request headers`);
  }
  assert.match(code('app/work/_server/kit.ts'), /ctx\.db\.client\.schema\('api'\)\.rpc\(fn, args\)/, 'the only database path is the member\'s cookie client, through the api schema');
  assert.doesNotMatch(code('src/modules/mywork/index.ts'), /owner_id|user_id|p_owner|p_user/, 'the module has no owner parameter');
});
test('bodies: JSON only, bounded while streaming, never request.json()/text()/formData()', () => {
  for (const f of files) assert.doesNotMatch(code(f), /request\.(json|text|formData|arrayBuffer|blob)\(\)|req\.(json|text)\(\)/, f);
  const kit = code('app/work/_server/kit.ts');
  assert.match(kit, /readBodyBounded\(request, maxBytes\)/); assert.match(kit, /!== 'application\/json'[\s\S]{0,80}bodyProblemJson\(415\)/);
  for (const f of ['app/work/prompts/route.ts', 'app/work/prompts/[id]/route.ts']) assert.match(src(f), /BODY_LIMITS\.prompt/, f);
  assert.match(src('app/work/prompts/[id]/results/route.ts'), /BODY_LIMITS\.result/); assert.match(src('app/work/saves/route.ts'), /BODY_LIMITS\.both/);
});
test('logs carry the operation name and outcome kind only: no request, body, header, cookie, id, title, prompt text, token or email', () => {
  for (const f of files) {
    const s = src(f); assert.doesNotMatch(s, /console\.(log|error|warn|info|debug)/, f);
    for (const m of s.matchAll(/\.log\.(?:info|warn|error)\(([^;]*)\);/g)) assert.doesNotMatch(m[1].replace(/'[^'\n]*'/g, "''"), /request|headers|cookie|body|token|email|password|\bid\b|title|prompt|reflection|\bp\b|\bq\b|json|\.value|\.data/i, `${f}: ${m[0].slice(0, 80)}`);
  }
});
test('every response is no-store; failures use the fixed contract; cookies are applied only after a definite outcome', () => {
  const kit = code('app/work/_server/kit.ts');
  assert.ok((kit.match(/NextResponse\.json\(/g) ?? []).length >= 6); for (const m of kit.matchAll(/NextResponse\.json\([^;]*\);/g)) assert.match(m[0], /NO_STORE/, m[0].slice(0, 70));
  assert.match(kit, /failureResponse\(f\.kind\)/);
  const authUnavailable = kit.slice(kit.indexOf("r.kind === 'auth_unavailable'"), kit.indexOf("r.kind === 'auth_unavailable'") + 160); assert.doesNotMatch(authUnavailable, /applyCookies/, 'an outage must not touch cookies');
});
