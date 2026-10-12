// Tooling consistency: lint/typecheck/test scripts, the declared Node runtime, and the CI definition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('scripts: lint is ESLint (next lint was removed in Next 16), typecheck is explicit', () => {
  assert.match(pkg.scripts.lint, /^eslint \./);
  assert.ok(!/next lint/.test(pkg.scripts.lint));
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit');
  assert.ok(pkg.scripts.test && pkg.scripts.smoke && pkg.scripts.build);
  assert.ok(existsSync(join(root, 'eslint.config.mjs')));
  assert.ok(pkg.devDependencies.eslint && pkg.devDependencies['eslint-config-next']);
});

test('runtime: .nvmrc is a full version that satisfies engines.node; CI reads .nvmrc', () => {
  const nvmrc = read('.nvmrc').trim();
  assert.match(nvmrc, /^\d+\.\d+\.\d+$/);
  const [maj, min] = nvmrc.split('.').map(Number);
  const m = String(pkg.engines.node).match(/^>=(\d+)\.(\d+)\.\d+ <(\d+)$/);
  assert.ok(m, `unexpected engines.node format: ${pkg.engines.node}`);
  const lowMaj = Number(m![1]), lowMin = Number(m![2]), highMaj = Number(m![3]);
  assert.ok(maj > lowMaj || (maj === lowMaj && min >= lowMin), '.nvmrc below engines floor');
  assert.ok(maj < highMaj, '.nvmrc at or above engines ceiling');
  // the test suite needs native TypeScript type-stripping
  assert.ok(lowMaj > 22 || (lowMaj === 22 && lowMin >= 18), 'engines floor must include native type stripping (>=22.18)');
  assert.match(read('.github/workflows/ci.yml'), /node-version-file:\s*\.nvmrc/);
});

test('CI: verification only, read-only permissions, no secrets, no deployment, npm ci, every gate present', () => {
  const ci = read('.github/workflows/ci.yml');
  const code = ci.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.match(code, /permissions:\s*\n\s+contents:\s*read/);
  assert.ok(!/secrets\./.test(code), 'workflow must not reference secrets');
  assert.ok(!/vercel|deploy|publish|release|environment:/i.test(code), 'workflow must not deploy');
  assert.match(code, /run:\s*npm ci/);
  for (const step of ['npm run lint', 'npm run typecheck', 'npm test', 'npm run build', 'npm run smoke']) assert.ok(code.includes(`run: ${step}`), `missing step: ${step}`);
  assert.ok(!/pull_request_target/.test(code));
  assert.ok(/timeout-minutes:/.test(code));
});

test('smoke harness: environment is constructed, never spread from process.env', () => {
  for (const f of ['tests/smoke/run.mjs', 'tests/smoke/harness.mjs']) {
    assert.ok(!/\.\.\.process\.env/.test(read(f)), `${f} spreads process.env`);
  }
  assert.ok(!/process\.env/.test(read('tests/smoke/harness.mjs').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'harness.mjs must not read process.env');
});
