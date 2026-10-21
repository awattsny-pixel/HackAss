// Source-level guarantees of the UX-08 build: no storage, no client-side database, no AI call, no writes, no script injection,
// and the server composition uses only the anonymous public read functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const walk = (d: string): string[] => readdirSync(join(root, d)).flatMap((n) => { const p = join(d, n); return statSync(join(root, p)).isDirectory() ? walk(p) : [p]; });
const ui = walk('src/ui/experience').filter((f) => /\.(ts|tsx)$/.test(f));
const routes = walk('app/(experience)').filter((f) => /\.(ts|tsx)$/.test(f));
const src = (f: string) => readFileSync(join(root, f), 'utf8');

test('experience UI uses no storage, cookies, raw HTML, network, database or env', () => {
  const banned = [/localStorage|sessionStorage|indexedDB|document\.cookie/, /dangerouslySetInnerHTML|innerHTML|eval\(|new Function/, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/, /supabase|process\.env|server-only/i, /anthropic|openai|api\.claude/i];
  for (const f of ui) for (const re of banned) assert.doesNotMatch(src(f), re, `${f} matches ${re}`);
});
test('experience routes contain no write path and no AI call', () => {
  for (const f of routes) {
    const s = src(f);
    assert.doesNotMatch(s, /\.(insert|update|upsert|delete)\(|\.from\(|service_role|SERVICE|export (async )?function (POST|PUT|PATCH|DELETE)/, f);
    assert.doesNotMatch(s, /anthropic|openai|fetch\(/i, f);
  }
  assert.equal(routes.some((f) => /route\.ts$/.test(f)), false, 'no route handlers');
});
test('the only server action is the read-only loadMore', () => {
  const actions = routes.filter((f) => /^'use server'|^"use server"/m.test(src(f)));
  assert.deepEqual(actions, ['app/(experience)/spark/actions.ts']);
  assert.deepEqual([...src(actions[0]).matchAll(/export async function (\w+)/g)].map((m) => m[1]), ['loadMore']);
});
test('server composition calls only the two anonymous read functions through the public client', () => {
  const s = src('app/(experience)/_server/catalog.ts');
  assert.match(s, /^import 'server-only'/m); assert.match(s, /createPublicDb/); assert.doesNotMatch(s, /createUserDb|createWorkerDb|service/i);
  const mod = src('src/modules/catalog/index.ts');
  assert.deepEqual([...new Set([...mod.matchAll(/'(list_public_hacks|get_public_hack)'/g)].map((m) => m[1]))].sort(), ['get_public_hack', 'list_public_hacks']);
  assert.doesNotMatch(mod, /\.from\(|insert|update\(|delete\(/);
});
test('no demo content is imported by the catalog path (no silent substitution)', () => {
  for (const f of ['src/ui/experience/SparkCatalog.tsx', 'app/(experience)/spark/page.tsx', 'app/(experience)/spark/catalog/[slug]/page.tsx', 'app/(experience)/_server/catalog.ts']) assert.doesNotMatch(src(f), /demo-hacks|DEMO_HACKS|findDemoHack/, f);
});
test('experience routes are noindex, and the legacy chrome (auth, third-party script) is not loaded on them', () => {
  assert.match(src('app/(experience)/layout.tsx'), /index: false/);
  const l = src('app/components/LegacyChrome.tsx');
  assert.match(l, /isExperiencePath\(pathname\)\) return <>\{children\}<\/>/);
  assert.doesNotMatch(src('app/layout.tsx'), /instagram|AuthProvider/);
});
test('disabled legacy routes stay disabled (this branch does not touch them)', () => {
  for (const f of walk('app/api').filter((x) => /route\.ts$/.test(x))) assert.doesNotMatch(src(f), /createUserDb|createPublicDb/, f);
});
