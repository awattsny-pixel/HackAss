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

/** A child process in its own process group, with bounded log capture and awaitable termination. */
export class Managed {
  constructor(label, file, args, { cwd, env, ignoreSignals = false }) {
    this.ignoreSignals = ignoreSignals; // test double: simulates a process tree that cannot be terminated
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
  /** Signal the whole process group; ESRCH (already gone) is fine. */
  signalGroup(sig) { if (this.ignoreSignals) return; try { process.kill(-this.pid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  groupAlive() { try { process.kill(-this.pid, 0); return true; } catch { return false; } }
  /**
   * Stop the process and any descendants and wait until they are gone. Resolves { ok: true } only when the
   * process has exited AND its process group is empty; otherwise { ok: false, label, pid, reason } so the caller
   * can fail the run. It never reports success while something is still running.
   */
  async terminate({ graceMs = 2500, killWaitMs = 5000 } = {}) {
    if (!this.exited || this.groupAlive()) {
      this.signalGroup('SIGTERM');
      await Promise.race([this.done, sleep(graceMs)]);
      this.signalGroup('SIGKILL'); // also reaps descendants that outlived the leader
      await Promise.race([this.done, sleep(killWaitMs)]);
      const until = Date.now() + killWaitMs;
      while (this.groupAlive() && Date.now() < until) await sleep(100);
    }
    if (!this.exited) return { ok: false, label: this.label, pid: this.pid, reason: 'process did not exit' };
    if (this.groupAlive()) return { ok: false, label: this.label, pid: this.pid, reason: 'process group still has live members' };
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
  const o = { buildScript: null, appScript: null, buildTimeoutMs: 300000, startupTimeoutMs: 60000, requestTimeoutMs: 10000, totalTimeoutMs: 900000, stateFile: null, testUnkillable: false, terminateGraceMs: 2500, terminateWaitMs: 5000 };
  const num = (k, v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new HarnessFailure(EXIT.USAGE, `invalid value for --${k}: ${v}`); return n; };
  for (const a of argv) {
    if (a === '--test-unkillable') { o.testUnkillable = true; continue; } // test hook: children ignore termination signals
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
