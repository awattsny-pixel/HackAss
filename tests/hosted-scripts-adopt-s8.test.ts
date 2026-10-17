// E1: `adopt --through=s8` carries the S7 and S8 progress of a BLOCKED run (worker-checks failed on finding F-H9-1) into a new run at a new commit. Temporary run directories, a stubbed ledger and fixture
// inspection and stubbed git: nothing contacts a target. Fixtures are accepted in their EXPECTED post-test state (b2 deleted, s-rm de-staffed, the staff fixtures still staffed): nothing is recreated or reset. That s-sess stays signed out is inherited evidence, not checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const load = (f: string) => import(pathToFileURL(join(root, 'scripts/hosted', f)).href);
const adopt = await load('lib/adopt.mjs'); const stateLib = await load('lib/state.mjs'); const gates = await load('lib/gates.mjs'); const model = await load('lib/evidence-model.mjs'); const redactLib = await load('lib/redact.mjs');

const FIRST = 'f'.repeat(40); const MID = 'a'.repeat(40); const NEW = 'b'.repeat(40); const TARGETS = 'c'.repeat(64); const REF = 'foptxhdnhudburqtnflt';
const VERSIONS = ['20261013130000', '20261013130100', '20261019090100']; const MD5 = 'ee0f3300861a19ae1626276d51868b24';
const made: string[] = [];
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hs-ad8-')); chmodSync(d, 0o700); made.push(d); return d; };
const NAMES = ['b1', 'b2', 's-sess', 's-rm', 's-mfa', 's-rev'];
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const PW = (n: string) => `Pw-${n}-secret-value-${'x'.repeat(12)}`; const TOTP = (n: string) => `TOTPSECRET${n.toUpperCase().replace(/[^A-Z]/g, '')}${'Q'.repeat(10)}`;
const prev = (c: string) => ({ run: 'stg-first-run1', commit: FIRST, adoptedAtCommit: c, note: 'inherited from the source run; not executed at this commit' });

function sourceState(over: Record<string, unknown> = {}) {
  const users = Object.fromEntries(NAMES.map((n, i) => [n, { id: uuid(i + 1), email: `staging-stg-mid-run2-${n}@example.test` }]));
  const fresh = (at: string, passed: number) => ({ status: 'done', at, commit: MID, passed, failed: 0 });
  return {
    runId: 'stg-mid-run2', profile: 'staging', intents: NAMES.map((n) => ({ kind: 'fixture', name: n, email: users[n].email, at: 't', id: users[n].id })), closed: undefined,
    binding: { commit: MID, profile: 'staging', targets: TARGETS, at: 't' },
    stages: {
      adopt: fresh('t', 4),
      preflight: { status: 'done', at: 't0', commit: FIRST, passed: 2, failed: 0, inherited: prev(MID) }, identity: { status: 'done', at: 't0', commit: FIRST, passed: 1, failed: 0, inherited: prev(MID) }, migrate: { status: 'done', at: 't0', commit: FIRST, passed: 1, failed: 0, inherited: prev(MID) },
      exposure: fresh('t1', 1), 'worker-marker': fresh('t2', 1), rerun: fresh('t3', 1), inventory: fresh('t4', 2), fixtures: fresh('t5', 3), 'session-checks': fresh('t6', 4),
      'worker-checks': { status: 'failed', at: 't7', commit: MID, passed: 0, failed: 1 },
    },
    history: [{ stage: 'exposure', status: 'failed', at: 'tx', commit: FIRST, passed: 0, failed: 1, error: 'OpenAPI description: HTTP 401 [inherited from run stg-first-run1 at commit fffffffffff; kept, not cleared]', inherited: prev(MID) }],
    facts: { public_objects_before: 0, server_version: '17.11', jwks: 'ES256', ledger_md5_after_migrate: MD5, inherited_from_run: 'stg-first-run1', inherited_from_commit: FIRST, worker_marker: 'deadbeef', catalog_fingerprint: '387b0f7189a726cc339313b0d3b13df2' },
    fixtures: { users, category: 'stg-stg-mid-run2' }, ...over,
  };
}
const inh = (id: string, stage: string, orig = 'PASS') => ({ id, status: 'INHERITED', stage, title: id, facts: `facts of ${id}`, ms: 1, inherited: { run: 'stg-first-run1', commit: FIRST, adoptedAtCommit: MID, originalStatus: orig } });
const pass = (id: string) => ({ id, status: 'PASS', title: id, facts: `facts of ${id}`, ms: 1 });
const sourceResults = () => [
  ...['A1', 'A2', 'A3', 'A4'].map(pass), inh('H0', 'preflight'), inh('H1a', 'preflight'), inh('H1b', 'identity'), inh('H2a', 'migrate'),
  pass('H2b'), pass('H2c'), pass('H3'), pass('H4'), pass('H5a'), pass('FX0'), pass('H5b'), pass('FX1'), pass('H6'), pass('H7'), pass('H8'), { ...pass('H8-default'), facts: 'refresh kept the amr timestamp; mfa_stale at about 16 minutes with the token unexpired', ms: 1000000 },
  { id: 'H9', status: 'FAIL', title: 'worker login', error: 'the refusal for a nonexistent role differs from the one for the real role (existence oracle)', ms: 27418 }, { id: 'H10', status: 'SKIP', reason: 'an earlier check failed' },
];
const secretsObj = () => ({ users: Object.fromEntries(NAMES.map((n) => [n, { password: PW(n), ...(['s-rm', 's-mfa', 's-rev'].includes(n) ? { factorId: `factor-${n}`, totpSecret: TOTP(n), lastWindow: 1 } : {}) }])) });
const EXPECT_FIX = () => ({ b1: { auth: 'present', accountStatus: 'active', assignments: 0 }, b2: { auth: 'absent', accountStatus: 'deleted', assignments: 0 }, 's-sess': { auth: 'present', accountStatus: 'active', assignments: 0 },
  's-rm': { auth: 'present', accountStatus: 'active', assignments: 0 }, 's-mfa': { auth: 'present', accountStatus: 'active', assignments: 1 }, 's-rev': { auth: 'present', accountStatus: 'active', assignments: 1 } });

type Inputs = { secretsRaw?: string; state?: Record<string, unknown>; results?: unknown[]; targetsHash?: string; changed?: string[] | Error; live?: unknown; fixtures?: unknown; secrets?: unknown | null; secretsMode?: number; head?: string; mutateSource?: (dir: string) => void };
async function attempt(i: Inputs = {}) {
  const base = tmp(); const newBase = tmp(); const dir = join(base, 'stg-mid-run2'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(i.state ?? sourceState(), null, 2), { mode: 0o600 }); writeFileSync(join(dir, 'results.jsonl'), (i.results ?? sourceResults()).map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  if (i.secrets !== null) { writeFileSync(join(dir, 'secrets.json'), i.secretsRaw ?? JSON.stringify(i.secrets ?? secretsObj()), { mode: 0o600 }); chmodSync(join(dir, 'secrets.json'), i.secretsMode ?? 0o600); }
  const snap = () => ({ s: readFileSync(join(dir, 'state.json')), r: readFileSync(join(dir, 'results.jsonl')), k: existsSync(join(dir, 'secrets.json')) ? readFileSync(join(dir, 'secrets.json')) : null });
  const before = snap();
  const run = stateLib.openRun({ runId: 'stg-new-run3', profile: 'staging', repoRoot: root, base: newBase }); run.acquireLock(); run.initRedaction();
  const st = run.state(); st.binding = { commit: i.head ?? NEW, profile: 'staging', targets: i.targetsHash ?? TARGETS, at: 'now' }; st.stages = { adopt: { status: 'running' } }; run.save(st);
  const lines: string[] = [];
  const out = await adopt.runAdoptionS8({ ctx: { targets: { ref: REF } }, run, flags: { 'from-run': 'stg-mid-run2' }, profile: 'staging', git: { head: i.head ?? NEW, clean: true }, repoRoot: root, expectedRef: REF, say: (l: string) => lines.push(l), targetsHash: i.targetsHash ?? TARGETS,
    deps: { readSource: (id: string, p: string) => adopt.readSourceRun(id, p, { base }), changes: () => { if (i.changed instanceof Error) throw i.changed; return i.changed ?? []; }, repoVersions: () => VERSIONS,
      queryLedger: async () => { i.mutateSource?.(dir); return i.live === undefined ? { count: 3, versions: VERSIONS, md5: MD5 } : i.live; }, inspectFixtures: async () => (i.fixtures === undefined ? EXPECT_FIX() : i.fixtures) } });
  run.releaseLock();
  return { out, run, lines, dir, before, after: snap(), newState: run.state(), newResults: run.results(), newDir: run.dir };
}
const failedIds = (a: { newResults: { id: string; status: string }[] }) => a.newResults.filter((r) => /^A\d$/.test(r.id) && r.status === 'FAIL').map((r) => r.id);

test('a blocked S8 run is adopted: 9 stages inherited, provenance preserved, both failed attempts kept, the MFA evidence INHERITED, fixtures and intents carried, secrets copied privately with integrity', async () => {
  const a = await attempt(); assert.equal(a.out.failed, 0); assert.equal(a.out.passed, 6);
  const ns = a.newState;
  for (const stage of ['preflight', 'identity', 'migrate', 'exposure', 'worker-marker', 'rerun', 'inventory', 'fixtures', 'session-checks']) { assert.equal(ns.stages[stage].status, 'done', stage); assert.equal(ns.stages[stage].inherited.adoptedAtCommit, NEW); assert.equal(ns.stages[stage].inherited.run, 'stg-mid-run2'); }
  assert.equal(ns.stages.preflight.commit, FIRST, 'a stage keeps the commit it truly ran under'); assert.equal(ns.stages.fixtures.commit, MID);
  assert.deepEqual(ns.stages.preflight.inherited.previous, prev(MID), 'the earlier adoption is kept as previous'); assert.equal(ns.stages.fixtures.inherited.previous, undefined);
  assert.equal(ns.stages['worker-checks'], undefined, 'worker-checks is NOT carried as a stage: it can run in the new run'); assert.equal(ns.stages.adopt.status, 'running'); // runStage records the adopt stage itself afterwards
  assert.deepEqual(ns.history.map((h: { stage: string }) => h.stage), ['exposure', 'worker-checks']);
  assert.match(ns.history[0].error, /HTTP 401/); assert.match(ns.history[0].error, /kept, not cleared/); assert.deepEqual(ns.history[0].inherited, prev(MID), 'the first failed attempt keeps its own provenance');
  assert.match(ns.history[1].error, /existence oracle/); assert.match(ns.history[1].error, /inherited from run stg-mid-run2/); assert.equal(ns.history[1].status, 'failed');
  assert.deepEqual(ns.facts.inherited_chain, [{ run: 'stg-first-run1', commit: FIRST }, { run: 'stg-mid-run2', commit: MID }]); assert.equal(ns.facts.worker_marker, 'deadbeef'); assert.equal(ns.facts.catalog_fingerprint, '387b0f7189a726cc339313b0d3b13df2');
  assert.deepEqual(Object.keys(ns.fixtures.users), NAMES); assert.equal(ns.fixtures.category, 'stg-stg-mid-run2'); assert.equal(ns.intents.length, 6);
  const inherited = a.newResults.filter((r: { status: string }) => r.status === 'INHERITED');
  assert.deepEqual(inherited.map((r: { id: string }) => r.id), ['H0', 'H1a', 'H1b', 'H2a', 'H2b', 'H2c', 'H3', 'H4', 'H5a', 'FX0', 'H5b', 'FX1', 'H6', 'H7', 'H8', 'H8-default']);
  const mfa = inherited.find((r: { id: string }) => r.id === 'H8-default'); assert.match(mfa.facts, /mfa_stale at about 16 minutes/); assert.equal(mfa.ms, 1000000); assert.equal(mfa.inherited.originalStatus, 'PASS'); assert.equal(mfa.inherited.adoptedAtCommit, NEW);
  const h0 = inherited.find((r: { id: string }) => r.id === 'H0'); assert.equal(h0.inherited.previous.run, 'stg-first-run1'); assert.equal(h0.inherited.originalStatus, 'PASS');
  assert.ok(!a.newResults.some((r: { id: string; status: string }) => ['H6', 'H8-default', 'FX1', 'H4'].includes(r.id) && r.status === 'PASS'), 'no inherited check is recorded as freshly passed');
  assert.ok(!a.newResults.some((r: { id: string }) => r.id === 'H9' || r.id === 'H10'), 'the failed H9 lives in the history, not in the new run results');
  assert.deepEqual(a.newResults.filter((r: { id: string }) => /^A\d$/.test(r.id)).map((r: { id: string; status: string }) => `${r.id}:${r.status}`), ['A1:PASS', 'A2:PASS', 'A3:PASS', 'A4:PASS', 'A5:PASS', 'A6:PASS']);
  // the source run is untouched, byte for byte (state, results AND secrets)
  assert.ok(a.before.s.equals(a.after.s) && a.before.r.equals(a.after.r) && a.before.k!.equals(a.after.k!), 'the source run is unchanged');
  // the secrets copy: mode 600, same content, nothing printed
  const dest = join(a.newDir, 'secrets.json'); assert.equal(statSync(dest).mode & 0o777, 0o600); assert.deepEqual(JSON.parse(readFileSync(dest, 'utf8')), secretsObj());
  const everything = JSON.stringify(a.newResults) + JSON.stringify(a.newState) + a.lines.join('\n');
  for (const n of NAMES) { assert.ok(!everything.includes(PW(n)), `${n} password never recorded or printed`); assert.ok(!everything.includes(TOTP(n))); }
  assert.match(a.newResults.find((r: { id: string }) => r.id === 'A6').facts, /6 users, content digest [0-9a-f]{12}…, mode 600/);
  assert.equal(redactLib.redact(`x ${PW('b1')} y`).includes(PW('b1')), false, 'the copied secrets are registered for redaction in the new run');
});
test('the adopted run continues: worker-checks, catalog-checks and isolation are allowed at the new commit, the inherited stages are not repeatable, nothing is skipped silently', async () => {
  const a = await attempt(); const state = JSON.parse(JSON.stringify(a.newState)); state.stages.adopt = { status: 'done', commit: NEW, passed: 6, failed: 0 };
  const git = { head: NEW, clean: true }; const ctx = { profile: 'staging', targetsHash: TARGETS }; const f = (extra: Record<string, unknown>) => ({ authorized: `S8@${NEW}`, ...extra });
  assert.doesNotThrow(() => gates.checkGates('worker-checks', f({ 'confirm-mutating': 'worker-checks' }), state, git, ctx));
  assert.throws(() => gates.checkGates('catalog-checks', f({ 'confirm-mutating': 'catalog-checks' }), state, git, ctx), /stage worker-checks must be completed/);
  assert.throws(() => gates.checkGates('fixtures', f({ 'confirm-mutating': 'fixtures' }), state, git, ctx), /already ran in this run and is not repeatable/);
  assert.throws(() => gates.checkGates('session-checks', f({ 'confirm-mutating': 'session-checks' }), state, git, ctx), /already ran in this run and is not repeatable/);
  assert.throws(() => gates.checkGates('worker-checks', { authorized: `S8@${MID}`, 'confirm-mutating': 'worker-checks' }, state, { head: MID, clean: true }, ctx), /bound to commit/);
  const ev = model.evaluateRun(state, a.newResults); assert.equal(ev.outcome, 'FAILED'); assert.match(ev.reasons.join(' '), /earlier attempts that failed or were interrupted.*exposure \(failed\), worker-checks \(failed\)/);
  assert.equal(ev.rows.find((r: { id: string }) => r.id === 'H8-default').status, 'INHERITED');
});

const refuses = async (label: string, i: Inputs, pattern: RegExp, ids: string[], { sourceChangedByTest = false } = {}) => {
  const a = await attempt(i);
  assert.ok(a.out.failed >= 1, `${label}: the stage fails`); assert.equal(a.newState.stages.preflight, undefined, `${label}: nothing inherited`); assert.deepEqual(a.newState.history ?? [], [], `${label}: no history written`);
  assert.ok(failedIds(a).some((id: string) => ids.includes(id)), `${label}: failed ${failedIds(a).join(',')}, expected one of ${ids.join(',')}`); assert.match(JSON.stringify(a.newResults), pattern, label);
  assert.ok(!existsSync(join(a.newDir, 'secrets.json')), `${label}: no secrets copy is left behind`);
  if (!sourceChangedByTest) assert.ok(a.before.s.equals(a.after.s) && a.before.r.equals(a.after.r) && (a.before.k === null ? a.after.k === null : a.before.k.equals(a.after.k!)), `${label}: the source run is unchanged`);
};
test('refused: mismatched target binding, project, changed migrations, git failure and every ledger difference', async () => {
  await refuses('targets', { targetsHash: 'd'.repeat(64) }, /target configuration differs/, ['A2']);
  await refuses('changed', { changed: ['supabase/migrations/20261019090100_x.sql'] }, /migration files changed since the source commit/, ['A3']);
  await refuses('git', { changed: new (adopt.AdoptRefused)(['the source commit aaaaaaaaaaaa is not in this repository']) }, /not in this repository/, ['A3']);
  await refuses('count', { live: { count: 2, versions: VERSIONS.slice(0, 2), md5: MD5 } }, /not exactly the repository's 3 migrations/, ['A4']);
  await refuses('md5', { live: { count: 3, versions: VERSIONS, md5: 'f'.repeat(32) } }, /md5 differs/, ['A4']);
});
const mut = (f: (s: ReturnType<typeof sourceState>) => void) => { const s = sourceState(); f(s); return s; };
test('refused: invalid source-run state', async () => {
  const cases: [string, Inputs, RegExp][] = [
    ['same commit', { head: MID }, /bound to this same commit/], ['closed', { state: mut((s) => { (s as Record<string, unknown>).closed = true; }) }, /source run is closed/],
    ['fixtures not done', { state: mut((s) => { s.stages.fixtures.status = 'failed'; }) }, /source stage fixtures is not done/], ['session-checks absent', { state: mut((s) => { delete (s.stages as Record<string, unknown>)['session-checks']; }) }, /session-checks is not done \(absent\)/],
    ['worker-checks done (nothing to carry)', { state: mut((s) => { s.stages['worker-checks'].status = 'done'; }) }, /worker-checks must be the failed attempt/], ['worker-checks absent', { state: mut((s) => { delete (s.stages as Record<string, unknown>)['worker-checks']; }) }, /worker-checks must be the failed attempt/],
    ['catalog-checks present', { state: mut((s) => { (s.stages as Record<string, unknown>)['catalog-checks'] = { status: 'done', commit: MID, passed: 1, failed: 0 }; }) }, /stage beyond worker-checks: catalog-checks/],
    ['cleanup present', { state: mut((s) => { (s.stages as Record<string, unknown>).cleanup = { status: 'done', commit: MID, passed: 3, failed: 0 }; }) }, /stage beyond worker-checks: cleanup/],
    ['stage under another commit', { state: mut((s) => { s.stages.exposure.commit = 'e'.repeat(40); }) }, /exposure was recorded under eeeeeeeeeeee/], ['adopted at another commit', { state: mut((s) => { s.stages.preflight.inherited.adoptedAtCommit = 'e'.repeat(40); }) }, /preflight was adopted at eeeeeeeeeeee/],
    ['no ledger md5', { state: mut((s) => { delete (s.facts as Record<string, unknown>).ledger_md5_after_migrate; }) }, /recorded no ledger md5/], ['no worker marker', { state: mut((s) => { delete (s.facts as Record<string, unknown>).worker_marker; }) }, /recorded no worker_marker/],
    ['a fixture user missing from the record', { state: mut((s) => { delete (s.fixtures.users as Record<string, unknown>)['s-rev']; }) }, /no recorded fixture user s-rev/], ['a creation intent missing', { state: mut((s) => { (s as Record<string, unknown>).intents = (s as { intents: unknown[] }).intents.slice(1); }) }, /creation intent of b1 is missing/],
    ['no H9 failure to keep', { results: sourceResults().filter((r) => r.id !== 'H9') }, /no H9 failure to keep/], ['no result for a completed check', { results: sourceResults().filter((r) => r.id !== 'H8-default') }, /no PASS or INHERITED for H8-default/],
    ['wrong profile', { state: mut((s) => { s.profile = 'selftest'; }) }, /profile is selftest, not staging/],
  ];
  for (const [label, input, pattern] of cases) await refuses(label, input, pattern, ['A1', 'A2']);
});
test('fixtures: accepted in the expected post-test state; refused when a user is not (b2 present, s-rm still staffed, a staff fixture missing or unstaffed); nothing is recreated or reset', async () => {
  const ok = await attempt(); assert.equal(ok.out.failed, 0, 'b2 deleted, s-rm de-staffed, s-mfa and s-rev staffed is the expected state');
  const f = (over: Record<string, unknown>) => ({ ...EXPECT_FIX(), ...over });
  await refuses('b2 still exists', { fixtures: f({ b2: { auth: 'present', accountStatus: 'active', assignments: 0 } }) }, /fixture b2: Auth user is present, expected absent/, ['A5']);
  await refuses('b2 account not deleted', { fixtures: f({ b2: { auth: 'absent', accountStatus: 'active', assignments: 0 } }) }, /fixture b2: account status is active, expected deleted/, ['A5']);
  await refuses('s-rm still staffed', { fixtures: f({ 's-rm': { auth: 'present', accountStatus: 'active', assignments: 1 } }) }, /fixture s-rm: 1 active staff assignment\(s\), expected 0/, ['A5']);
  await refuses('s-rev missing', { fixtures: f({ 's-rev': { auth: 'absent', accountStatus: 'none', assignments: 0 } }) }, /fixture s-rev: Auth user is absent, expected present/, ['A5']);
  await refuses('s-mfa unstaffed', { fixtures: f({ 's-mfa': { auth: 'present', accountStatus: 'active', assignments: 0 } }) }, /fixture s-mfa: 0 active staff assignment\(s\), expected 1/, ['A5']);
  await refuses('b1 gone', { fixtures: f({ b1: { auth: 'absent', accountStatus: 'deleted', assignments: 0 } }) }, /fixture b1: Auth user is absent, expected present/, ['A5']);
  const missing = EXPECT_FIX() as Record<string, unknown>; delete missing['s-sess']; await refuses('not inspected', { fixtures: missing }, /fixture s-sess was not inspected/, ['A5']);
  await refuses('fixtures could not be inspected', { fixtures: null }, /A5|fixture users were not inspected/, ['A5']);
});
test('secrets: missing, group-readable, invalid JSON, a missing password or TOTP material are refused; a source that changes during the adoption is refused and the copy removed', async () => {
  await refuses('no secrets file', { secrets: null }, /no secrets\.json/, ['A6']);
  await refuses('mode 644', { secretsMode: 0o644 }, /readable by group or others/, ['A6']);
  const noPw = secretsObj() as { users: Record<string, Record<string, unknown>> }; delete noPw.users.b1.password; await refuses('missing password', { secrets: noPw }, /no password for b1/, ['A6']);
  const noTotp = secretsObj() as { users: Record<string, Record<string, unknown>> }; delete noTotp.users['s-mfa'].totpSecret; await refuses('missing TOTP', { secrets: noTotp }, /no TOTP material for s-mfa/, ['A6']);
  await refuses('a JSON string instead of an object', { secrets: '' as unknown as object }, /secrets\.json is not a JSON object/, ['A6']);
  await refuses('an empty object (no passwords)', { secrets: {} }, /no password for b1/, ['A6']);
  await refuses('source secrets change while the adoption runs', { mutateSource: (dir) => { const o = secretsObj(); o.users.b1.password = 'changed'; writeFileSync(join(dir, 'secrets.json'), JSON.stringify(o), { mode: 0o600 }); } }, /source secrets changed|changed while/, ['A6', 'A1'], { sourceChangedByTest: true }); // the test itself rewrites the source secrets
});
test('safety by construction: the adopt files never import the migration runner, run no SQL but reads, and call the Auth admin API with GET only', () => {
  for (const f of ['scripts/hosted/adopt.mjs', 'scripts/hosted/lib/adopt.mjs', 'scripts/hosted/lib/fixture-inspect.mjs']) {
    const src = readFileSync(join(root, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(src, /migrate\.mjs|push\.mjs|pushMigrations|db push/, `${f}: no migration runner`); assert.doesNotMatch(src, /runSql|kind:\s*'(admin|fixture|worker|migration|probe)'/, `${f}: reads only`);
    assert.doesNotMatch(src, /method:\s*'(POST|PUT|PATCH|DELETE)'/, `${f}: no write request`); assert.doesNotMatch(src, /adminCreateUser|adminDeleteUser|signIn|mfaEnroll|mfaVerify|STAFF_INSERT_SQL|CATEGORY_INSERT_SQL/, `${f}: nothing is created, deleted or reset`);
  }
});

test('copySecrets verifies its own copy: a corrupted copy or a wrong mode is refused and removed; a faithful copy is accepted', () => {
  const base = tmp(); const src = join(base, 'src'); const dst = join(base, 'dst'); mkdirSync(src, { mode: 0o700 }); mkdirSync(dst, { mode: 0o700 });
  writeFileSync(join(src, 'secrets.json'), JSON.stringify(secretsObj()), { mode: 0o600 });
  const expected = adopt.inspectSecrets(src).digest;
  const fake = (write: (f: string) => void) => ({ dir: dst, saveSecrets: () => write(join(dst, 'secrets.json')) });
  assert.throws(() => adopt.copySecrets({ dir: src }, fake((f) => writeFileSync(f, JSON.stringify({ users: { b1: { password: 'tampered' } } }), { mode: 0o600 })), expected), /the copy differs from the source/);
  assert.ok(!existsSync(join(dst, 'secrets.json')), 'a corrupted copy is removed');
  assert.throws(() => adopt.copySecrets({ dir: src }, fake((f) => { writeFileSync(f, JSON.stringify(secretsObj()), { mode: 0o644 }); chmodSync(f, 0o644); }), expected), /the copy has the wrong file mode/);
  assert.ok(!existsSync(join(dst, 'secrets.json')), 'a copy with a wrong mode is removed');
  assert.throws(() => adopt.copySecrets({ dir: src }, fake(() => {}), 'e'.repeat(64)), /changed or became invalid/, 'a digest that is not the validated one is refused before anything is written');
  const good = adopt.copySecrets({ dir: src }, fake((f) => { writeFileSync(f, JSON.stringify(secretsObj()), { mode: 0o600 }); chmodSync(f, 0o600); }), expected);
  assert.equal(good.users, 6); assert.equal(good.digest12, expected.slice(0, 12));
});

const FAKE_SECRET = 'FAKE-SECRET-VALUE-do-not-leak-0123456789';
test('inspectSecrets rejects null, arrays and primitives explicitly (and says so without quoting the file)', () => {
  const dir = tmp();
  for (const [label, raw] of [['null', 'null'], ['an array', '[1,2]'], ['an array holding the secret', `["${FAKE_SECRET}"]`], ['true', 'true'], ['a number', '5'], ['a string', `"${FAKE_SECRET}"`]]) {
    writeFileSync(join(dir, 'secrets.json'), raw, { mode: 0o600 });
    const r = adopt.inspectSecrets(dir);
    assert.ok(r.problems.some((p: string) => /secrets\.json is not a JSON object/.test(p)), `${label}: rejected`); assert.equal(r.parsed, null, `${label}: nothing is parsed for use`); assert.equal(r.digest, null);
    assert.ok(!JSON.stringify(r.problems).includes(FAKE_SECRET), `${label}: the problem text never quotes the file`);
  }
  writeFileSync(join(dir, 'secrets.json'), `{"users":{"b1":{"password":"${FAKE_SECRET}"`, { mode: 0o600 }); // truncated: a parse error would normally quote text
  const bad = adopt.inspectSecrets(dir); assert.deepEqual(bad.problems, ['secrets.json is not valid JSON']); assert.ok(!JSON.stringify(bad).includes(FAKE_SECRET));
});
test('a source secrets file that is JSON null (or another non-object) stops the adoption at A6 before anything is copied', async () => {
  for (const raw of ['null', '[]', '7', 'true']) await refuses(`secrets.json is ${raw}`, { secretsRaw: raw }, /secrets\.json is not a JSON object/, ['A6']);
});
test('copySecrets errors are FIXED messages: malformed copied JSON containing a fake secret, an unwritable copy and an unreadable copy never quote any text', () => {
  const base = tmp(); const src = join(base, 'src'); const dst = join(base, 'dst'); mkdirSync(src, { mode: 0o700 }); mkdirSync(dst, { mode: 0o700 });
  writeFileSync(join(src, 'secrets.json'), JSON.stringify(secretsObj()), { mode: 0o600 }); const expected = adopt.inspectSecrets(src).digest;
  const file = join(dst, 'secrets.json');
  const attemptCopy = (saveSecrets: () => void) => { try { adopt.copySecrets({ dir: src }, { dir: dst, saveSecrets }, expected); } catch (e) { return e as Error; } return null; };
  const malformed = attemptCopy(() => writeFileSync(file, `{"users":{"b1":{"password":"${FAKE_SECRET}", "totp": oops`, { mode: 0o600 }));
  assert.ok(malformed instanceof adopt.AdoptRefused); assert.equal(malformed!.message, 'adoption refused (1): A6 the secrets copy failed its integrity check (the copy could not be read back as valid JSON); the copy was removed and nothing was recorded');
  for (const needle of [FAKE_SECRET, 'oops', 'Unexpected', 'position', 'JSON.parse', 'token']) assert.ok(!malformed!.message.includes(needle) && !JSON.stringify((malformed as unknown as { problems: string[] }).problems).includes(needle), `no quoted text: ${needle}`);
  assert.ok(!existsSync(file), 'the malformed copy is removed');
  const unwritable = attemptCopy(() => { throw new Error(`disk problem near ${FAKE_SECRET}`); });
  assert.equal(unwritable!.message, 'adoption refused (1): A6 the secrets copy failed its integrity check (the copy could not be written); the copy was removed and nothing was recorded'); assert.ok(!unwritable!.message.includes(FAKE_SECRET));
  const missing = attemptCopy(() => {}); // saveSecrets wrote nothing: the copy cannot be verified
  assert.equal(missing!.message, 'adoption refused (1): A6 the secrets copy failed its integrity check (the copy could not be verified); the copy was removed and nothing was recorded');
  const differs = attemptCopy(() => writeFileSync(file, JSON.stringify({ users: { b1: { password: FAKE_SECRET } } }), { mode: 0o600 }));
  assert.match(differs!.message, /\(the copy differs from the source\)/); assert.ok(!differs!.message.includes(FAKE_SECRET));
});
test('A5 is worded as what it checks: Auth presence, account status and assignments; the s-sess sign-out is inherited evidence, not freshly verified', () => {
  const src = readFileSync(join(root, 'scripts/hosted/lib/adopt.mjs'), 'utf8'); const readme = readFileSync(join(root, 'scripts/hosted/README.md'), 'utf8');
  assert.match(src, /A5: "each fixture user's Auth presence, account status and active staff assignments match the expected post-test state .*that s-sess stays signed out is inherited evidence \(H6\), not freshly verified"/);
  assert.match(readme, /does \*\*not\*\* freshly verify that `s-sess` stays signed out/);
  assert.doesNotMatch(src.split('\n').filter((l) => /A5:/.test(l)).join(''), /s-sess signed out, s-rm/);
});
