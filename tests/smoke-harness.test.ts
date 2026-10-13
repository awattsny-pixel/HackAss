// Negative checks for the smoke harness itself. Each scenario runs tests/smoke/run.mjs with a stub in place of
// `next build` / `next start` (fast, no real build) and verifies: the right nonzero exit code, and that afterwards
// no child process, grandchild process, fixture server or temp directory is left behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const STUB = (n: string) => `tests/smoke/stubs/${n}.mjs`;
const EXIT = { OK: 0, BUILD_FAILED: 2, STARTUP_FAILED: 3, TIMEOUT_OR_ERROR: 4, TOTAL_DEADLINE: 5, NET_GUARD: 6, USAGE: 7, CLEANUP_FAILED: 8 };
const scratch = mkdtempSync(join(tmpdir(), 'hackass-harness-test-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

interface Run { code: number | null; out: string; stateFile: string }
function runHarness(name: string, args: string[], opts: { env?: Record<string, string>; onOutput?: (out: string, child: ReturnType<typeof spawn>) => void; sigtermWhenBuildStarted?: boolean; limitMs?: number } = {}): Promise<Run> {
  const stateFile = join(scratch, `${name}.state.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/smoke/run.mjs', `--state-file=${stateFile}`, ...args], { cwd: root, env: { ...process.env, ...opts.env } });
    let out = '';
    const onData = (d: Buffer) => { out += d; opts.onOutput?.(out, child); };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    if (opts.sigtermWhenBuildStarted) {
      // Poll the harness's state file; once the build child exists (plus a moment for its descendant), send SIGTERM.
      const poll = setInterval(() => {
        try { if (JSON.parse(readFileSync(stateFile, 'utf8')).children.length >= 1) { clearInterval(poll); setTimeout(() => child.kill('SIGTERM'), 700); } } catch { /* not written yet */ }
      }, 100);
      child.on('exit', () => clearInterval(poll));
    }
    const guard = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`harness did not exit within ${opts.limitMs ?? 60000}ms\n${out}`)); }, opts.limitMs ?? 60000);
    child.on('exit', (code) => { clearTimeout(guard); resolve({ code, out, stateFile }); });
  });
}

const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; } };
const connectRefused = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); resolve(false); });
  s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ECONNREFUSED'));
});

async function assertCleanedUp(r: Run) {
  const state = JSON.parse(readFileSync(r.stateFile, 'utf8'));
  assert.ok(state.children.length > 0 || state.fixturePort, 'state file should describe what was started');
  const pids = [...state.children.map((c: { pid: number }) => c.pid), ...[...r.out.matchAll(/GRANDCHILD:(\d+)/g)].map((m) => Number(m[1]))];
  for (let i = 0; i < 30 && !pids.every(gone); i++) await new Promise((res) => setTimeout(res, 100));
  for (const pid of pids) assert.ok(gone(pid), `process ${pid} still running after harness exit`);
  for (const c of state.children) { let alive = true; try { process.kill(-c.pid, 0); } catch { alive = false; } assert.equal(alive, false, `process group ${c.pid} still alive`); }
  assert.ok(await connectRefused(state.fixturePort), `fixture server still listening on ${state.fixturePort}`);
  if (state.appPort) assert.ok(await connectRefused(state.appPort), `app port ${state.appPort} still listening`);
  assert.equal(existsSync(state.tmpRoot), false, 'temporary directory not removed');
}

test('startup failure: app exits immediately -> exit 3, nothing left running', async () => {
  const r = await runHarness('startup-fail', [`--build-script=${STUB('build-ok')}`, `--app-script=${STUB('app-exit')}`]);
  assert.equal(r.code, EXIT.STARTUP_FAILED, r.out);
  assert.match(r.out, /app exited during startup/);
  await assertCleanedUp(r);
});

test('startup timeout: app never listens -> exit 3 within the deadline, process tree terminated', async () => {
  const t0 = Date.now();
  const r = await runHarness('startup-hang', [`--build-script=${STUB('build-ok')}`, `--app-script=${STUB('app-hang')}`, '--startup-timeout-ms=2000']);
  assert.equal(r.code, EXIT.STARTUP_FAILED, r.out);
  assert.match(r.out, /not ready within 2000ms/);
  assert.ok(Date.now() - t0 < 30000);
  assert.match(r.out, /GRANDCHILD:\d+/, 'stub should have spawned a descendant');
  await assertCleanedUp(r);
});

test('request timeout: app answers readiness but hangs on a check request -> exit 4, nothing left running', async () => {
  const r = await runHarness('request-timeout', [`--build-script=${STUB('build-ok')}`, `--app-script=${STUB('app-slow')}`, '--request-timeout-ms=1500']);
  assert.equal(r.code, EXIT.TIMEOUT_OR_ERROR, r.out);
  assert.match(r.out, /request timeout after 1500ms/);
  await assertCleanedUp(r);
});

test('build timeout: build never finishes -> exit 2 within the deadline, process tree terminated', async () => {
  const r = await runHarness('build-hang', [`--build-script=${STUB('build-hang')}`, `--app-script=${STUB('app-exit')}`, '--build-timeout-ms=1500']);
  assert.equal(r.code, EXIT.BUILD_FAILED, r.out);
  assert.match(r.out, /build exceeded 1500ms/);
  assert.match(r.out, /GRANDCHILD:\d+/);
  await assertCleanedUp(r);
});

test('build failure: nonzero build exit -> exit 2, app never started', async () => {
  const r = await runHarness('build-fail', [`--build-script=${STUB('app-exit')}`, `--app-script=${STUB('app-hang')}`]);
  assert.equal(r.code, EXIT.BUILD_FAILED, r.out);
  const state = JSON.parse(readFileSync(r.stateFile, 'utf8'));
  assert.deepEqual(state.children.map((c: { label: string }) => c.label), ['build']);
  await assertCleanedUp(r);
});

test('total deadline: whole run bounded -> exit 5, nothing left running', async () => {
  const r = await runHarness('total-deadline', [`--build-script=${STUB('build-hang')}`, `--app-script=${STUB('app-exit')}`, '--build-timeout-ms=60000', '--total-timeout-ms=2000']);
  assert.equal(r.code, EXIT.TOTAL_DEADLINE, r.out);
  assert.match(r.out, /total deadline/);
  await assertCleanedUp(r);
});

test('SIGTERM during the run: harness cleans up before exiting', async () => {
  const r = await runHarness('sigterm', [`--build-script=${STUB('build-hang')}`, `--app-script=${STUB('app-exit')}`, '--build-timeout-ms=60000'], { sigtermWhenBuildStarted: true });
  assert.equal(r.code, 143, r.out);
  await assertCleanedUp(r);
});

test('usage errors exit 7 without starting anything', async () => {
  const r = await runHarness('usage', ['--no-such-option=1']);
  assert.equal(r.code, EXIT.USAGE, r.out);
  assert.equal(existsSync(r.stateFile), false);
});

test('egress: a non-loopback connection attempt is blocked, recorded and fails the run (exit 6)', async () => {
  const r = await runHarness('egress', [`--build-script=${STUB('build-ok')}`, `--app-script=${STUB('app-egress')}`, '--request-timeout-ms=3000']);
  assert.equal(r.code, EXIT.NET_GUARD, r.out);
  assert.match(r.out, /EGRESS:blocked:/);
  assert.match(r.out, /network guard blocked \d+ non-loopback attempt/);
  assert.doesNotMatch(r.out, /EGRESS:unexpected-success/);
  await assertCleanedUp(r);
});

const CONTAMINATION: Record<string, string> = {
  VERCEL_URL: 'evil.invalid', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'evil.invalid',
  NEXT_PUBLIC_SUPABASE_URL: 'https://evil.invalid', SUPABASE_URL: 'https://evil.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'LIVE-KEY-CANARY', SUPABASE_SERVICE_KEY: 'LIVE-KEY-CANARY', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'LIVE-KEY-CANARY',
  DATABASE_URL: 'postgres://evil.invalid/db', HTTP_PROXY: 'http://evil.invalid:3128', HTTPS_PROXY: 'http://evil.invalid:3128',
  ALL_PROXY: 'http://evil.invalid:3128', NODE_EXTRA_CA_CERTS: '/evil.invalid/ca.pem', NODE_OPTIONS: '--max-old-space-size=96',
  AWS_SECRET_ACCESS_KEY: 'LIVE-KEY-CANARY', GITHUB_TOKEN: 'LIVE-KEY-CANARY',
};

test('contaminated environment: children receive only the constructed environment', async () => {
  const r = await runHarness('contaminated', [`--build-script=${STUB('build-ok')}`, `--app-script=${STUB('app-dump-env')}`], { env: CONTAMINATION });
  assert.equal(r.code, EXIT.STARTUP_FAILED, r.out);
  const m = r.out.match(/ENVDUMP:(\{.*\})/);
  assert.ok(m, 'app stub should print its environment');
  const childEnv = JSON.parse(m![1]) as Record<string, string>;
  const harness = await import(pathToFileURL(join(root, 'tests/smoke/harness.mjs')).href);
  const expected = harness.buildTestEnv({ fakePort: 1, netGuardPath: 'x', netGuardLog: 'x', home: 'x', tmp: 'x' });
  const allowed = new Set([...Object.keys(expected), '__CF_USER_TEXT_ENCODING']);
  for (const k of Object.keys(childEnv)) assert.ok(allowed.has(k), `unexpected variable reached the child: ${k}`);
  const text = JSON.stringify(childEnv);
  assert.ok(!/evil\.invalid|LIVE-KEY-CANARY/.test(text), 'contaminated value reached the child');
  for (const k of Object.keys(CONTAMINATION)) if (!(k in expected)) assert.ok(!(k in childEnv), `${k} leaked`);
  assert.match(childEnv.VERCEL_URL, /^127\.0\.0\.1:\d+$/);
  assert.match(childEnv.NEXT_PUBLIC_SUPABASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(childEnv.NODE_OPTIONS, /^--require="[^"]*net-guard\.cjs"$/);
  await assertCleanedUp(r);
});

test('buildTestEnv ignores the caller environment entirely', async () => {
  const harness = await import(pathToFileURL(join(root, 'tests/smoke/harness.mjs')).href);
  const saved = { ...process.env };
  try {
    Object.assign(process.env, CONTAMINATION);
    const env = harness.buildTestEnv({ fakePort: 4321, netGuardPath: '/g.cjs', netGuardLog: '/l', home: '/h', tmp: '/t' });
    assert.ok(!/evil\.invalid|LIVE-KEY-CANARY/.test(JSON.stringify(env)));
    assert.equal(env.VERCEL_URL, '127.0.0.1:4321');
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, 'dummy-service');
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'DATABASE_URL', 'NODE_EXTRA_CA_CERTS', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY']) assert.ok(!(k in env), k);
  } finally { for (const k of Object.keys(CONTAMINATION)) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; } }
});

test('cleanup failure: survivors after termination make the run fail (exit 8) and are named; success is never reported', async () => {
  // The harness runs with children that ignore termination signals (test double), so cleanup cannot remove them.
  const r = await runHarness('cleanup-fail', [`--build-script=${STUB('build-ok')}`, `--app-script=${STUB('app-hang')}`, '--startup-timeout-ms=1500', '--test-unkillable', '--terminate-grace-ms=200', '--terminate-wait-ms=400']);
  const state = JSON.parse(readFileSync(r.stateFile, 'utf8'));
  try {
    assert.equal(r.code, EXIT.CLEANUP_FAILED, r.out);
    assert.match(r.out, /cleanup failed: app \(pid \d+\)/);
    const app = state.children.find((c: { label: string }) => c.label === 'app');
    assert.ok(!gone(app.pid), 'the survivor should still be running (that is what the harness had to report)');
  } finally {
    // The test double deliberately leaked the stub; remove it here so the test leaves nothing behind.
    for (const c of state.children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* already gone */ } }
    for (const m of r.out.matchAll(/GRANDCHILD:(\d+)/g)) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch { /* already gone */ } }
    for (let i = 0; i < 30; i++) { if (state.children.every((c: { pid: number }) => gone(c.pid))) break; await new Promise((res) => setTimeout(res, 100)); }
  }
  for (const c of state.children) assert.ok(gone(c.pid), `test cleanup failed for pid ${c.pid}`);
});

test('cleanup failure is also reported when the run would otherwise exit with another code (startup timeout, exit 3 -> 8)', async () => {
  const r = await runHarness('cleanup-fail-precedence', [`--build-script=${STUB('build-ok')}`, `--app-script=${STUB('app-hang')}`, '--startup-timeout-ms=1000', '--test-unkillable', '--terminate-grace-ms=100', '--terminate-wait-ms=300']);
  const state = JSON.parse(readFileSync(r.stateFile, 'utf8'));
  try { assert.equal(r.code, EXIT.CLEANUP_FAILED, r.out); assert.match(r.out, /not ready within 1000ms/); }
  finally { for (const c of state.children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } } for (const m of r.out.matchAll(/GRANDCHILD:(\d+)/g)) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch { /* gone */ } } }
});

test('Managed.terminate resolves ok only when the process and its group are gone', async () => {
  const { Managed } = await import(pathToFileURL(join(root, 'tests/smoke/harness.mjs')).href);
  const stubbornEnv = { PATH: process.env.PATH ?? '' };
  const killable = new Managed('killable', process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, env: stubbornEnv });
  assert.deepEqual(await killable.terminate({ graceMs: 500, killWaitMs: 2000 }), { ok: true });
  const stubborn = new Managed('stubborn', process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, env: stubbornEnv, ignoreSignals: true });
  try {
    const r = await stubborn.terminate({ graceMs: 100, killWaitMs: 300 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /did not exit|still has live members/);
  } finally { try { process.kill(-stubborn.pid, 'SIGKILL'); } catch { /* gone */ } await stubborn.done; }
});
