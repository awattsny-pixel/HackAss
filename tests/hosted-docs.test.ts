// Keeps the M-HOST preparation documents (docs/hosted) consistent with the repository they describe: the migration list, the CI workflow, the
// credential findings, the closeout corrections, and the rule that no secret or live target appears in them. These are documentation checks only;
// nothing here contacts a hosted system.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const hostedFiles = readdirSync(join(root, 'docs/hosted')).filter((f) => f.endsWith('.md'));
const workflowText = read('.github/workflows/ci.yml');
const workflow = yaml.load(workflowText) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, { 'runs-on': string; steps: Array<{ uses?: string; with?: Record<string, unknown> }> }> };

test('docs/hosted holds the five preparation documents and says nothing was executed', () => {
  assert.deepEqual(hostedFiles.sort(), ['README.md', 'approval-summary.md', 'ci-review.md', 'credential-retirement.md', 'staging-plan.md', 'verification-procedure.md']);
  assert.match(read('docs/hosted/README.md'), /Status: prepared, not executed/);
  assert.match(read('docs/hosted/README.md'), /No hosted system was contacted|no hosted system was contacted/);
});

test('no hosted preparation document contains a secret, a connection string with a password, a JWT, or a live project reference', () => {
  for (const f of hostedFiles) {
    const t = read(`docs/hosted/${f}`);
    assert.doesNotMatch(t, /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, `${f}: JWT-shaped value`);
    assert.doesNotMatch(t, /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@]+@/, `${f}: connection string with a password`);
    assert.doesNotMatch(t, /sb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}/, `${f}: Supabase key`);
    assert.doesNotMatch(t, /[a-z]{20}\.supabase\.co/, `${f}: a concrete project host`);
    assert.doesNotMatch(t.replaceAll('266ec02e4e55b91420d51dc8cf907c7b8ac4540e', ''), /\b[0-9a-f]{40}\b/, `${f}: a full commit-hash-sized hex string other than the accepted base commit (use the 7-character form for history references)`);
  }
});

test('the staging plan lists exactly the migration files, in filename order', () => {
  const files = readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
  const listed = [...read('docs/hosted/staging-plan.md').matchAll(/^\d+\. `(\d{14}_[a-z0-9_]+\.sql)`$/gm)].map((m) => m[1]);
  assert.deepEqual(listed, files);
  assert.equal(files.length, 21);
});

test('the staging plan fixes the database major version, the exposed schema and the worker connection method from the repository configuration', () => {
  const plan = read('docs/hosted/staging-plan.md');
  const toml = read('supabase/config.toml');
  assert.match(toml, /^major_version = 17$/m);
  assert.match(plan, /Postgres major version \| \*\*17\*\*/);
  assert.match(plan, /\*\*`api` only\*\*/);
  assert.match(plan, /hackass_worker\.<project-ref>/);
  assert.match(plan, /transaction mode/);
  assert.match(plan, /session mode/);
  assert.match(toml, /^jwt_expiry = 600$/m);
  assert.match(plan, /\*\*600 s\*\*/);
  assert.match(plan, /created without a password/i);
});

test('every hosted check is classified read-only or mutating, and the forbidden-against-staging list names the local destructive tooling', () => {
  const doc = read('docs/hosted/verification-procedure.md');
  const ids = [...doc.matchAll(/^### (H\d+)\./gm)].map((m) => m[1]);
  assert.deepEqual(ids, Array.from({ length: 15 }, (_, i) => `H${i}`));
  const summary = doc.slice(doc.indexOf('## 3. Summary of classifications'), doc.indexOf('## 4. Order and gating'));
  for (const id of ids) {
    const rows = summary.split('\n').filter((l) => new RegExp(`^\\| ${id}[ab]? `).test(l));
    const row = rows[0];
    assert.ok(rows.every((r) => /read-only|mutating|local/.test(r)), `${id} has an unclassified row`);
    assert.ok(row, `${id} is missing from the classification table`);
    assert.match(row!, /read-only|mutating|local/, `${id} has no classification`);
  }
  const body = doc.slice(doc.indexOf('## 2. Checks'), doc.indexOf('## 3. Summary'));
  for (const section of body.split(/^### /m).slice(1)) assert.match(section, /read-only|Read-only|mutating|Mutating|\(local\)/, `check section without a classification: ${section.slice(0, 30)}`);
  const forbidden = doc.slice(doc.indexOf('## 1. Forbidden against staging'), doc.indexOf('## 2. Checks'));
  for (const needle of ['supabase db reset', 'supabase stop --no-backup', 'scripts/local-f2*-checks.mjs', 'supabase/rollbacks/', 'supabase link', 'R6, R7, R8']) assert.ok(forbidden.includes(needle), needle);
  assert.match(doc, /FORBIDDEN_PROJECT_REFS/);
});

test('the hosted procedure never instructs a local destructive command against staging: such commands appear only in the forbidden list', () => {
  const doc = read('docs/hosted/verification-procedure.md');
  const outsideForbidden = doc.replace(doc.slice(doc.indexOf('## 1. Forbidden against staging'), doc.indexOf('## 2. Checks')), '');
  for (const bad of ['supabase db reset', 'supabase stop', 'db push --linked', 'supabase link', 'rollbacks/20']) {
    for (const line of outsideForbidden.split('\n')) if (line.includes(bad)) assert.match(line, /alternative|writes the project reference|never|not |forbidden|Forbidden/i, `unexpected use of "${bad}": ${line.slice(0, 100)}`);
  }
});

test('the CI review matches the workflow: triggers, permissions, action references, runtime versions and the absence of secrets and deployment steps', () => {
  const review = read('docs/hosted/ci-review.md');
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const uses = [...new Set(Object.values(workflow.jobs).flatMap((j) => j.steps.map((s) => s.uses).filter(Boolean)))] as string[];
  assert.ok(uses.length >= 3);
  for (const u of uses) assert.ok(review.includes(u.split('@')[0]) && review.includes(`@${u.split('@')[1]}`), `the review does not mention ${u}`);
  for (const u of uses) assert.match(u, /@v\d+$/, `${u} is unexpectedly pinned differently from the reviewed tag form (update ci-review.md)`);
  assert.ok(Object.values(workflow.jobs).every((j) => j['runs-on'] === 'ubuntu-latest'));
  assert.match(review, /ubuntu-latest/);
  assert.match(review, /22\.23\.3/);
  assert.equal(read('.nvmrc').trim(), '22.23.3');
  assert.match(review, /2\.120\.0/);
  assert.doesNotMatch(workflowText.replace(/^\s*#.*$/gm, ''), /secrets\.|vars\.|environment:|deploy|id-token|contents: write|packages: write|upload-artifact|gh release|git push/i);
  assert.match(review, /every branch and every tag/);
  for (const q of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']) assert.ok(review.includes(`| ${q} |`), q);
  assert.match(review, /plausible and must be treated as likely/);
});

test('the deployment-trigger evidence quoted in the CI review still exists in the repository', () => {
  assert.match(read('SETUP_COMPLETE.md'), /Vercel auto-deploys on git push/);
  assert.equal(read('README.md').split('\n')[0], '// Deployment trigger');
  assert.match(read('PROJECT_STATUS.md'), /Frontend: Vercel/);
});

test('the credential-retirement document covers every baselined finding without containing a value', () => {
  const doc = read('docs/hosted/credential-retirement.md');
  const ignore = read('.gitleaksignore').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.equal(ignore.length, 6);
  for (const l of ignore) {
    const [commit, file, rule] = l.split(':');
    assert.ok(doc.includes(`${commit.slice(0, 7)}`), `the document does not cover the finding in ${commit.slice(0, 7)}`);
    assert.ok(doc.includes(file), `the document does not name ${file}`);
    assert.ok(rule.length > 0);
  }
  for (const needle of [/never contains, copies, prints or tests an exposed value/, /A clean secret scan is not proof of retirement/, /Rewriting git history does not retire a credential/, /service_role/, /database password/]) assert.match(doc, needle);
});

test('the approval summary names the base commit, the proposed remote branch, the unresolved dependencies, cost, cleanup and per-step authorization', () => {
  const doc = read('docs/hosted/approval-summary.md');
  for (const needle of [/266ec02e4e55b91420d51dc8cf907c7b8ac4540e/, /mhost1-ci-first-run/, /refs\/heads\/mhost1-ci-first-run/, /Deployment integration on push/, /Expected cost/, /Cleanup responsibilities/, /separately authorizable/, /Nothing in this document is authorized/, /not yet identified; not created/]) assert.match(doc, needle);
  for (const u of ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8']) assert.ok(doc.includes(`| ${u} |`), u);
  for (const s of ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']) assert.ok(doc.includes(`| ${s} |`), s);
});

test('the three documentation corrections from the F2-F review are applied to the closeout', () => {
  const c = read('docs/foundation/f2-closeout.md');
  assert.match(c, /`npm test` 201\/201 at `266ec02`/);
  assert.doesNotMatch(c, /191\/191 \(plus new harness tests\)/);
  assert.match(c, /real-stack check `E4` in `scripts\/local-f2e-checks\.mjs`/);
  assert.match(c, /invoking the migration runner again applies nothing that the ledger already records/);
  assert.match(c, /not required to tolerate their raw SQL being executed twice/);
  assert.doesNotMatch(c, /replay-twice test/);
});
