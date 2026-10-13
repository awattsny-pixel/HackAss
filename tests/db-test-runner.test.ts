// scripts/db-test.mjs driven entirely by command doubles: no Docker, no Supabase CLI and no database is ever contacted.
// Part 1 injects a fake command runner; part 2 runs the real script as a process against fake `docker`/`supabase`
// executables placed first on PATH (so the real spawn, timeout and exit-code paths are exercised).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { runDbTests, EXIT, DEFAULT_TIMEOUTS } = await import(pathToFileURL(join(root, 'scripts/db-test.mjs')).href);

type Result = { status: number | null; timedOut?: boolean; missing?: boolean; error?: string | null };
const OK: Result = { status: 0 };
const FAIL: Result = { status: 1 };
const TIMEOUT: Result = { status: null, timedOut: true, error: 'ETIMEDOUT' };
const MISSING: Result = { status: null, missing: true, error: 'ENOENT' };

/** A fake command runner: responses are keyed by the command line; everything unlisted succeeds. Records every call. */
function fake(responses: Record<string, Result> = {}) {
  const calls: { line: string; timeoutMs?: number }[] = [];
  const messages: string[] = [];
  const exec = (cmd: string, args: string[], opts: { timeoutMs?: number } = {}) => {
    const line = [cmd, ...args].join(' ');
    calls.push({ line, timeoutMs: opts.timeoutMs });
    const key = Object.keys(responses).find((k) => line.startsWith(k));
    return key ? responses[key] : OK;
  };
  const log = { info: (m: string) => messages.push(m), error: (m: string) => messages.push(m) };
  const lines = () => calls.map((c) => c.line);
  const run = () => runDbTests({ exec, env: {}, log });
  return { run, calls, lines, messages };
}
const has = (f: ReturnType<typeof fake>, prefix: string) => f.lines().some((l) => l.startsWith(prefix));

test('success: preflight, start, test, then stop, in that order, exit 0', () => {
  const f = fake();
  assert.equal(f.run(), EXIT.OK);
  assert.deepEqual(f.lines().map((l) => l.split(' ').slice(0, 2).join(' ')), ['docker info', 'supabase --version', 'supabase start', 'supabase test', 'supabase stop']);
});

test('every command is bounded by a positive timeout', () => {
  const f = fake();
  f.run();
  assert.equal(f.calls.length, 5);
  for (const c of f.calls) assert.ok(Number.isFinite(c.timeoutMs) && c.timeoutMs! > 0 && c.timeoutMs! <= 15 * 60_000, `${c.line}: ${c.timeoutMs}`);
  assert.ok(Object.values(DEFAULT_TIMEOUTS).every((v) => Number.isFinite(v) && (v as number) > 0));
});

test('BLOCKED (exit 2, nothing started, nothing to clean up): Docker missing, Docker daemon unresponsive, CLI missing', () => {
  for (const [name, responses, message] of [
    ['docker missing', { 'docker info': MISSING }, /Docker is not available/],
    ['docker failing', { 'docker info': FAIL }, /Docker is not available/],
    ['docker hung', { 'docker info': TIMEOUT }, /did not answer in time/],
    ['cli missing', { 'supabase --version': MISSING }, /Supabase CLI is not installed/],
  ] as const) {
    const f = fake(responses);
    assert.equal(f.run(), EXIT.BLOCKED, name);
    assert.ok(!has(f, 'supabase start') && !has(f, 'supabase stop'), `${name}: must not start or stop anything`);
    assert.match(f.messages.join('\n'), message, name);
    assert.match(f.messages.join('\n'), /^BLOCKED/m, name);
  }
});

test('failed startup: exit 3, no tests run, cleanup still attempted (a partial start can leave containers)', () => {
  const f = fake({ 'supabase start': FAIL });
  assert.equal(f.run(), EXIT.START_FAILED);
  assert.ok(!has(f, 'supabase test'));
  assert.ok(has(f, 'supabase stop --no-backup'));
  assert.match(f.messages.join('\n'), /supabase start failed/);
});

test('timed-out startup: exit 4, no tests run, cleanup attempted', () => {
  const f = fake({ 'supabase start': TIMEOUT });
  assert.equal(f.run(), EXIT.TIMEOUT);
  assert.ok(!has(f, 'supabase test') && has(f, 'supabase stop --no-backup'));
  assert.match(f.messages.join('\n'), /timed out after \d+ms/);
});

test('failed database tests: exit 1 and cleanup attempted; a timed-out test run: exit 4 and cleanup attempted', () => {
  const failed = fake({ 'supabase test db': FAIL });
  assert.equal(failed.run(), EXIT.TESTS_FAILED);
  assert.ok(has(failed, 'supabase stop --no-backup'));
  const hung = fake({ 'supabase test db': TIMEOUT });
  assert.equal(hung.run(), EXIT.TIMEOUT);
  assert.ok(has(hung, 'supabase stop --no-backup'));
});

test('failed cleanup: exit 8, and it outranks success, failed tests, failed or timed-out startup', () => {
  for (const [name, responses] of [
    ['after success', { 'supabase stop': FAIL }],
    ['stop timed out', { 'supabase stop': TIMEOUT }],
    ['after failed tests', { 'supabase test db': FAIL, 'supabase stop': FAIL }],
    ['after failed start', { 'supabase start': FAIL, 'supabase stop': FAIL }],
    ['after timed-out start', { 'supabase start': TIMEOUT, 'supabase stop': TIMEOUT }],
  ] as const) {
    const f = fake(responses);
    assert.equal(f.run(), EXIT.CLEANUP_FAILED, name);
    assert.match(f.messages.join('\n'), /cleanup failed: `supabase stop`/, name);
  }
  assert.notEqual(new Set(Object.values(EXIT)).size, 0);
  assert.equal(new Set(Object.values(EXIT)).size, Object.values(EXIT).length, 'exit codes are distinct');
});

// ---- the real script against fake executables --------------------------------------------------------------------

function withFakes<T>(mode: string, args: string[], fn: (r: { status: number | null; stderr: string; calls: string[] }) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hackass-dbtest-'));
  try {
    const logFile = join(dir, 'calls.log');
    writeFileSync(logFile, '');
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\necho "docker $*" >> "$FAKE_LOG"\n[ "$FAKE_MODE" = "no-docker" ] && exit 1\nexit 0\n');
    writeFileSync(join(dir, 'supabase'), [
      '#!/bin/sh', 'echo "supabase $*" >> "$FAKE_LOG"',
      'case "$1:$FAKE_MODE" in',
      '  start:start-fail) exit 1;;', '  start:start-hang) exec sleep 30;;', '  test:test-fail) exit 1;;', '  stop:stop-fail) exit 1;;', '  stop:stop-hang) exec sleep 30;;',
      'esac', 'exit 0', ''].join('\n'));
    chmodSync(join(dir, 'docker'), 0o755); chmodSync(join(dir, 'supabase'), 0o755);
    const r = spawnSync(process.execPath, ['scripts/db-test.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 60_000, env: { PATH: `${dir}:/bin:/usr/bin`, HOME: dir, FAKE_LOG: logFile, FAKE_MODE: mode } });
    return fn({ status: r.status, stderr: r.stderr, calls: readFileSync(logFile, 'utf8').split('\n').filter(Boolean) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const verbs = (calls: string[]) => calls.map((c) => c.split(' ').slice(0, 2).join(' '));

test('process level: success runs start, test and stop and exits 0', () => {
  withFakes('ok', [], (r) => { assert.equal(r.status, 0, r.stderr); assert.deepEqual(verbs(r.calls), ['docker info', 'supabase --version', 'supabase start', 'supabase test', 'supabase stop']); assert.ok(r.calls.at(-1)!.endsWith('stop --no-backup')); });
});

test('process level: a failing start, failing tests and failing stop give exit 3, 1 and 8, each still attempting the stop', () => {
  withFakes('start-fail', [], (r) => { assert.equal(r.status, 3); assert.deepEqual(verbs(r.calls).slice(-2), ['supabase start', 'supabase stop']); });
  withFakes('test-fail', [], (r) => { assert.equal(r.status, 1); assert.equal(verbs(r.calls).at(-1), 'supabase stop'); });
  withFakes('stop-fail', [], (r) => { assert.equal(r.status, 8); assert.match(r.stderr, /cleanup failed/); });
});

test('process level: a hung start is killed at its timeout (exit 4) and cleanup still runs; a hung stop is cut off (exit 8)', () => {
  const t0 = Date.now();
  withFakes('start-hang', ['--start-timeout-ms=400'], (r) => { assert.equal(r.status, 4, r.stderr); assert.match(r.stderr, /timed out after 400ms/); assert.equal(verbs(r.calls).at(-1), 'supabase stop'); });
  withFakes('stop-hang', ['--stop-timeout-ms=400'], (r) => { assert.equal(r.status, 8, r.stderr); assert.match(r.stderr, /timed out after 400ms/); });
  assert.ok(Date.now() - t0 < 20_000, 'hung commands must be cut off by their timeouts');
});

test('process level: missing Docker is BLOCKED (exit 2) and starts nothing', () => {
  withFakes('no-docker', [], (r) => { assert.equal(r.status, 2); assert.deepEqual(verbs(r.calls), ['docker info']); assert.match(r.stderr, /^BLOCKED/m); });
});
