// M01-A containment checks. Run: npm test  (Node >= 22.18 / 25 strips TS types natively)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const load = (f: string) => import(pathToFileURL(join(root, f)).href);

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (name === 'route.ts') out.push(p);
  }
  return out;
}
const files = routeFiles(join(root, 'app/api'));
const rel = (p: string) => relative(root, p);

// Routes that must be fully disabled (every exported method is the 503 stub).
const FULLY_DISABLED = [
  'app/api/auth/login/route.ts',
  'app/api/auth/signup/route.ts',
  'app/api/follow/[userId]/route.ts',
  'app/api/admin/hacks/route.ts',
  'app/api/admin/hacks/[id]/approve/route.ts',
  'app/api/admin/extract-url/route.ts',
  'app/api/hacks/[hackId]/validate/route.ts',
  'app/api/hacks/[hackId]/like/route.ts',
  'app/api/hacks/[hackId]/bookmark/route.ts',
  'app/api/me/profile/route.ts',
];
// Mutating methods that remain exported only as 503 stubs in otherwise-readable routes.
const STUBBED_MUTATIONS = ['app/api/hacks/route.ts', 'app/api/hacks/[hackId]/comments/route.ts'];

const MUTATION = /^export\s+(?:async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/gm;

test('disabled routes return 503 with zero database or outbound calls', async () => {
  const realFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error('outbound call attempted'); }) as typeof fetch;
  try {
    for (const f of FULLY_DISABLED) {
      const src = readFileSync(join(root, f), 'utf8');
      assert.ok(!/@supabase\/supabase-js|createClient|process\.env|from\s+['"]/.test(src), `${f} must not import anything or read env`);
      const mod = await load(f);
      const methods = Object.keys(mod).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k));
      assert.ok(methods.length > 0, `${f} exports no handlers`);
      for (const m of methods) {
        const req = new Request('http://localhost/x', { method: m, body: m === 'GET' ? undefined : JSON.stringify({ url: 'http://169.254.169.254/', email: 'demo@hackass.com', password: 'demo123', approved: true }), headers: { authorization: 'Bearer anything' } });
        const res = await mod[m](req, { params: Promise.resolve({ id: 'x', hackId: 'x', userId: 'x' }) });
        assert.equal(res.status, 503, `${f} ${m}`);
        const body = await res.json();
        assert.equal(body.error, 'temporarily_unavailable');
        assert.equal('token' in body || 'user' in body, false, `${f} ${m} leaked auth fields`);
      }
    }
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = realFetch; }
});

test('demo credentials are gone and issue no token', async () => {
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/demo123|demo@hackass\.com/.test(src), `${rel(f)} contains demo credentials`);
  }
  const { POST } = await load('app/api/auth/login/route.ts');
  const res = await POST(new Request('http://localhost/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'demo@hackass.com', password: 'demo123' }) }));
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.token, undefined);
});

test('no mutating export can fall through: every mutation is a disabled stub', () => {
  for (const f of files) {
    const r = rel(f);
    const src = readFileSync(f, 'utf8');
    const methods = [...src.matchAll(MUTATION)].map((m) => m[1]);
    if (methods.length === 0) continue;
    if (FULLY_DISABLED.includes(r)) continue; // covered by the runtime test above
    assert.ok(STUBBED_MUTATIONS.includes(r), `${r} exports ${methods} but is not in the reviewed disabled lists`);
    for (const m of methods) {
      const body = src.slice(src.search(new RegExp(`export\\s+async\\s+function\\s+${m}\\b`)));
      assert.ok(/^export async function \w+\(\)\s*\{\s*return Response\.json\(\s*\{ error: 'temporarily_unavailable'/.test(body), `${r} ${m} is not a fail-closed stub`);
      assert.ok(/status: 503/.test(body.split('\n').slice(0, 8).join('\n')), `${r} ${m} missing 503`);
    }
  }
});

test('.env is not tracked and ignore rules cover it', () => {
  const tracked = execFileSync('git', ['ls-files', '.env', '.env.local'], { cwd: root }).toString().trim();
  assert.equal(tracked, '');
  const ig = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.ok(/^\.env$/m.test(ig) && /^!\.env\.example$/m.test(ig));
  const ex = readFileSync(join(root, '.env.example'), 'utf8');
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}|sb_secret_|sb_publishable_[A-Za-z0-9]{10,}/.test(ex), '.env.example must hold placeholders only');
});
