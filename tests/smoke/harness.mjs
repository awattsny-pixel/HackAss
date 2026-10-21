// Smoke-harness support: explicit environment, deadlines, and process-group lifecycle control.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

export const EXIT = { OK: 0, CHECKS_FAILED: 1, BUILD_FAILED: 2, STARTUP_FAILED: 3, TIMEOUT_OR_ERROR: 4, TOTAL_DEADLINE: 5, NET_GUARD: 6, USAGE: 7, CLEANUP_FAILED: 8 };

export class HarnessFailure extends Error {
  constructor(exitCode, message) { super(message); this.exitCode = exitCode; }
}

/**
 * The complete environment for every process the harness starts. Built from scratch: nothing is inherited
 * from the parent process, so deployment URLs, credentials, proxies and NODE_OPTIONS in the caller's
 * environment cannot influence a request. VERCEL_URL (the landing page's self-fetch target) is pointed at
 * the fixture server so the default of localhost:3000 is never contacted.
 */
export function buildTestEnv({ fakePort, netGuardPath, netGuardLog, home, tmp, nodeBinDir = dirname(process.execPath) }) {
  const fixture = `http://127.0.0.1:${fakePort}`;
  return {
    PATH: `${nodeBinDir}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: tmp,
    NODE_ENV: 'production',
    // The smoke run exercises the legacy API routes against a local fixture. The private-preview gate (next.config.js) blocks those routes in every mode except an explicit local/ci, and an unset APP_ENV fails
    // CLOSED into the gated build; so this isolated harness, and only this harness, selects the existing open test mode. The preview/production build never sets it (scripts/check-env.mjs, tests/preview-gate.test.ts).
    APP_ENV: 'ci',
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: `--require=${JSON.stringify(netGuardPath)}`,
    SMOKE_NETGUARD_LOG: netGuardLog,
    NEXT_PUBLIC_SUPABASE_URL: fixture,
    SUPABASE_URL: fixture,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'dummy-anon',
    SUPABASE_SERVICE_KEY: 'dummy-service',
    SUPABASE_SERVICE_ROLE_KEY: 'dummy-service',
    VERCEL_URL: `127.0.0.1:${fakePort}`,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TAIL = 12000;

/**
 * A child process in its own process group, with bounded log capture and awaitable termination.
 *
 * Signalling the group is classified, never assumed: 'gone' (ESRCH: no member exists), 'alive' (signal 0 succeeded: at least one live member) or an error code.
 * EPERM needs care. On macOS kill(-pgid, sig) fails with EPERM, even for signal 0 and for our own children, while the group's only remaining member is a zombie, i.e.
 * the leader was killed but this process has not yet reaped it (the 'exit' event has not run). That is a transient state that ends when the exit is observed. EPERM after
 * the leader has been reaped has no such explanation; it is reported as a failure and is never counted as a successful termination.
 */
export class Managed {
  constructor(label, file, args, { cwd, env, ignoreSignals = false, killFn = process.kill.bind(process) }) {
    this.ignoreSignals = ignoreSignals; // test double: simulates a process tree that cannot be terminated
    this.kill = killFn; // injectable so tests can produce exact permission outcomes; only ever called with -this.pid (our own group) and signals
    this.label = label; this.log = ''; this.exited = false; this.exitCode = null;
    this.child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.pid = this.child.pid;
    const add = (d) => { this.log = (this.log + d).slice(-TAIL); };
    this.child.stdout.on('data', add); this.child.stderr.on('data', add);
    this.done = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => { this.exited = true; this.exitCode = code ?? (signal ? 128 : null); resolve(); });
      this.child.on('error', (e) => { this.log += `\nspawn error: ${e.message}`; this.exited = true; this.exitCode = 127; resolve(); });
    });
  }
  /** Signal the whole process group. Returns 'sent', 'gone' (ESRCH) or the error code (EPERM or anything else); it never throws. */
  signalGroup(sig) {
    if (this.ignoreSignals) return 'sent';
    try { this.kill(-this.pid, sig); return 'sent'; } catch (e) { return e?.code === 'ESRCH' ? 'gone' : String(e?.code ?? e?.message ?? 'ERROR'); }
  }
  /** 'gone', 'alive' or an error code, without sending anything. */
  groupState() {
    try { this.kill(-this.pid, 0); return 'alive'; } catch (e) { return e?.code === 'ESRCH' ? 'gone' : String(e?.code ?? e?.message ?? 'ERROR'); }
  }
  /** A group call that failed with EPERM before the leader was reaped is retried once the exit has been observed (bounded by `waitMs`). */
  async settle(result, redo, waitMs) {
    if (result !== 'EPERM' || this.exited) return result;
    await Promise.race([this.done, sleep(waitMs)]);
    return this.exited ? redo() : result;
  }
  /**
   * Stop the process and any descendants and wait until they are gone. Resolves { ok: true } only when the
   * process has exited AND its process group is provably empty (ESRCH); otherwise { ok: false, label, pid, reason } so the caller
   * can fail the run. It never reports success while something is still running or while the group's state is unknown.
   */
  async terminate({ graceMs = 2500, killWaitMs = 5000 } = {}) {
    const probe = () => this.settle(this.groupState(), () => this.groupState(), killWaitMs);
    if (!this.exited || (await probe()) !== 'gone') {
      await this.settle(this.signalGroup('SIGTERM'), () => this.signalGroup('SIGTERM'), killWaitMs);
      await Promise.race([this.done, sleep(graceMs)]);
      await this.settle(this.signalGroup('SIGKILL'), () => this.signalGroup('SIGKILL'), killWaitMs); // also reaps descendants that outlived the leader
      await Promise.race([this.done, sleep(killWaitMs)]);
      const until = Date.now() + killWaitMs;
      while ((await probe()) === 'alive' && Date.now() < until) await sleep(100);
    }
    if (!this.exited) return { ok: false, label: this.label, pid: this.pid, reason: 'process did not exit' };
    // HARDENING (PX-3e; the mechanism of the observed exit-8 failure was NOT demonstrated, this is a bounded tolerance for a transient EPERM that outlives the leader's reaping, e.g. a late-reaped
    // zombie descendant): retry EPERM for the same killWaitMs budget. A persistent EPERM still fails the cleanup below once the budget is spent.
    let state = await probe();
    const epermUntil = Date.now() + killWaitMs;
    while (state === 'EPERM' && Date.now() < epermUntil) { await sleep(50); state = await probe(); }
    if (state === 'alive') return { ok: false, label: this.label, pid: this.pid, reason: 'process group still has live members' };
    if (state !== 'gone') return { ok: false, label: this.label, pid: this.pid, reason: `process group state unknown after the leader exited: kill ${state} (leader reaped=${this.exited}, exitCode=${this.exitCode}; a permission or system error is not a successful cleanup)` };
    return { ok: true };
  }
  /** Wait for exit up to `ms`. Resolves { timedOut }. */
  async waitExit(ms) {
    let timer;
    const timedOut = await Promise.race([this.done.then(() => false), new Promise((r) => { timer = setTimeout(() => r(true), ms); })]);
    clearTimeout(timer);
    return { timedOut };
  }
}

export function parseArgs(argv) {
  const o = { buildScript: null, appScript: null, buildTimeoutMs: 300000, startupTimeoutMs: 60000, requestTimeoutMs: 10000, totalTimeoutMs: 900000, stateFile: null, testUnkillable: false, terminateGraceMs: 2500, terminateWaitMs: 5000, testKillEperm: null };
  const num = (k, v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new HarnessFailure(EXIT.USAGE, `invalid value for --${k}: ${v}`); return n; };
  for (const a of argv) {
    if (a === '--test-unkillable') { o.testUnkillable = true; continue; } // test hook: children ignore termination signals
    if (a === '--test-kill-eperm=transient' || a === '--test-kill-eperm=persistent') { o.testKillEperm = a.split('=')[1]; continue; } // test hook: group signals report EPERM
    const m = a.match(/^--([a-z-]+)=(.*)$/);
    if (!m) throw new HarnessFailure(EXIT.USAGE, `unknown argument: ${a}`);
    const [, k, v] = m;
    if (k === 'build-script') o.buildScript = v;
    else if (k === 'app-script') o.appScript = v;
    else if (k === 'state-file') o.stateFile = v;
    else if (k === 'build-timeout-ms') o.buildTimeoutMs = num(k, v);
    else if (k === 'startup-timeout-ms') o.startupTimeoutMs = num(k, v);
    else if (k === 'request-timeout-ms') o.requestTimeoutMs = num(k, v);
    else if (k === 'total-timeout-ms') o.totalTimeoutMs = num(k, v);
    else if (k === 'terminate-grace-ms') o.terminateGraceMs = num(k, v);
    else if (k === 'terminate-wait-ms') o.terminateWaitMs = num(k, v);
    else throw new HarnessFailure(EXIT.USAGE, `unknown option: --${k}`);
  }
  return o;
}

/**
 * Test double for the group-signal permission error. The REAL group is still killed (nothing leaks), but the call reports EPERM:
 * 'transient' once (the macOS unreaped-leader window), 'persistent' on every group call (nothing explains it).
 */
export function epermKill(mode) {
  let used = false;
  return (pid, sig) => {
    if (pid < 0 && (mode === 'persistent' || !used)) {
      used = true;
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' });
    }
    return process.kill(pid, sig);
  };
}
