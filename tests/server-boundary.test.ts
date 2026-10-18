// The production build-time boundary: server entry points import `server-only`, so Next.js fails the build if one is
// ever pulled into a Client Component. These tests check that the marker is on exactly the right files and that it
// really throws outside the server (react-server) condition. They complement the ESLint and import-graph checks in
// lint-boundaries.test.ts. The Node test runner itself runs with --conditions=react-server (see package.json), which
// turns the marker into a no-op ONLY inside the tests; the Next.js build does not do that for client code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const MARKER = /^import 'server-only';/m;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
}
const files = sourceFiles(join(root, 'src/platform')).map((p) => ({ rel: p.slice(root.length), text: readFileSync(p, 'utf8') }));
// comments and type-only imports (erased at build time, so they cannot pull server code into a bundle) are ignored
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/^import type [^;]*;$/gm, '').replace(/^export type [^;]*;$/gm, '');

test('the server-only entry points carry the marker, and the pure modules do not', () => {
  const marked = files.filter((f) => MARKER.test(f.text)).map((f) => f.rel).sort();
  assert.deepEqual(marked, ['src/platform/db/clients.ts', 'src/platform/db/index.ts', 'src/platform/env.ts', 'src/platform/http/handler.ts', 'src/platform/server.ts']);
});

test('any platform file that reads process.env, imports a database package, or imports a server-only module must itself be marked', () => {
  const marked = new Set(files.filter((f) => MARKER.test(f.text)).map((f) => f.rel));
  for (const f of files) {
    const c = code(f.text);
    const sensitive = /process\.env/.test(c) || /from\s+'(?:@supabase\/|pg['/])/.test(c) || /from\s+'(?:\.\.?\/)+(?:env|server)\.ts'/.test(c) || /from\s+'\.\/clients\.ts'/.test(c) || /from\s+'(?:\.\.?\/)+http\/handler\.ts'/.test(c) || /from\s+'\.\/handler\.ts'/.test(c);
    if (sensitive) assert.ok(marked.has(f.rel), `${f.rel} touches server-only material but is not marked`);
  }
  // the pure validation module stays free of both, so it can be tested without the runtime condition
  const pure = files.find((f) => f.rel === 'src/platform/env-validate.ts')!;
  assert.ok(!MARKER.test(pure.text) && !/process\.env/.test(code(pure.text)) && !/server-only/.test(code(pure.text)));
});

test('outside the server condition the marker throws; with it the module loads (so the build-time boundary is real)', () => {
  const probe = "import('./src/platform/env.ts').then(() => console.log('LOADED'), (e) => { console.log('THREW:' + e.message); });";
  const run = (flags: string[]) => spawnSync(process.execPath, [...flags, '--input-type=module', '-e', probe], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  const client = run([]);
  assert.match(client.stdout, /THREW:.*Client Component/, client.stdout + client.stderr);
  const server = run(['--conditions=react-server']);
  assert.match(server.stdout, /LOADED/, server.stdout + server.stderr);
});

test('the server-only package is a pinned exact dependency, and the test script runs with the react-server condition', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(pkg.dependencies['server-only'], /^\d+\.\d+\.\d+$/, 'pin server-only exactly');
  assert.match(pkg.scripts.test, /--conditions=react-server/);
});
