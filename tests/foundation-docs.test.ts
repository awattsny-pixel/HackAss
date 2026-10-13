// Keeps the local-stack workflow, CI definition and the foundation contract documents consistent with each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f: string) => readFileSync(join(root, f), 'utf8');
type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown>; if?: string };
const ci = yaml.load(read('.github/workflows/ci.yml')) as { permissions: Record<string, string>; jobs: Record<string, { steps: Step[]; 'timeout-minutes'?: number }> };

test('CI: verify job runs the secret scan before lint and every gate in order; database job uses the real local stack with a pinned CLI', () => {
  const runs = ci.jobs.verify.steps.map((s) => s.run).filter(Boolean);
  assert.deepEqual(runs.filter((r) => /^npm (ci|run|test)/.test(r!)).map((r) => r!.replace(' --ignore-scripts', '')), ['npm ci', 'npm run scan:secrets', 'npm run lint', 'npm run typecheck', 'npm test', 'npm run build', 'npm run smoke']);
  const db = ci.jobs.database.steps;
  const setup = db.find((s) => s.uses?.startsWith('supabase/setup-cli'));
  assert.ok(setup, 'database job must install the Supabase CLI');
  assert.match(String(setup!.with?.version), /^\d+\.\d+\.\d+$/, 'the CLI version must be pinned exactly');
  assert.equal(setup!.with?.version, '2.120.0');
  assert.ok(db.some((s) => /^supabase start/.test(s.run ?? '')) && db.some((s) => s.run === 'supabase test db'));
  assert.ok(db.some((s) => /^supabase stop/.test(s.run ?? '') && s.if === 'always()'), 'the stack must be stopped even when tests fail');
  assert.deepEqual(ci.permissions, { contents: 'read' });
  for (const job of Object.values(ci.jobs)) assert.ok(job['timeout-minutes'] && job['timeout-minutes'] <= 30);
});

test('local Supabase config carries the settings the design depends on', () => {
  const toml = read('supabase/config.toml');
  assert.match(toml, /^project_id = "hackass-local"$/m);
  assert.match(toml, /^jwt_expiry = 600$/m);
  const section = (name: string) => toml.slice(toml.indexOf(`[${name}]`)).split(/\n\[/)[0];
  assert.match(section('auth.email'), /enable_confirmations = true/);
  assert.match(section('auth.mfa.totp'), /enroll_enabled = true/);
  assert.match(section('auth.mfa.totp'), /verify_enabled = true/);
  assert.match(toml, /CLI 2\.120\.0/);
});

test('pgTAP platform test exists and checks the real stack (roles, Auth sessions table, extensions); no application schema is applied in F1', () => {
  const sql = read('supabase/tests/database/000_platform.test.sql');
  for (const needle of ["has_role('anon'", "has_role('authenticated'", "has_role('service_role'", "has_table('auth', 'sessions'", "'pg_trgm'", "'citext'", 'select plan(9)']) assert.ok(sql.includes(needle), needle);
  assert.equal((sql.match(/^select (has_|ok)/gm) ?? []).length, 9, 'plan count must match the assertions');
  assert.deepEqual(readdirSync(join(root, 'supabase/migrations')), ['.gitkeep'], 'F1 must not add migrations');
});

test('db:test reports BLOCKED (exit 2) with an actionable message when Docker is unavailable, never a silent pass', () => {
  const r = spawnSync(process.execPath, ['scripts/db-test.mjs'], { cwd: root, encoding: 'utf8', env: { PATH: '/nonexistent', HOME: process.env.HOME ?? '' } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^BLOCKED\s+Docker is not available/m);
});

test('the ADR records the five F2 invariants and the F2 acceptance contract has a test row for each', () => {
  const adr = read('docs/adr/0001-foundation.md');
  const acceptance = read('docs/foundation/f2-acceptance.md');
  for (const id of ['I-1', 'I-2', 'I-3', 'I-4', 'I-5']) assert.ok(adr.includes(`**${id} `), `ADR missing ${id}`);
  for (const id of ['I-1a', 'I-1b', 'I-1c', 'I-2', 'I-3', 'I-4a', 'I-4b', 'I-4c', 'I-5', 'S-1', 'S-2', 'S-3', 'H-1', 'P-1', 'R-1', 'G-1', 'G-2', 'G-3', 'G-4']) assert.match(acceptance, new RegExp(`\\| ${id} \\|`), `acceptance contract missing ${id}`);
  assert.match(adr.replace(/\s+/g, ' '), /not validated until the real Auth-flow tests pass/, 'the cookie approach must stay described as an experiment');
  assert.ok(existsSync(join(root, 'docs/spikes/f1-hosted-spikes.md')));
  assert.match(read('docs/spikes/f1-hosted-spikes.md'), /BLOCKED — no hosted staging project/);
});
