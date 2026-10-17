// Common entry for every stage script: parse flags, take ONLY the documented variables from the environment, validate every target (H0), take the run's lock, check the gates,
// execute the stage, record the outcome. Exit codes: 0 all checks passed, 1 a check failed, 2 refused (target, gate, lock, SQL guard or flag), 3 error or timeout.
// A stage that started and then fails, throws or is interrupted is PERSISTED as failed/interrupted; nothing restarts it.
import { createContext, TargetRefused } from './context.mjs';
import { ENV_NAMES, REPO_ROOT } from './config.mjs';
import { checkGates, gitState, GateRefused } from './gates.mjs';
import { hashTargets, LockRefused, openRun } from './state.mjs';
import { redact } from './redact.mjs';
import { SqlRefused } from './sqlguard.mjs';
import { RECOVERY, STAGES } from './stages.mjs';
import { privateFileProblems } from './secretfile.mjs';
import { validateOwnerDate, DateRefused } from './dates.mjs';
import { readFileSync, writeSync } from 'node:fs';
import { killActiveChildren } from './exec.mjs';
import { reapInflightContainers } from './pg.mjs';

const FLAGS = new Set(['profile', 'run-id', 'authorized', 'confirm-mutating', 'owner-confirmed', 'allow-existing-schemas', 'default-window', 'owner-deletion-date', 'out', 'delete-raw', 'from-run', 'retry-after-review']);
export function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    const m = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(a);
    if (!m) throw new GateRefused(`unexpected argument: ${a}`);
    if (!FLAGS.has(m[1])) throw new GateRefused(`unknown flag --${m[1]}`);
    flags[m[1]] = m[2] === undefined ? true : m[2];
  }
  return flags;
}
const say = (s) => console.log(redact(s));

/** The documented variables only. A key may be given as the path of a file instead of a value; that file must be private (0600, owned by the caller, not a symlink, outside the checkout). */
export function readEnv(source = process.env, { repoRoot = REPO_ROOT, uid = process.getuid?.() } = {}) {
  const env = {};
  for (const n of ENV_NAMES) {
    if (source[n] !== undefined) env[n] = source[n];
    else if (/KEY$/.test(n) && source[`${n}_FILE`]) {
      const problems = privateFileProblems(source[`${n}_FILE`], { repoRoot, uid, label: `${n}_FILE` });
      if (problems.length) throw new GateRefused(problems.join('; '));
      try { env[n] = readFileSync(source[`${n}_FILE`], 'utf8').trim(); } catch { throw new GateRefused(`${n}_FILE cannot be read`); }
    }
  }
  return env;
}

/** The container cleanup of an interrupted stage could not be proved: the names, why, and one line to print and record. The stage stays interrupted (unsuccessful) either way. */
export function describeCleanup(unresolved) {
  const containers = unresolved.map(({ name, state, detail }) => ({ name, state, detail }));
  return { status: 'NOT PROVEN', containers, message: `cleanup NOT PROVEN: ${containers.map((c) => `${c.name} (${c.state}: ${c.detail})`).join('; ')}; check \`docker ps -a --filter name=hackass-psql-\` and remove any survivor before retrying` };
}
/** Persist the interruption: status 'interrupted' always, with the cleanup verdict in the error text (evidence lists it) and in a `cleanup` field when it is not proven. */
export function recordInterrupt(run, stage, sig, cleanup) {
  const s = run.state();
  s.stages[stage] = { ...s.stages[stage], status: 'interrupted', at: new Date().toISOString(), error: `received ${sig}${cleanup ? `; ${cleanup.message}` : ''}`.slice(0, 1000), ...(cleanup ? { cleanup: { status: cleanup.status, containers: cleanup.containers } } : {}) };
  run.save(s);
  run.log({ id: 'STAGE-ERROR', stage, status: 'FAIL', error: `interrupted by ${sig}` });
  if (cleanup) run.log({ id: 'CLEANUP-NOT-PROVEN', stage, status: 'FAIL', error: cleanup.message, containers: cleanup.containers });
  run.releaseLock();
}

export async function runStage(stage, argv, fn, { env = process.env, git = gitState(), repoRoot = REPO_ROOT } = {}) {
  let code = 3; let run = null; let started = false; let ctx = null;
  const onSignal = (sig) => () => {
    let unresolved = [];
    try { killActiveChildren(); unresolved = reapInflightContainers(); } catch (e) { unresolved = [{ name: '(unknown)', state: 'not-established', detail: `container cleanup raised ${e?.constructor?.name ?? 'an error'}` }]; }
    const cleanup = unresolved.length ? describeCleanup(unresolved) : null;
    if (cleanup) { try { writeSync(2, `${redact(cleanup.message)}\n`); } catch { /* stderr closed */ } } // printed whether or not a run exists; written synchronously because the process exits next
    try { if (run && started) recordInterrupt(run, stage, sig, cleanup); } catch { /* nothing more can be done */ }
    process.exit(130);
  };
  const handlers = { SIGINT: onSignal('SIGINT'), SIGTERM: onSignal('SIGTERM') };
  try {
    const flags = parseFlags(argv);
    const profile = flags.profile ?? 'staging';
    if (profile === 'selftest' && env.HOSTED_SELFTEST !== '1') throw new GateRefused('the selftest profile needs HOSTED_SELFTEST=1 (it is only for the disposable local stack)');
    const def = STAGES[stage];
    if (flags['owner-deletion-date'] !== undefined) { try { validateOwnerDate(flags['owner-deletion-date']); } catch (e) { if (e instanceof DateRefused) throw new GateRefused(e.message); throw e; } }
    run = openRun({ runId: flags['run-id'], profile, repoRoot });
    // The lock comes FIRST: a process that is refused it changes nothing in the run, not even its redaction state. Redaction is initialised under the lock, before any secret is registered.
    try { run.acquireLock({ takeoverDead: RECOVERY.has(stage) }); } catch (err) { if (err instanceof LockRefused) throw new GateRefused(err.message); throw err; }
    run.initRedaction();
    const e = readEnv(env, { repoRoot });
    if (!def.local) ctx = createContext(e, { profile, repoRoot }); // H0: throws TargetRefused before anything is contacted
    let state = run.state();
    for (const [k, s] of Object.entries(state.stages)) if (s.status === 'running') state.stages[k] = { ...s, status: 'interrupted', error: 'the process running this stage died or was killed' }; // an unfinished stage never restarts
    const targetsHash = ctx ? hashTargets(ctx.targets) : null;
    try { checkGates(stage, flags, state, git, { profile, targetsHash }); } finally { run.save(state); }
    if (!def.local && !state.binding) state.binding = { commit: git.head, profile, targets: targetsHash, at: new Date().toISOString() };
    if (stage === 'cleanup') state.closed = true; // from here on the run accepts no further fixture creation
    const history = (state.history = state.history ?? []);
    if (state.stages[stage]) history.push({ stage, ...state.stages[stage] });
    say(`stage ${stage} (${def.checks}) in run ${run.runId}, profile ${profile}, ${def.mutating ? 'MUTATING' : 'read-only'}`);
    state.stages[stage] = { status: 'running', at: new Date().toISOString(), commit: git.head };
    run.save(state);
    started = true;
    for (const [sig, h] of Object.entries(handlers)) process.on(sig, h);
    const outcome = await fn({ ctx, run, state, flags, profile, git, say, def });
    const fresh = run.state();
    fresh.stages[stage] = { status: outcome.failed === 0 ? 'done' : 'failed', at: new Date().toISOString(), commit: git.head, passed: outcome.passed, failed: outcome.failed };
    run.save(fresh);
    say(`stage ${stage}: ${outcome.passed} passed, ${outcome.failed} failed`);
    code = outcome.failed === 0 ? 0 : 1;
  } catch (e) {
    const refused = e instanceof TargetRefused || e instanceof GateRefused || e instanceof SqlRefused;
    const message = redact(`${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`);
    say(refused ? `REFUSED  ${e.message}` : `ERROR  ${message}`);
    code = refused ? 2 : 3;
    if (started && run) { // an exception after the stage began is a FAILURE of the stage, recorded and blocking
      try {
        const s = run.state(); s.stages[stage] = { ...s.stages[stage], status: 'failed', at: new Date().toISOString(), error: message.slice(0, 400) }; run.save(s);
        run.log({ id: 'STAGE-ERROR', stage, status: 'FAIL', error: message.slice(0, 400) });
      } catch { /* the run directory may be gone */ }
    }
  } finally {
    for (const [sig, h] of Object.entries(handlers)) process.off(sig, h);
    try { run?.releaseLock(); } catch { /* ignore */ }
  }
  return code;
}

/** Collects PASS/FAIL results of a stage; a thrown error inside a check is a FAIL with its (redacted) message. By default it stops after the first failure (the stop rule);
 *  `continueOnFail` is for cleanup only, where every independent step must be attempted. */
export function checker(run, say, { continueOnFail = false } = {}) {
  const out = { passed: 0, failed: 0, stopped: false };
  return {
    out,
    async check(id, title, fn) {
      if (out.stopped) { run.log({ id, status: 'SKIP', title, reason: 'an earlier check failed' }); say(`SKIP  ${id}  ${title}`); return; }
      const t0 = Date.now();
      try {
        const facts = await fn();
        out.passed++; run.log({ id, status: 'PASS', title, facts: facts ?? null, ms: Date.now() - t0 }); say(`PASS  ${id}  ${title}${facts ? `  [${facts}]` : ''}`);
      } catch (e) {
        out.failed++; if (!continueOnFail) out.stopped = true; run.log({ id, status: 'FAIL', title, error: String(e?.message ?? e), ms: Date.now() - t0 }); say(`FAIL  ${id}  ${title}  -> ${e?.message ?? e}`);
      }
    },
  };
}
export const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
export function finish(code) { process.exitCode = code; }
