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
  return { run, exec, calls, lines, messages };
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
      '#!/bin/sh', 'echo "supabase $*" >> "$FAKE_LOG"', 'if [ "$1" = "--version" ]; then echo "$FAKE_CLI_VERSION"; exit 0; fi',
      'case "$1:$FAKE_MODE" in',
      '  start:start-fail) exit 1;;', '  start:start-hang) exec sleep 30;;', '  test:test-fail) exit 1;;', '  stop:stop-fail) exit 1;;', '  stop:stop-hang) exec sleep 30;;',
      'esac', 'exit 0', ''].join('\n'));
    chmodSync(join(dir, 'docker'), 0o755); chmodSync(join(dir, 'supabase'), 0o755);
    const r = spawnSync(process.execPath, ['scripts/db-test.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 60_000, env: { PATH: `${dir}:/bin:/usr/bin`, HOME: dir, FAKE_LOG: logFile, FAKE_MODE: mode, SUPABASE_BIN: join(dir, 'supabase'), DOCKER_BIN: join(dir, 'docker'), FAKE_CLI_VERSION: JSON.parse(readFileSync(join(root, 'scripts/supabase-cli-pin.json'), 'utf8')).version } });
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

// ---- pinned CLI, Docker Desktop paths, and the optional follow-up steps -------------------------------------------------

const dbTest = await import(pathToFileURL(join(root, 'scripts/db-test.mjs')).href);
const cliPin = JSON.parse(readFileSync(join(root, 'scripts/supabase-cli-pin.json'), 'utf8'));

test('resolveTools: prefers the pinned local CLI, then Docker Desktop\'s own docker and per-user socket when PATH/var-run lack them', () => {
  const have = (...paths: string[]) => (p: string) => paths.includes(p);
  const local = join(root, '.tools', 'supabase', cliPin.version, 'supabase');
  const a = dbTest.resolveTools({ env: { PATH: '/usr/bin' }, exists: have(local), home: '/h', probe: () => true });
  assert.equal(a.supabase, local);
  assert.equal(a.docker, 'docker');
  assert.equal(a.env.DOCKER_HOST, undefined === a.env.DOCKER_HOST ? undefined : a.env.DOCKER_HOST);
  const dd = '/Applications/Docker.app/Contents/Resources/bin';
  const b = dbTest.resolveTools({ env: { PATH: '/usr/bin' }, exists: have(`${dd}/docker`, '/h/.docker/run/docker.sock'), home: '/h', probe: () => false });
  assert.equal(b.docker, `${dd}/docker`);
  assert.ok(b.env.PATH.startsWith(`${dd}:`));
  assert.equal(b.env.DOCKER_HOST, 'unix:///h/.docker/run/docker.sock');
  assert.equal(b.supabase, 'supabase');
  const c = dbTest.resolveTools({ env: { PATH: '/usr/bin', SUPABASE_BIN: '/x/supabase', DOCKER_HOST: 'unix:///custom.sock' }, exists: have(local, '/h/.docker/run/docker.sock'), home: '/h', probe: () => true });
  assert.equal(c.supabase, '/x/supabase', 'an explicit override wins');
  assert.equal(c.env.DOCKER_HOST, 'unix:///custom.sock', 'an explicit DOCKER_HOST is never overwritten');
  assert.equal(c.cliVersion, cliPin.version);
  const d = dbTest.resolveTools({ env: { PATH: '/usr/bin', DOCKER_BIN: '/opt/custom/docker' }, exists: have(`${dd}/docker`), home: '/h', probe: () => false });
  assert.equal(d.docker, '/opt/custom/docker', 'an explicit DOCKER_BIN beats the Docker Desktop fallback');
});

test('a Supabase CLI that is not the pinned version is BLOCKED before anything starts', () => {
  const calls: string[] = [];
  const exec = (cmd: string, args: string[]) => { calls.push([cmd, ...args].join(' ')); return { status: 0, stdout: args[0] === '--version' ? '2.1.0\n' : '' }; };
  const messages: string[] = [];
  const code = runDbTests({ exec, env: {}, expectCliVersion: cliPin.version, log: { info: (m: string) => messages.push(m), error: (m: string) => messages.push(m) } });
  assert.equal(code, EXIT.BLOCKED);
  assert.match(messages.join('\n'), /not the pinned/);
  assert.ok(!calls.some((c) => c.includes('start')));
  const good = fake();
  const okCode = runDbTests({ exec: (c: string, a: string[]) => ({ status: 0, stdout: a[0] === '--version' ? `${cliPin.version}\n` : '' }), env: {}, expectCliVersion: cliPin.version });
  assert.equal(okCode, EXIT.OK);
  assert.equal(good.run(), EXIT.OK);
});

test('follow-up steps run only after passing tests, share the cleanup guarantee, and map failure/timeout to exit 1/4', () => {
  const step = { name: 'auth checks', cmd: 'node', args: ['spikes'], timeoutMs: 1234 };
  const withSteps = (responses: Record<string, Result>) => { const f = fake(responses); const code = runDbTests({ exec: f.exec, env: {}, extraSteps: [step], log: { info: () => {}, error: (m: string) => f.messages.push(m) } }); return { f, code }; };
  const passing = withSteps({});
  assert.equal(passing.code, EXIT.OK);
  assert.deepEqual(passing.f.lines().slice(-2), ['node spikes', 'supabase stop --no-backup']);
  assert.equal(passing.f.calls.find((c) => c.line === 'node spikes')!.timeoutMs, 1234);
  const failing = withSteps({ 'node spikes': FAIL });
  assert.equal(failing.code, EXIT.TESTS_FAILED);
  assert.ok(has(failing.f, 'supabase stop --no-backup'));
  assert.equal(withSteps({ 'node spikes': TIMEOUT }).code, EXIT.TIMEOUT);
  const skipped = withSteps({ 'supabase test db': FAIL });
  assert.ok(!has(skipped.f, 'node spikes'), 'steps are skipped when the pgTAP tests failed');
  assert.equal(withSteps({ 'node spikes': FAIL, 'supabase stop': FAIL }).code, EXIT.CLEANUP_FAILED);
});

test('the Supabase CLI installer follows the same rules as the Gitleaks one: pinned URL, digest checked before extraction, version verified', async () => {
  const installer = await import(pathToFileURL(join(root, 'scripts/install-supabase-cli.mjs')).href);
  const { createHash } = await import('node:crypto');
  const data = Buffer.from('cli-archive');
  const fakePin = { version: '9.9.9', downloadBase: 'https://example.invalid/cli/', assets: { 'linux-x64': { file: 'c.tgz', sha256: createHash('sha256').update(data).digest('hex') } } };
  const base = mkdtempSync(join(tmpdir(), 'hackass-sbcli-'));
  try {
    await assert.rejects(() => installer.installSupabaseCli({ pin: fakePin, base, platform: 'linux', arch: 'x64', fetchBuffer: async () => Buffer.from('tampered'), extract: () => { throw new Error('must not extract'); }, versionOf: () => '9.9.9' }), /SHA-256 mismatch/);
    const urls: string[] = [];
    const ok = await installer.installSupabaseCli({ pin: fakePin, base, platform: 'linux', arch: 'x64', fetchBuffer: async (u: string) => { urls.push(u); return data; }, extract: (_a: string, d: string) => writeFileSync(join(d, 'supabase'), '#!/bin/sh\n'), versionOf: () => '9.9.9' });
    assert.deepEqual(urls, ['https://example.invalid/cli/c.tgz']);
    assert.equal(ok.downloaded, true);
    await assert.rejects(() => installer.installSupabaseCli({ pin: fakePin, base: mkdtempSync(join(tmpdir(), 'hackass-sbcli2-')), platform: 'win32', arch: 'x64' }), (await import(pathToFileURL(join(root, 'scripts/install-gitleaks.mjs')).href)).UnsupportedPlatform);
  } finally { rmSync(base, { recursive: true, force: true }); }
  assert.equal(cliPin.downloadBase, `https://github.com/supabase/cli/releases/download/v${cliPin.version}/`);
  for (const [key, a] of Object.entries(cliPin.assets) as [string, { file: string; sha256: string }][]) { assert.match(a.sha256, /^[0-9a-f]{64}$/, key); assert.ok(a.file.includes(cliPin.version)); }
});

test('the local Auth check script prints facts only: it never logs keys, tokens or passwords, and it removes its probe functions', () => {
  const src = readFileSync(join(root, 'scripts/local-auth-spikes.mjs'), 'utf8');
  for (const m of src.matchAll(/console\.(?:log|error)\(([^;]*)\);/g)) assert.ok(!/\b(PUB|SECRET|JWT_SECRET|password|access_token|refresh_token|token)\b(?!\s*:)/i.test(m[1].replace(/`[^`]*`/g, (t) => t.replace(/\$\{[^}]*\}/g, (e) => (/(PUB|SECRET|JWT_SECRET|\.password|access_token|refresh_token|\btoken\b)/.test(e) ? e : '')))), `possible secret in log call: ${m[1].slice(0, 80)}`);
  assert.match(src, /drop function if exists public\.hackass_probe_claims\(\), public\.hackass_probe_session_alive\(\)/);
});
