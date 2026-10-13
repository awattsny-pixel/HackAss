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
  assert.deepEqual(runs.filter((r) => /^npm (ci|run|test)/.test(r!)).map((r) => r!.replace(' --ignore-scripts', '')), ['npm ci', 'npm run scan:gitleaks', 'npm run scan:secrets', 'npm run lint', 'npm run typecheck', 'npm test', 'npm run build', 'npm run smoke']);
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

test('the CLI version is pinned identically in CI and in scripts/supabase-cli-pin.json, and CI runs the local Auth checks between the pgTAP tests and the stop step', () => {
  const pinFile = JSON.parse(read('scripts/supabase-cli-pin.json'));
  const db = ci.jobs.database.steps;
  assert.equal(db.find((s) => s.uses?.startsWith('supabase/setup-cli'))!.with?.version, pinFile.version);
  assert.match(read('supabase/config.toml'), new RegExp(`CLI ${pinFile.version.replace(/\./g, '\\.')}`));
  const i = (pred: (s: Step) => boolean) => db.findIndex(pred);
  const spikes = i((s) => /local-auth-spikes\.mjs/.test(s.run ?? '')), f2a = i((s) => /local-f2a-checks\.mjs/.test(s.run ?? ''));
  assert.ok(i((s) => s.run === 'supabase test db') < spikes && spikes < f2a && f2a < i((s) => /^supabase stop/.test(s.run ?? '')), 'pgTAP, then the Auth checks, then the F2-A authority checks, then stop');
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

test('pgTAP platform test exists and checks the real stack (roles, Auth sessions table, extensions); the F2-A schema is applied only through migrations', () => {
  const sql = read('supabase/tests/database/000_platform.test.sql');
  for (const needle of ["has_role('anon'", "has_role('authenticated'", "has_role('service_role'", "has_table('auth', 'sessions'", "'pg_trgm'", "'citext'", 'select plan(9)']) assert.ok(sql.includes(needle), needle);
  assert.equal((sql.match(/^select (has_|ok)/gm) ?? []).length, 9, 'plan count must match the assertions');
  assert.deepEqual(readdirSync(join(root, 'supabase/migrations')).filter((f) => f !== '.gitkeep').map((f) => f.replace(/^\d{14}_/, '')), ['f2a_roles_and_schemas.sql', 'f2a_identity_and_staff.sql', 'f2a_authorization_guards.sql', 'f2b_content_tables.sql', 'f2b_canonical_hash.sql', 'f2b_immutability.sql', 'f2b_content_rpc.sql'], 'only the F2-A and F2-B migrations exist (checked in detail by f2a-migrations.test.ts)');
});

test('db:test reports BLOCKED (exit 2) with an actionable message when Docker is unavailable, never a silent pass', () => {
  const r = spawnSync(process.execPath, ['scripts/db-test.mjs'], { cwd: root, encoding: 'utf8', env: { PATH: '/nonexistent', HOME: process.env.HOME ?? '', DOCKER_BIN: '/nonexistent/docker', SUPABASE_BIN: '/nonexistent/supabase' } }); // explicit overrides keep this hermetic even on a machine that has Docker Desktop installed
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

test('the in-repo secret scanner is labelled supplementary in CI, and Gitleaks (pinned) is the primary scan', () => {
  const names = ci.jobs.verify.steps.map((st) => (st as { name?: string }).name ?? '');
  assert.ok(names.some((n) => /^Secret scan \(Gitleaks/.test(n)));
  assert.ok(names.some((n) => /Secret scan \(in-repo scanner, supplementary\)/.test(n)));
  assert.ok(existsSync(join(root, 'docs/security/gitleaks.md')) && !existsSync(join(root, 'docs/proposals')));
});

test('docs/db/hashcanon-1.md names every hashed field in the order the implementation uses, and the golden-vector count matches', () => {
  const doc = read('docs/db/hashcanon-1.md');
  const order = ['category_slug', 'title', 'summary', 'outcome', 'difficulty', 'time_min_minutes', 'time_max_minutes', 'cost_min_cents', 'cost_max_cents', 'currency', 'estimate_basis', 'ai_requirement', 'limitations', 'steps', 'materials', 'requirements', 'tags', 'attributions', 'source_claims', 'assets'];
  const table = doc.slice(doc.indexOf('## The text'));
  let at = 0;
  for (const f of order) { const i = table.indexOf(f, at); assert.ok(i >= at, `${f} missing or out of order in the format table`); at = i; }
  const vectors = JSON.parse(read('tests/fixtures/hashcanon-vectors.json')).vectors.length;
  assert.match(doc, new RegExp(`\\(${vectors}\\)`), 'the document states the number of golden vectors');
  assert.match(read('docs/db/f2b-content.md'), /one lock rule|One lock rule/i);
});
