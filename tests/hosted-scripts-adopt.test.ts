// `adopt` carries the proven S6/S7 stages of an earlier run into a NEW run at a new commit, without repeating them and without touching the database. These tests use temporary run directories,
// stubbed ledger reads and stubbed git comparisons (nothing contacts a target and no migration can be applied): they prove it refuses a mismatched binding, changed migrations, an invalid source
// run and any ledger difference; that the source run is left byte-for-byte unchanged; that inherited evidence is recorded as INHERITED (never PASS) and the earlier failed exposure attempt is kept;
// and that the gates let the adopted run continue with exposure at the new commit and still refuse to repeat identity or migrate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const load = (f: string) => import(pathToFileURL(join(root, 'scripts/hosted', f)).href);
const adopt = await load('lib/adopt.mjs'); const stateLib = await load('lib/state.mjs'); const gates = await load('lib/gates.mjs'); const model = await load('lib/evidence-model.mjs'); const stagesLib = await load('lib/stages.mjs');

const OLD = 'a'.repeat(40); const NEW = 'b'.repeat(40); const TARGETS = 'c'.repeat(64); const REF = 'foptxhdnhudburqtnflt';
const VERSIONS = ['20261013130000', '20261013130100', '20261019090100'];
const MD5 = 'ee0f3300861a19ae1626276d51868b24';
const made: string[] = [];
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hs-adopt-')); chmodSync(d, 0o700); made.push(d); return d; };

const sourceState = (over: Record<string, unknown> = {}) => ({
  runId: 'stg-old-run1', profile: 'staging', fixtures: {}, intents: [], history: [],
  binding: { commit: OLD, profile: 'staging', targets: TARGETS, at: '2026-10-16T22:24:20.909Z' },
  stages: {
    preflight: { status: 'done', at: '2026-10-16T22:24:23.384Z', commit: OLD, passed: 2, failed: 0 },
    identity: { status: 'done', at: '2026-10-16T22:34:36.725Z', commit: OLD, passed: 1, failed: 0 },
    migrate: { status: 'done', at: '2026-10-16T22:34:42.477Z', commit: OLD, passed: 1, failed: 0 },
    exposure: { status: 'failed', at: '2026-10-16T22:51:33.177Z', commit: OLD, passed: 0, failed: 1 },
  },
  facts: { public_objects_before: 0, server_version: '17.11', jwks: 'ES256', ledger_md5_after_migrate: MD5 }, ...over,
});
const sourceResults = () => [
  { id: 'H0', status: 'PASS', title: 'targets', facts: 'ref x', ms: 0 }, { id: 'H1a', status: 'PASS', title: 'facts', facts: 'Postgres 17.11', ms: 2467 },
  { id: 'H1b', status: 'PASS', title: 'identity', facts: 'visible 1/1/1; removed (0)', ms: 3192 }, { id: 'H2a', status: 'PASS', title: 'migrate', facts: 'applied 3 of 3', ms: 5632 },
  { id: 'H2b', status: 'FAIL', title: 'exposure', error: 'OpenAPI description: HTTP 401', ms: 304 },
];
/** A source run on disk in a temporary base directory (never the real one). */
function writeSource(base: string, state: Record<string, unknown>, results: unknown[], id = 'stg-old-run1') {
  const dir = join(base, id); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, 'results.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  return dir;
}
type Inputs = { state?: Record<string, unknown>; results?: unknown[]; targetsHash?: string; head?: string; ref?: string; changed?: string[] | Error; live?: unknown; versions?: string[]; sourceId?: string };
async function attempt(i: Inputs = {}) {
  const base = tmp(); const newBase = tmp();
  const srcDir = writeSource(base, i.state ?? sourceState(), i.results ?? sourceResults());
  const before = { s: readFileSync(join(srcDir, 'state.json')), r: readFileSync(join(srcDir, 'results.jsonl')) };
  const run = stateLib.openRun({ runId: 'stg-new-run2', profile: 'staging', repoRoot: root, base: newBase });
  run.acquireLock(); run.initRedaction();
  const st = run.state(); st.binding = { commit: i.head ?? NEW, profile: 'staging', targets: i.targetsHash ?? TARGETS, at: 'now' }; st.stages = { adopt: { status: 'running' } }; run.save(st); // what runStage does before the body
  const lines: string[] = [];
  const out = await adopt.runAdoption({
    ctx: { targets: { ref: i.ref ?? REF } }, run, flags: { 'from-run': i.sourceId ?? 'stg-old-run1' }, profile: 'staging', git: { head: i.head ?? NEW, clean: true }, repoRoot: root, expectedRef: REF, say: (l: string) => lines.push(l), targetsHash: i.targetsHash ?? TARGETS,
    deps: {
      readSource: (id: string, profile: string) => adopt.readSourceRun(id, profile, { base }),
      changes: () => { if (i.changed instanceof Error) throw i.changed; return i.changed ?? []; },
      repoVersions: () => i.versions ?? VERSIONS,
      queryLedger: async () => (i.live === undefined ? { count: VERSIONS.length, versions: VERSIONS, md5: MD5 } : i.live),
    },
  });
  run.releaseLock();
  return { out, run, lines, srcDir, before, after: { s: readFileSync(join(srcDir, 'state.json')), r: readFileSync(join(srcDir, 'results.jsonl')) }, newState: run.state(), newResults: run.results() };
}
const failedIds = (a: { newResults: { id: string; status: string }[] }) => a.newResults.filter((r) => r.status === 'FAIL').map((r) => r.id);

test('a valid source run is adopted: stages inherited (not re-executed), results INHERITED, facts copied, the failed exposure attempt kept, the source untouched', async () => {
  const a = await attempt();
  assert.equal(a.out.failed, 0); assert.equal(a.out.passed, 4); // A1 to A4, each executed now
  for (const stage of ['preflight', 'identity', 'migrate']) {
    const s = a.newState.stages[stage];
    assert.equal(s.status, 'done'); assert.equal(s.commit, OLD, 'the commit it truly ran under is kept'); assert.deepEqual(s.inherited, { run: 'stg-old-run1', commit: OLD, adoptedAtCommit: NEW, note: 'inherited from the source run; not executed at this commit' });
  }
  assert.equal(a.newState.stages.exposure, undefined, 'a new exposure attempt is possible in the new run');
  assert.equal(a.newState.history.length, 1); const h = a.newState.history[0];
  assert.equal(h.stage, 'exposure'); assert.equal(h.status, 'failed'); assert.match(h.error, /OpenAPI description: HTTP 401/); assert.match(h.error, /inherited from run stg-old-run1/); assert.match(h.error, /kept, not cleared/);
  assert.equal(a.newState.facts.ledger_md5_after_migrate, MD5); assert.equal(a.newState.facts.inherited_from_run, 'stg-old-run1'); assert.equal(a.newState.facts.public_objects_before, 0);
  const inherited = a.newResults.filter((r: { status: string }) => r.status === 'INHERITED');
  assert.deepEqual(inherited.map((r: { id: string }) => r.id), ['H0', 'H1a', 'H1b', 'H2a']);
  assert.ok(inherited.every((r: { inherited: { originalStatus: string; adoptedAtCommit: string } }) => r.inherited.originalStatus === 'PASS' && r.inherited.adoptedAtCommit === NEW));
  assert.ok(!a.newResults.some((r: { id: string; status: string }) => ['H0', 'H1a', 'H1b', 'H2a'].includes(r.id) && r.status === 'PASS'), 'no inherited check is recorded as freshly passed');
  assert.deepEqual(a.newResults.filter((r: { id: string }) => /^A\d$/.test(r.id)).map((r: { id: string; status: string }) => `${r.id}:${r.status}`), ['A1:PASS', 'A2:PASS', 'A3:PASS', 'A4:PASS']);
  assert.ok(a.before.s.equals(a.after.s) && a.before.r.equals(a.after.r), 'the source run is byte-for-byte unchanged');
});
test('adoption without a failed exposure attempt (a source that stopped after migrate) is also accepted, with an empty history', async () => {
  const st = sourceState(); delete (st.stages as Record<string, unknown>).exposure;
  const a = await attempt({ state: st, results: sourceResults().filter((r) => r.id !== 'H2b') });
  assert.equal(a.out.failed, 0); assert.deepEqual(a.newState.history ?? [], []);
});

const refuses = async (label: string, i: Inputs, pattern: RegExp, ids: string[]) => {
  const a = await attempt(i);
  assert.ok(a.out.failed >= 1, `${label}: the stage fails`);
  assert.deepEqual(a.newState.stages.preflight, undefined, `${label}: nothing inherited`); assert.deepEqual(a.newState.history ?? [], [], `${label}: no history written`);
  assert.ok(failedIds(a).some((id: string) => ids.includes(id)), `${label}: failed check ${failedIds(a).join(',')} (expected one of ${ids.join(',')})`);
  assert.match(JSON.stringify(a.newResults), pattern, label);
  assert.ok(a.before.s.equals(a.after.s) && a.before.r.equals(a.after.r), `${label}: the source run is unchanged`);
};
test('refused: a different validated target configuration (target binding mismatch)', async () => { await refuses('targets', { targetsHash: 'd'.repeat(64) }, /target configuration differs/, ['A2']); });
test('refused: a different project reference', async () => { await refuses('project', { ref: 'someotherprojectref00' }, /project reference someotherprojectref00 is not the expected/, ['A2']); });
test('refused: the source run is bound to another profile', async () => {
  const st = sourceState(); (st.binding as { profile: string }).profile = 'selftest';
  await refuses('profile', { state: st }, /bound to the selftest profile/, ['A2']);
});
test('refused: migration files changed since the source commit', async () => { await refuses('changed', { changed: ['supabase/migrations/20261019090100_x.sql'] }, /migration files changed since the source commit: supabase\/migrations\/20261019090100_x\.sql/, ['A3']); });
test('refused: the source commit is unknown or git fails', async () => { await refuses('git', { changed: new (adopt.AdoptRefused)(['the source commit aaaaaaaaaaaa is not in this repository']) }, /not in this repository/, ['A3']); });
test('refused: the live ledger differs (count, versions or md5)', async () => {
  await refuses('count', { live: { count: 2, versions: VERSIONS.slice(0, 2), md5: MD5 } }, /not exactly the repository's 3 migrations/, ['A4']);
  await refuses('versions', { live: { count: 3, versions: ['20261013130000', '20261013130100', '20261019099999'], md5: MD5 } }, /not exactly the repository's 3 migrations/, ['A4']);
  await refuses('md5', { live: { count: 3, versions: VERSIONS, md5: 'f'.repeat(32) } }, /md5 differs from the one the source run recorded/, ['A4']);
  await refuses('no ledger', { live: { count: 0, versions: [], md5: '' } }, /live ledger/, ['A4']);
});
test('refused: the repository has a different migration list than the live ledger', async () => { await refuses('repo', { versions: [...VERSIONS, '20261020000000'] }, /not exactly the repository's 4 migrations/, ['A4']); });

const mutate = (f: (s: ReturnType<typeof sourceState>) => void) => { const s = sourceState(); f(s); return s; };
test('refused: invalid source-run state', async () => {
  const cases: [string, Inputs, RegExp][] = [
    ['same commit', { head: OLD }, /bound to this same commit/],
    ['closed', { state: mutate((s) => { (s as Record<string, unknown>).closed = true; }) }, /source run is closed/],
    ['no binding', { state: mutate((s) => { (s as Record<string, unknown>).binding = null; }) }, /no valid commit binding/],
    ['preflight not done', { state: mutate((s) => { s.stages.preflight.status = 'failed'; }) }, /source stage preflight is not done \(failed\)/],
    ['migrate absent', { state: mutate((s) => { delete (s.stages as Record<string, unknown>).migrate; }) }, /source stage migrate is not done \(absent\)/],
    ['stage under another commit', { state: mutate((s) => { s.stages.identity.commit = 'e'.repeat(40); }) }, /source stage identity was recorded under eeeeeeeeeeee/],
    ['failed checks', { state: mutate((s) => { s.stages.migrate.failed = 1; }) }, /migrate did not pass cleanly/],
    ['later stage present', { state: mutate((s) => { (s.stages as Record<string, unknown>)['worker-marker'] = { status: 'done', commit: OLD, passed: 1, failed: 0 }; }) }, /unexpected stage worker-marker/],
    ['exposure done', { state: mutate((s) => { s.stages.exposure.status = 'done'; }) }, /unexpected stage exposure \(done\)/],
    ['no ledger md5', { state: mutate((s) => { delete (s.facts as Record<string, unknown>).ledger_md5_after_migrate; }) }, /recorded no ledger md5/],
    ['fixtures present', { state: mutate((s) => { (s as Record<string, unknown>).fixtures = { users: { b1: {} } }; }) }, /fixtures or earlier attempts/],
    ['run id mismatch', { state: mutate((s) => { s.runId = 'stg-other-run9'; }) }, /names run stg-other-run9/],
    ['wrong profile', { state: mutate((s) => { s.profile = 'selftest'; }) }, /profile is selftest, not staging/],
    ['no PASS result', { results: sourceResults().filter((r) => r.id !== 'H2a') }, /no PASS for H2a/],
    ['result only FAIL', { results: sourceResults().map((r) => (r.id === 'H1b' ? { ...r, status: 'FAIL' } : r)) }, /no PASS for H1b/],
  ];
  for (const [label, input, pattern] of cases) await refuses(label, input, pattern, ['A1']);
});
test('refused: the source run is missing, malformed, locked or named like the new run', async () => {
  const base = tmp();
  assert.throws(() => adopt.readSourceRun('stg-missing-run', 'staging', { base }), /has no state\.json/);
  assert.throws(() => adopt.readSourceRun('BAD', 'staging', { base }), /must be a run id/);
  const dir = writeSource(base, sourceState(), sourceResults()); writeFileSync(join(dir, 'state.json'), '{ not json');
  assert.throws(() => adopt.readSourceRun('stg-old-run1', 'staging', { base }), /not valid JSON/);
  const d2 = writeSource(base, sourceState(), sourceResults(), 'stg-locked-run'); mkdirSync(join(d2, 'lock')); writeFileSync(join(d2, 'lock', 'owner.json'), JSON.stringify({ pid: process.pid, token: 't' }));
  assert.throws(() => adopt.readSourceRun('stg-locked-run', 'staging', { base }), /locked by a running process/);
  const a = await attempt({ sourceId: 'stg-new-run2' }); // the new run's own id as the source
  assert.ok(a.out.failed >= 1); assert.match(JSON.stringify(a.newResults), /source run and the new run are the same run|has no state\.json/);
});
test('refused: a new run that is not fresh', async () => {
  const base = tmp(); const newBase = tmp(); writeSource(base, sourceState(), sourceResults());
  const run = stateLib.openRun({ runId: 'stg-new-run2', profile: 'staging', repoRoot: root, base: newBase }); run.acquireLock(); run.initRedaction();
  const st = run.state(); st.stages = { adopt: { status: 'running' }, preflight: { status: 'done', commit: NEW, passed: 2, failed: 0 } }; run.save(st);
  const out = await adopt.runAdoption({ ctx: { targets: { ref: REF } }, run, flags: { 'from-run': 'stg-old-run1' }, profile: 'staging', git: { head: NEW }, repoRoot: root, expectedRef: REF, say: () => {}, targetsHash: TARGETS,
    deps: { readSource: (id: string, p: string) => adopt.readSourceRun(id, p, { base }), changes: () => [], repoVersions: () => VERSIONS, queryLedger: async () => ({ count: 3, versions: VERSIONS, md5: MD5 }) } });
  run.releaseLock(); assert.ok(out.failed >= 1); assert.match(JSON.stringify(run.results()), /new run is not fresh/);
});
test('the source run changing during the read stops the adoption', async () => {
  const base = tmp(); const newBase = tmp(); const dir = writeSource(base, sourceState(), sourceResults());
  const run = stateLib.openRun({ runId: 'stg-new-run2', profile: 'staging', repoRoot: root, base: newBase }); run.acquireLock(); run.initRedaction();
  const st = run.state(); st.stages = { adopt: { status: 'running' } }; run.save(st);
  const out = await adopt.runAdoption({ ctx: { targets: { ref: REF } }, run, flags: { 'from-run': 'stg-old-run1' }, profile: 'staging', git: { head: NEW }, repoRoot: root, expectedRef: REF, say: () => {}, targetsHash: TARGETS,
    deps: { readSource: (id: string, p: string) => adopt.readSourceRun(id, p, { base }), changes: () => [], repoVersions: () => VERSIONS,
      queryLedger: async () => { appendLine(dir); return { count: 3, versions: VERSIONS, md5: MD5 }; } } }); // something writes to the source while the ledger is being read
  run.releaseLock(); assert.ok(out.failed >= 1); assert.equal(run.state().stages.preflight, undefined); assert.match(JSON.stringify(run.results()), /changed while it was being read/);
});
const appendLine = (dir: string) => writeFileSync(join(dir, 'results.jsonl'), readFileSync(join(dir, 'results.jsonl'), 'utf8') + '{"id":"X","status":"PASS"}\n');

test('gates: the adopted run may continue with exposure at the new commit, at no other commit, and may not repeat identity or migrate', async () => {
  const a = await attempt(); const state = JSON.parse(JSON.stringify(a.newState)); state.stages.adopt = { status: 'done', commit: NEW, passed: 4, failed: 0 }; // what runStage records after the body
  const flags = (stage: string, sha: string, extra: Record<string, unknown> = {}) => ({ authorized: `S7@${sha}`, ...extra });
  const git = { head: NEW, clean: true }; const ctx = { profile: 'staging', targetsHash: TARGETS };
  assert.doesNotThrow(() => gates.checkGates('exposure', flags('exposure', NEW, { 'owner-confirmed': 'exposure' }), state, git, ctx));
  assert.throws(() => gates.checkGates('exposure', flags('exposure', OLD, { 'owner-confirmed': 'exposure' }), state, { head: OLD, clean: true }, ctx), /bound to commit/);
  assert.throws(() => gates.checkGates('exposure', flags('exposure', NEW, { 'owner-confirmed': 'exposure' }), state, git, { profile: 'staging', targetsHash: 'd'.repeat(64) }), /target configuration differs/);
  assert.throws(() => gates.checkGates('identity', flags('identity', NEW, { 'confirm-mutating': 'identity' }), state, git, ctx), /already ran in this run and is not repeatable/);
  assert.throws(() => gates.checkGates('migrate', flags('migrate', NEW, { 'confirm-mutating': 'migrate' }), state, git, ctx), /already ran in this run and is not repeatable/);
  // an adopted stage that was NOT adopted at this head does not satisfy a dependency
  const stale = JSON.parse(JSON.stringify(state)); stale.stages.migrate.inherited.adoptedAtCommit = 'e'.repeat(40);
  assert.throws(() => gates.checkGates('exposure', flags('exposure', NEW, { 'owner-confirmed': 'exposure' }), stale, git, ctx), /stage migrate was recorded under commit eeeeeeeeeeee/);
  assert.ok(stagesLib.STAGES.adopt && stagesLib.STAGES.adopt.group === 'S6' && stagesLib.STAGES.adopt.mutating === false);
});
test('evidence: inherited checks are INHERITED, not PASS; the kept failure keeps the outcome FAILED; nothing is reported as executed at the new commit', async () => {
  const a = await attempt(); const ns = JSON.parse(JSON.stringify(a.newState)); ns.stages.adopt = { status: 'done', commit: NEW, passed: 4, failed: 0 };
  const ev = model.evaluateRun(ns, a.newResults);
  assert.equal(ev.outcome, 'FAILED'); assert.match(ev.reasons.join(' '), /earlier attempts that failed or were interrupted \(kept although a retry followed\): exposure \(failed\)/);
  const rows = Object.fromEntries(ev.rows.map((r: { id: string; status: string }) => [r.id, r.status]));
  for (const id of ['H0', 'H1a', 'H1b', 'H2a']) assert.equal(rows[id], 'INHERITED'); assert.equal(rows.H2b, 'NOT RUN', 'exposure has not been run in the new run');
  assert.deepEqual(ev.inherited.map((r: { id: string }) => r.id), ['H0', 'H1a', 'H1b', 'H2a']);
});
test('safety by construction: adopt never imports the migration runner and its only database calls are read queries', () => {
  for (const f of ['scripts/hosted/adopt.mjs', 'scripts/hosted/lib/adopt.mjs']) {
    const src = readFileSync(join(root, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(src, /migrate\.mjs|push\.mjs|pushMigrations|db push/, `${f} must not reach the migration runner`);
    assert.doesNotMatch(src, /runSql|kind:\s*'(admin|fixture|worker|migration|probe)'/, `${f} must not run SQL other than the two read queries`);
  }
  const stage = readFileSync(join(root, 'scripts/hosted/adopt.mjs'), 'utf8'); assert.match(stage, /queryText\(ctx, 'migrate', LEDGER_EXISTS_SQL\)/); assert.match(stage, /queryJson\(ctx, 'migrate', LEDGER_SQL\)/);
  assert.ok(existsSync(join(root, 'supabase/migrations')));
});

test('migrationChanges uses real git: unchanged -> empty, changed -> names, unknown commit -> refused', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = tmp(); const git = (...a: string[]) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...a], { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q'); mkdirSync(join(dir, 'supabase/migrations'), { recursive: true });
  writeFileSync(join(dir, 'supabase/migrations/20261013130000_a.sql'), 'select 1;\n'); writeFileSync(join(dir, 'other.txt'), 'x\n'); git('add', '-A'); git('commit', '-q', '-m', 'one'); const first = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'other.txt'), 'y\n'); git('add', '-A'); git('commit', '-q', '-m', 'two (not a migration)');
  assert.deepEqual(adopt.migrationChanges(dir, first), [], 'a change outside supabase/migrations is not a migration change');
  writeFileSync(join(dir, 'supabase/migrations/20261013130000_a.sql'), 'select 2;\n'); writeFileSync(join(dir, 'supabase/migrations/20261019090100_b.sql'), 'select 3;\n'); git('add', '-A'); git('commit', '-q', '-m', 'three (migrations)');
  assert.deepEqual(adopt.migrationChanges(dir, first).sort(), ['supabase/migrations/20261013130000_a.sql', 'supabase/migrations/20261019090100_b.sql']);
  assert.throws(() => adopt.migrationChanges(dir, '0'.repeat(40)), /not in this repository/);
  assert.throws(() => adopt.migrationChanges(dir, 'HEAD'), /not a full commit SHA/);
});
