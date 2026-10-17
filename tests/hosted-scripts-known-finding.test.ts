// E2: an explicit, narrowly scoped exception for finding F-H9-1 (the pooler's transaction endpoint answers a nonexistent login differently from a wrong password for the real login). The exception covers
// ONLY the two observed responses; everything else (success, timeout/connection failure, any other message or exit code) fails normally. An excepted check is recorded as EXCEPTION, never PASS, and keeps the
// evidence outcome FAILED. These tests use no target.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const load = (f: string) => import(pathToFileURL(join(root, 'scripts/hosted', f)).href);
const findings = await load('lib/findings.mjs'); const cli = await load('lib/cli.mjs'); const model = await load('lib/evidence-model.mjs'); const stages = await load('lib/stages.mjs');

const HOST = 'psql: error: connection to server at "aws-0-us-east-1.pooler.supabase.com" (44.208.221.186), port 6543 failed:';
const REAL = { ok: false, code: 2, stdout: '', stderr: `${HOST} FATAL:  password authentication failed for user "hackass_worker"\npassword retrieved from file "/pgpass"` };
const FAKE = { ok: false, code: 2, stdout: '', stderr: `${HOST} FATAL:  (EAUTHQUERY) user not found in the database` };
const judge = (real: unknown, fake: unknown, knownFinding: string | null = null) => findings.judgeUniformRefusal({ real, fake, knownFinding });

test('without the exception the observed difference FAILS exactly as before (nothing is normalised away)', () => {
  const v = judge(REAL, FAKE); assert.equal(v.status, 'FAIL'); assert.match(v.error, /existence oracle/);
  assert.match(v.real, /password authentication failed/); assert.match(v.fake, /EAUTHQUERY\) user not found in the database/);
});
test('with --known-finding=F-H9-1 the observed pair, and only that pair, is an EXCEPTION (never PASS)', () => {
  const v = judge(REAL, FAKE, 'F-H9-1'); assert.equal(v.status, 'EXCEPTION'); assert.equal(v.finding, 'F-H9-1'); assert.notEqual(v.status, 'PASS');
});
test('the exception does not cover anything else: success, wrong exit code, other messages, swapped or partial matches all FAIL', () => {
  const ok = { ...FAKE, ok: true, code: 0 }; const timeout = { ...FAKE, code: null, stderr: '' }; const unreachable = { ...FAKE, stderr: 'psql: error: connection to server at "x" failed: Connection refused' };
  const cases: [string, unknown, unknown][] = [
    ['real login authenticated', ok, FAKE], ['nonexistent login authenticated', REAL, ok], ['both authenticated', ok, ok],
    ['exit code 1 for the real login', { ...REAL, code: 1 }, FAKE], ['exit code 3 for the nonexistent login', REAL, { ...FAKE, code: 3 }], ['no exit code (killed)', REAL, timeout],
    ['connection refused for the nonexistent login', REAL, unreachable], ['connection refused for the real login', unreachable, FAKE],
    ['swapped responses', FAKE, REAL], ['an unexpected message for the nonexistent login', REAL, { ...FAKE, stderr: `${HOST} FATAL:  (ENOTFOUND) tenant/user not found` }],
    ['a different EAUTH code', REAL, { ...FAKE, stderr: `${HOST} FATAL:  (EAUTHFAIL) user not found in the database` }], ['extra words after the covered message', REAL, { ...FAKE, stderr: `${HOST} FATAL:  (EAUTHQUERY) user not found in the database and more` }],
    ['an unexpected message for the real login', { ...REAL, stderr: `${HOST} FATAL:  too many authentication errors` }, FAKE], ['a different pooler host form', { ...REAL, stderr: 'FATAL: password authentication failed for user "a"' }, FAKE],
  ];
  for (const [label, real, fake] of cases) { const v = judge(real, fake, 'F-H9-1'); assert.equal(v.status, 'FAIL', `${label}: ${JSON.stringify(v)}`); }
});
test('a fixed pooler (identical refusals) PASSES with or without the exception; an unknown finding name fails', () => {
  const same = { ...FAKE, stderr: `${HOST} FATAL:  password authentication failed for user "hackass_nonexistent"` };
  assert.equal(judge(REAL, same).status, 'PASS'); assert.equal(judge(REAL, same, 'F-H9-1').status, 'PASS');
  assert.equal(judge(REAL, FAKE, 'F-H9-2').status, 'FAIL');
});
test('the finding table is exactly one finding, for check H9b of worker-checks', () => {
  assert.deepEqual(Object.keys(findings.KNOWN_FINDINGS), ['F-H9-1']); assert.equal(findings.KNOWN_FINDINGS['F-H9-1'].check, 'H9b'); assert.equal(findings.KNOWN_FINDINGS['F-H9-1'].stage, 'worker-checks');
  assert.doesNotMatch(findings.KNOWN_FINDINGS['F-H9-1'].title, /no password was sent|without a password|before any password/i, 'the unobserved authentication exchange is not claimed');
  assert.match(readFileSync(join(root, 'scripts/hosted/lib/findings.mjs'), 'utf8'), /authentication\s*\n?\/\/ exchange itself|exchange itself/);
});
test('the flag is accepted only by worker-checks and only with the exact finding name', async () => {
  const env = { HOSTED_SELFTEST: '1' }; const git = { head: 'a'.repeat(40), clean: true }; const logs: string[] = []; const orig = console.log; console.log = (l: unknown) => { logs.push(String(l)); };
  try {
    const wrongStage = await cli.runStage('preflight', ['--profile=selftest', '--run-id=ut-known-1', '--known-finding=F-H9-1'], async () => ({ passed: 0, failed: 0 }), { env, git });
    const unknown = await cli.runStage('worker-checks', ['--profile=selftest', '--run-id=ut-known-1', '--known-finding=F-X-9'], async () => ({ passed: 0, failed: 0 }), { env, git });
    assert.equal(wrongStage, 2); assert.equal(unknown, 2);
  } finally { console.log = orig; }
  assert.ok(logs.some((l) => /accepted only by the worker-checks stage/.test(l))); assert.ok(logs.some((l) => /must name a known finding exactly/.test(l)));
});
test('checker.exception records EXCEPTION (no PASS, not counted as passed or failed) and returns the stage exception list', async () => {
  const logged: Record<string, unknown>[] = []; const run = { log: (l: Record<string, unknown>) => logged.push(l) }; const said: string[] = [];
  const c = cli.checker(run, (s: string) => said.push(s));
  await c.check('H9b', 'uniform', async () => { c.exception('H9b', 'uniform', { finding: 'F-H9-1', error: 'differs', facts: { real: 'a', fake: 'b' } }); return cli.EXCEPTED; });
  await c.check('H10', 'next', async () => 'ok'); // the stage continues after an exception
  assert.deepEqual(c.out.exceptions, [{ id: 'H9b', finding: 'F-H9-1' }]); assert.equal(c.out.passed, 1); assert.equal(c.out.failed, 0);
  assert.deepEqual(logged.map((l) => `${l.id}:${l.status}`), ['H9b:EXCEPTION', 'H10:PASS']); assert.ok(said.some((s) => /^EXCEPTION  H9b/.test(s) && /open finding F-H9-1/.test(s)));
});
test('evidence: an EXCEPTION row is listed, is not a pass, makes the outcome FAILED and is never COMPLETE', () => {
  const ids = stages.REQUIRED_CHECKS.flatMap(([, i]: [string, string[]]) => i);
  const pass = ids.filter((i: string) => i !== 'H9b').map((id: string) => ({ id, status: 'PASS', ms: 1 }));
  const state = { stages: Object.fromEntries(stages.REQUIRED_CHECKS.map(([s]: [string]) => [s, { status: 'done' }])), facts: { owner_deletion_date: '2026-12-01' }, history: [] };
  const ev = model.evaluateRun(state, [...pass, { id: 'H9b', status: 'EXCEPTION', finding: 'F-H9-1', error: 'differs', ms: 2 }, ...['H13a', 'H13b', 'H13c'].map((id) => ({ id, status: 'PASS' }))]);
  assert.equal(ev.outcome, 'FAILED'); assert.match(ev.reasons.join(' '), /open finding\(s\) carried by an exception, not passed: H9b \(F-H9-1\)/);
  assert.equal(ev.rows.find((r: { id: string }) => r.id === 'H9b').status, 'EXCEPTION'); assert.equal(ev.excepted.length, 1);
  const withoutIt = model.evaluateRun(state, [...pass, { id: 'H9b', status: 'PASS' }, ...['H13a', 'H13b', 'H13c'].map((id) => ({ id, status: 'PASS' }))]);
  assert.equal(withoutIt.outcome, 'COMPLETE', 'the same run without the exception would be COMPLETE: the exception alone is what keeps it FAILED');
  assert.match(readFileSync(join(root, 'scripts/hosted/evidence.mjs'), 'utf8'), /Open findings carried by an exception \(NOT passed/);
});
test('H9 is split without weakening: H9 keeps every strict step, H9b uses the shared single probe, and the probe runs once', () => {
  const src = readFileSync(join(root, 'scripts/hosted/checks-worker.mjs'), 'utf8');
  assert.equal((src.match(/wrongPasswordProbe\(/g) ?? []).length, 1, 'one probe call site (2 failed connections in total)');
  assert.match(src, /c\.check\('H9'/); assert.match(src, /c\.check\('H9b'/); assert.match(src, /judgeUniformRefusal\(\{ real: probe\.real, fake: probe\.fake, knownFinding \}\)/);
  assert.match(src, /const knownFinding = flags\['known-finding'\] \?\? null/);
  assert.ok(stages.REQUIRED_CHECKS.some(([s, ids]: [string, string[]]) => s === 'worker-checks' && ids.join() === 'H9,H9b,H10'));
});
