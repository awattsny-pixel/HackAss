// Common entry for every stage script: parse flags, take ONLY the documented variables from the environment, validate every target (H0), check the gates,
// open the run, execute the stage, record the outcome. Exit codes: 0 all checks passed, 1 a check failed, 2 refused (target, gate or SQL guard), 3 error or timeout.
import { readFileSync } from 'node:fs';
import { createContext, TargetRefused } from './context.mjs';
import { ENV_NAMES, REPO_ROOT } from './config.mjs';
import { checkGates, gitState, GateRefused } from './gates.mjs';
import { openRun } from './state.mjs';
import { redact } from './redact.mjs';
import { SqlRefused } from './sqlguard.mjs';
import { STAGES } from './stages.mjs';

export function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    const m = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(a);
    if (!m) throw new GateRefused(`unexpected argument: ${a}`);
    flags[m[1]] = m[2] === undefined ? true : m[2];
  }
  return flags;
}
const say = (s) => console.log(redact(s));

export function readEnv(source = process.env) {
  const env = {};
  for (const n of ENV_NAMES) {
    if (source[n] !== undefined) env[n] = source[n];
    else if (/KEY$/.test(n) && source[`${n}_FILE`]) { // a key may be given as the path of a file (outside the repository) instead of a value
      try { env[n] = readFileSync(source[`${n}_FILE`], 'utf8').trim(); } catch { throw new GateRefused(`${n}_FILE cannot be read`); }
    }
  }
  return env;
}

export async function runStage(stage, argv, fn, { env = process.env, git = gitState(), repoRoot = REPO_ROOT } = {}) {
  let code = 3;
  try {
    const flags = parseFlags(argv);
    const profile = flags.profile ?? 'staging';
    if (profile === 'selftest' && env.HOSTED_SELFTEST !== '1') throw new GateRefused('the selftest profile needs HOSTED_SELFTEST=1 (it is only for the disposable local stack)');
    const def = STAGES[stage];
    const run = openRun({ runId: flags['run-id'], profile, repoRoot });
    const state = run.state();
    const e = readEnv(env);
    let ctx = null;
    if (!def.local) ctx = createContext(e, { profile, repoRoot }); // H0: throws TargetRefused before anything is contacted
    checkGates(stage, flags, state, git, { profile });
    say(`stage ${stage} (${def.checks}) in run ${run.runId}, profile ${profile}, ${def.mutating ? 'MUTATING' : 'read-only'}`);
    state.stages[stage] = { status: 'running', at: new Date().toISOString(), commit: git.head };
    run.save(state);
    const outcome = await fn({ ctx, run, state, flags, profile, git, say, def });
    const fresh = run.state();
    fresh.stages[stage] = { status: outcome.failed === 0 ? 'done' : 'failed', at: new Date().toISOString(), commit: git.head, passed: outcome.passed, failed: outcome.failed };
    run.save(fresh);
    say(`stage ${stage}: ${outcome.passed} passed, ${outcome.failed} failed`);
    code = outcome.failed === 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof TargetRefused) { say(`REFUSED  ${e.message}`); code = 2; }
    else if (e instanceof GateRefused || e instanceof SqlRefused) { say(`REFUSED  ${e.message}`); code = 2; }
    else { say(`ERROR  ${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`); code = 3; }
  }
  return code;
}

/** Collects PASS/FAIL results of a stage; a thrown error inside a check is a FAIL with its (redacted) message. Stops after the first failure (the stop rule). */
export function checker(run, say) {
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
        out.failed++; out.stopped = true; run.log({ id, status: 'FAIL', title, error: String(e?.message ?? e), ms: Date.now() - t0 }); say(`FAIL  ${id}  ${title}  -> ${e?.message ?? e}`);
      }
    },
  };
}
export const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
export function finish(code) { process.exitCode = code; }
