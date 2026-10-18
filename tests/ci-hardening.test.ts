// The CI workflow's hardening, pinned by tests: every third-party action is a full commit SHA with its release named in a comment, the runner image
// is pinned, pushes are limited to the two named branches (pull requests are still checked), and the application job runs on both supported Node versions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f: string) => readFileSync(join(root, f), 'utf8');
type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = { name?: string; 'runs-on': string; strategy?: { 'fail-fast'?: boolean; matrix?: { 'node-version'?: string[] } }; steps: Step[] };
const text = read('.github/workflows/ci.yml');
const wf = yaml.load(text) as { on: { push?: { branches?: string[]; tags?: unknown; 'branches-ignore'?: unknown; paths?: unknown }; pull_request?: unknown; [k: string]: unknown }; jobs: Record<string, Job> };
const steps = (job: string) => wf.jobs[job].steps;

const EXPECTED = {
  'actions/checkout': { sha: '11d5960a326750d5838078e36cf38b85af677262', release: 'v4.4.0' },
  'actions/setup-node': { sha: '49933ea5288caeca8642d1e84afbd3f7d6820020', release: 'v4.4.0' },
  'supabase/setup-cli': { sha: '1dedf2c611547ede7232d26866dd3c56ab903bbb', release: 'v1.7.3' },
} as const;

test('every action reference is a full commit SHA, the exact reviewed one, with its release named in a comment', () => {
  const lines = text.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l));
  assert.equal(lines.length, 7); // checkout x3, setup-node x3, setup-cli x1
  for (const l of lines) {
    const m = l.match(/uses:\s*([\w.-]+\/[\w.-]+)@([0-9a-f]{40})\s+# (v[\d.]+)/);
    assert.ok(m, `not pinned to a SHA with a release comment: ${l.trim()}`);
    const exp = EXPECTED[m![1] as keyof typeof EXPECTED];
    assert.ok(exp, `unreviewed action ${m![1]}`);
    assert.equal(m![2], exp.sha, `${m![1]} is not the reviewed commit`);
    assert.equal(m![3], exp.release);
  }
  const all = Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.uses).filter(Boolean)) as string[];
  for (const u of all) assert.doesNotMatch(u, /@(v?\d+(\.\d+)*|main|master|latest)$/, `mutable reference: ${u}`);
  assert.equal(all.filter((u) => !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(u)).length, 0);
});

test('the runner image is pinned, never a -latest label', () => {
  for (const [name, job] of Object.entries(wf.jobs)) assert.equal(job['runs-on'], 'ubuntu-24.04', name);
  assert.doesNotMatch(text, /-latest/);
});

test('push runs only for main and the verification branch (no tags, no other branches); pull requests are still checked', () => {
  assert.deepEqual(Object.keys(wf.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(wf.on.push!.branches, ['main', 'mhost1-ci-first-run']);
  assert.equal(wf.on.push!.tags, undefined);
  assert.equal(wf.on.push!['branches-ignore'], undefined);
  assert.equal(wf.on.pull_request, null, 'pull_request is unfiltered');
  assert.doesNotMatch(text, /pull_request_target|workflow_dispatch|schedule:|workflow_run/);
  // the branch the approval summary proposes to push is exactly the non-main branch the workflow accepts
  const approval = read('docs/hosted/approval-summary.md');
  assert.ok(approval.includes('refs/heads/' + wf.on.push!.branches![1]));
});

test('the application job runs on both supported Node versions, one of which is .nvmrc; the other jobs stay on .nvmrc', () => {
  const v = wf.jobs.verify;
  assert.deepEqual(v.strategy?.matrix?.['node-version'], ['22.23.3', '24.21.0']);
  assert.equal(v.strategy?.['fail-fast'], false);
  assert.equal(read('.nvmrc').trim(), v.strategy!.matrix!['node-version']![0]);
  const setup = steps('verify').find((s) => s.uses?.startsWith('actions/setup-node'))!;
  assert.equal(setup.with?.['node-version'], '${{ matrix.node-version }}');
  assert.equal(setup.with?.['node-version-file'], undefined);
  assert.match(String(v.name), /Node \$\{\{ matrix\.node-version \}\}/);
  for (const job of ['database', 'server-boundary']) {
    const s = steps(job).find((x) => x.uses?.startsWith('actions/setup-node'))!;
    assert.equal(s.with?.['node-version-file'], '.nvmrc', job);
    assert.equal(wf.jobs[job].strategy, undefined, `${job} has no matrix`);
  }
});

test('hardening kept the gates: permissions read-only, no secrets, no deployment, the same verification steps in the application job', () => {
  const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.match(code, /permissions:\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(code, /secrets\.|vars\.|environment:|deploy|id-token/i);
  const runs = steps('verify').map((s) => s.run).filter(Boolean);
  for (const r of ['npm run scan:gitleaks', 'npm run scan:secrets', 'npm run lint', 'npm run typecheck', 'npm test', 'npm run build', 'npm run smoke']) assert.ok(runs.includes(r), r);
  assert.equal(steps('database').find((s) => s.uses?.startsWith('supabase/setup-cli'))!.with?.version, '2.120.0');
});
