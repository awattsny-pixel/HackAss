// Isolated local smoke check of the built application against controlled fixtures.
//
//   node tests/smoke/run.mjs [--build-timeout-ms=N] [--startup-timeout-ms=N] [--request-timeout-ms=N]
//                            [--total-timeout-ms=N] [--state-file=PATH]
//                            [--terminate-grace-ms=N] [--terminate-wait-ms=N] [--test-unkillable]   (test hooks)
//                            [--build-script=PATH --app-script=PATH]   (test hooks: replace next build / next start)
//
// Isolation: every child process gets an environment built from scratch (harness.mjs buildTestEnv) and a
// preloaded network guard that refuses non-loopback destinations; the run fails if the guard recorded any.
// Cleanup: children run in their own process groups and are terminated and awaited in `finally`.
// Exit codes: 0 ok, 1 checks failed, 2 build failed/timed out, 3 startup failed/timed out,
//             4 request timeout or harness error, 5 total deadline, 6 network-guard violation, 7 usage,
//             8 cleanup failed (a process, the fixture server or the temp directory could not be removed).
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFake, IDS, CANARY } from './fake-postgrest.mjs';
import { runChecks } from './checks.mjs';
import { EXIT, HarnessFailure, Managed, buildTestEnv, parseArgs } from './harness.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const netGuardPath = fileURLToPath(new URL('./net-guard.cjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let opts;
try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(EXIT.USAGE); }

const children = [];
let fake = null;
let tmpRoot = null;
let cleanupPromise = null;
let forcedExit = null; // set by deadline/signal/error handlers; always wins over the main flow's own outcome
const state = { fixturePort: null, appPort: null, tmpRoot: null, children: [] };
const saveState = async () => { if (opts.stateFile) await writeFile(opts.stateFile, JSON.stringify(state)).catch(() => {}); };

// Idempotent and shared: every caller awaits the same completed cleanup before the process exits. It resolves to a
// list of failures (empty = everything was terminated and removed); nothing is swallowed.
function cleanup() {
  cleanupPromise ??= (async () => {
    const failures = [];
    for (const c of children.slice().reverse()) {
      const r = await c.terminate({ graceMs: opts.terminateGraceMs, killWaitMs: opts.terminateWaitMs }).catch((e) => ({ ok: false, label: c.label, pid: c.pid, reason: String(e?.message || e) }));
      if (!r.ok) failures.push(`${r.label} (pid ${r.pid}): ${r.reason}`);
    }
    if (fake) { try { await fake.close(); } catch (e) { if (e?.code !== 'ERR_SERVER_NOT_RUNNING') failures.push(`fixture server: ${e?.message || e}`); } }
    if (tmpRoot) { try { await rm(tmpRoot, { recursive: true, force: true }); } catch (e) { failures.push(`temp directory ${tmpRoot}: ${e?.message || e}`); } }
    if (failures.length) console.error(`FAIL  cleanup failed: ${failures.join('; ')}`);
    return failures;
  })();
  return cleanupPromise;
}
// A failed cleanup always produces a nonzero result of its own, whatever the run's outcome was.
async function die(code) { forcedExit ??= code; const failures = await cleanup(); process.exit(failures.length ? EXIT.CLEANUP_FAILED : forcedExit); }

// Whole-run deadline, signal handling and unexpected errors all go through cleanup.
setTimeout(() => { console.error(`FAIL  total deadline of ${opts.totalTimeoutMs}ms exceeded`); die(EXIT.TOTAL_DEADLINE); }, opts.totalTimeoutMs).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => die(128 + (sig === 'SIGINT' ? 2 : 15)));
process.on('unhandledRejection', (e) => { console.error('FAIL  unhandled rejection:', e?.message || e); die(EXIT.TIMEOUT_OR_ERROR); });
process.on('uncaughtException', (e) => { console.error('FAIL  uncaught exception:', e?.message || e); die(EXIT.TIMEOUT_OR_ERROR); });

function track(label, file, args, env) {
  const m = new Managed(label, file, args, { cwd: root, env, ignoreSignals: opts.testUnkillable });
  children.push(m);
  state.children.push({ label, pid: m.pid });
  return m;
}

let exitCode = EXIT.TIMEOUT_OR_ERROR;
const results = []; let failed = 0;
try {
  fake = await startFake();
  state.fixturePort = fake.port;
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'hackass-smoke-'));
  state.tmpRoot = tmpRoot;
  const home = path.join(tmpRoot, 'home'); const tmp = path.join(tmpRoot, 'tmp');
  await mkdir(home); await mkdir(tmp);
  const netGuardLog = path.join(tmpRoot, 'netguard.log');
  await writeFile(netGuardLog, '');
  const appPort = await freePort();
  state.appPort = appPort;
  await saveState();
  const env = buildTestEnv({ fakePort: fake.port, netGuardPath, netGuardLog, home, tmp });
  const nextBin = path.join(root, 'node_modules/next/dist/bin/next');

  // --- build (asynchronous so the fixture server can answer requests made during the build)
  const buildArgs = opts.buildScript ? [path.resolve(root, opts.buildScript)] : [nextBin, 'build'];
  const build = track('build', process.execPath, buildArgs, env); await saveState();
  const { timedOut: buildTimedOut } = await build.waitExit(opts.buildTimeoutMs);
  if (buildTimedOut) throw new HarnessFailure(EXIT.BUILD_FAILED, `build exceeded ${opts.buildTimeoutMs}ms deadline\n--- build log tail ---\n${build.log}`);
  if (build.exitCode !== 0) throw new HarnessFailure(EXIT.BUILD_FAILED, `build exited with code ${build.exitCode}\n--- build log tail ---\n${build.log}`);

  // --- start and wait for readiness
  const appArgs = opts.appScript ? [path.resolve(root, opts.appScript), '-p', String(appPort), '-H', '127.0.0.1'] : [nextBin, 'start', '-p', String(appPort), '-H', '127.0.0.1'];
  const app = track('app', process.execPath, appArgs, env); await saveState();
  const base = `http://127.0.0.1:${appPort}`;
  const deadline = Date.now() + opts.startupTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (app.exited) throw new HarnessFailure(EXIT.STARTUP_FAILED, `app exited during startup with code ${app.exitCode}\n--- app log tail ---\n${app.log}`);
    try { const r = await fetch(`${base}/api/hacks`, { signal: AbortSignal.timeout(Math.min(opts.requestTimeoutMs, 2000)) }); await r.arrayBuffer(); if (r.status < 500) { ready = true; break; } } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!ready) throw new HarnessFailure(EXIT.STARTUP_FAILED, `app not ready within ${opts.startupTimeoutMs}ms\n--- app log tail ---\n${app.log}`);

  // --- checks (every request has a deadline; a timeout throws and aborts the run)
  const get = async (p, init = {}) => {
    const signal = AbortSignal.timeout(opts.requestTimeoutMs);
    try {
      const r = await fetch(base + p, { ...init, signal });
      const t = await r.text();
      return { status: r.status, text: t, json: () => JSON.parse(t) };
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new HarnessFailure(EXIT.TIMEOUT_OR_ERROR, `request timeout after ${opts.requestTimeoutMs}ms: ${init.method || 'GET'} ${p}`);
      throw e;
    }
  };
  const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
  try {
    await runChecks({ fake, IDS, CANARY, get, check });
  } catch (e) {
    if (e instanceof HarnessFailure) throw e;
    throw new HarnessFailure(EXIT.TIMEOUT_OR_ERROR, `check raised ${e?.name}: ${e?.message}\n--- app log tail ---\n${app.log}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  exitCode = failed ? EXIT.CHECKS_FAILED : EXIT.OK;
  if (failed) console.log('--- app log tail ---\n' + app.log.slice(-1500));
} catch (e) {
  exitCode = e instanceof HarnessFailure ? e.exitCode : EXIT.TIMEOUT_OR_ERROR;
  console.error(`FAIL  ${e?.message || e}`);
} finally {
  // Network-guard verdict is read before the temp dir is removed; it overrides other outcomes.
  let violations = [];
  try { if (tmpRoot) violations = (await readFile(path.join(tmpRoot, 'netguard.log'), 'utf8')).split('\n').filter(Boolean); } catch { /* no log */ }
  const cleanupFailures = await cleanup();
  if (cleanupFailures.length) forcedExit = EXIT.CLEANUP_FAILED;
  if (violations.length) { console.error(`FAIL  network guard blocked ${violations.length} non-loopback attempt(s): ${violations.slice(0, 5).join(' ')}`); exitCode = EXIT.NET_GUARD; }
}
process.exit(forcedExit ?? exitCode);
