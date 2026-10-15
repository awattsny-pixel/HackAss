// Regression coverage for the intermittent "cleanup failed: app (pid N): kill EPERM" failure of the smoke harness (a request timeout, exit 4, came back as exit 8).
//
// Cause (established on Darwin 24.6 with a probe, see docs/foundation/f2-closeout.md): when the process-group LEADER has been killed but its parent has not yet reaped it
// (the child is a zombie and the 'exit' event has not run), kill(-pgid, sig) fails with EPERM on macOS, even for signal 0, although the group belongs to the same user.
// The harness treated every non-ESRCH error as fatal, so a termination that had in fact succeeded was reported as a cleanup failure.
//
// These tests use controlled process behaviour, not timing: the zombie window is produced by blocking this process's event loop right after an external SIGKILL, and the
// permission outcomes are injected through the `killFn` option. They pin the required behaviour: a transient EPERM while the leader is unreaped is waited out; an EPERM that
// persists after the leader was reaped is NEVER reported as success.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const harnessUrl = pathToFileURL(join(root, 'tests/smoke/harness.mjs')).href;
const STUB = (n: string) => `tests/smoke/stubs/${n}.mjs`;
const SPIN = ['-e', 'setInterval(()=>{},1000)'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; } };
const eperm = () => Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' });
const blockEventLoop = (ms: number) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { /* the leader stays an unreaped zombie meanwhile */ } };

test('an unreaped (zombie) group leader does not make terminate() fail: the termination had succeeded', async () => {
  const { Managed } = await import(harnessUrl);
  const m = new Managed('zombie-leader', process.execPath, SPIN, { cwd: root, env: { PATH: process.env.PATH ?? '' } });
  await sleep(400); // the child is running
  process.kill(m.pid, 'SIGKILL'); // killed from outside (as in the harness when the app dies on its own), not yet reaped by this process
  blockEventLoop(250);
  const r = await m.terminate({ graceMs: 500, killWaitMs: 3000 });
  assert.deepEqual(r, { ok: true });
  assert.ok(gone(m.pid));
});

test('EPERM while the leader is unreaped is waited out (retried after the exit is observed); the run is not failed', async () => {
  const { Managed } = await import(harnessUrl);
  const calls: Array<[number, string | number]> = [];
  let first = true;
  const killFn = (pid: number, sig: string | number) => {
    calls.push([pid, sig]);
    if (pid < 0 && first) { first = false; process.kill(pid, 'SIGKILL'); throw eperm(); } // the group dies, but the call reports the macOS zombie error
    return process.kill(pid, sig as NodeJS.Signals);
  };
  const m = new Managed('transient', process.execPath, SPIN, { cwd: root, env: { PATH: process.env.PATH ?? '' }, killFn });
  await sleep(300);
  assert.deepEqual(await m.terminate({ graceMs: 500, killWaitMs: 3000 }), { ok: true });
  assert.ok(gone(m.pid));
  assert.ok(calls.every(([pid]) => pid === -m.pid || pid === m.pid), 'only the harness child and its own process group were ever signalled');
});

test('EPERM that persists after the leader was reaped is a genuine failure and is NEVER reported as success', async () => {
  const { Managed } = await import(harnessUrl);
  // Test double: the real group is killed (so nothing leaks), but every group call reports EPERM, as if the group could not be inspected.
  const killFn = (pid: number, sig: string | number) => { if (pid < 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } throw eperm(); } return process.kill(pid, sig as NodeJS.Signals); };
  const m = new Managed('permission', process.execPath, SPIN, { cwd: root, env: { PATH: process.env.PATH ?? '' }, killFn });
  await sleep(300);
  const r = await m.terminate({ graceMs: 300, killWaitMs: 1500 });
  assert.equal(r.ok, false, 'an unexplained permission error must not count as a clean termination');
  assert.match(String(r.reason), /EPERM/);
  assert.equal(r.label, 'permission');
  assert.equal(r.pid, m.pid);
});

test('a genuine error other than ESRCH/EPERM is reported as a failure, not thrown past the cleanup report', async () => {
  const { Managed } = await import(harnessUrl);
  const killFn = (pid: number, sig: string | number) => { if (pid < 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } throw Object.assign(new Error('boom'), { code: 'EINVAL' }); } return process.kill(pid, sig as NodeJS.Signals); };
  const m = new Managed('other-error', process.execPath, SPIN, { cwd: root, env: { PATH: process.env.PATH ?? '' }, killFn });
  await sleep(300);
  const r = await m.terminate({ graceMs: 300, killWaitMs: 1500 });
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /EINVAL/);
});

test('only processes the harness started are signalled: an unrelated process group is untouched by terminate()', async () => {
  const { Managed } = await import(harnessUrl);
  const bystander = spawn(process.execPath, SPIN, { detached: true, stdio: 'ignore' });
  try {
    const signalled: number[] = [];
    const killFn = (pid: number, sig: string | number) => { signalled.push(pid); return process.kill(pid, sig as NodeJS.Signals); };
    const m = new Managed('own', process.execPath, SPIN, { cwd: root, env: { PATH: process.env.PATH ?? '' }, killFn });
    await sleep(300);
    assert.deepEqual(await m.terminate({ graceMs: 500, killWaitMs: 2000 }), { ok: true });
    assert.ok(signalled.length > 0 && signalled.every((p) => Math.abs(p) === m.pid), `signalled ${signalled.join(',')} but only ${m.pid} (own group) is allowed`);
    assert.ok(!gone(bystander.pid!), 'the bystander process group was not touched');
  } finally { try { process.kill(-bystander.pid!, 'SIGKILL'); } catch { /* gone */ } }
});

// ---- end to end: the exit code keeps the request timeout (4) distinct from a genuine cleanup failure (8) -----------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'hackass-cleanup-test-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
function run(name: string, args: string[]): Promise<{ code: number | null; out: string; stateFile: string }> {
  const stateFile = join(scratch, `${name}.state.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/smoke/run.mjs', `--state-file=${stateFile}`, ...args], { cwd: root });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const guard = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`harness did not exit\n${out}`)); }, 60000);
    child.on('exit', (code) => { clearTimeout(guard); resolve({ code, out, stateFile }); });
  });
}
const BASE = [`--build-script=${STUB('build-ok')}`, `--app-script=${STUB('app-slow')}`, '--request-timeout-ms=1500'];

test('request timeout with a transient zombie EPERM during cleanup still exits 4 (the timeout), nothing left running', async () => {
  const r = await run('timeout-transient-eperm', [...BASE, '--test-kill-eperm=transient']);
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /request timeout after 1500ms/);
  assert.doesNotMatch(r.out, /cleanup failed/);
  const state = JSON.parse(readFileSync(r.stateFile, 'utf8'));
  for (const c of state.children) assert.ok(gone(c.pid), `pid ${c.pid} still running`);
});

test('request timeout with an EPERM that persists exits 8, names the permission error AND still reports the timeout', async () => {
  const r = await run('timeout-persistent-eperm', [...BASE, '--test-kill-eperm=persistent', '--terminate-grace-ms=300', '--terminate-wait-ms=1500']);
  assert.equal(r.code, 8, r.out);
  assert.match(r.out, /request timeout after 1500ms/);
  assert.match(r.out, /cleanup failed: .*EPERM/);
  const state = JSON.parse(readFileSync(r.stateFile, 'utf8'));
  for (const c of state.children) assert.ok(gone(c.pid), `pid ${c.pid} still running (the test double kills the real group)`);
});
