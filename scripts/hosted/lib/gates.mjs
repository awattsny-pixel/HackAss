// Execution gates. A stage runs only if (1) its targets passed H0, (2) the caller names the exact commit being run and it is HEAD of a clean tree,
// (3) a mutating stage is additionally confirmed by name, (4) the run is bound to this commit, profile and validated target configuration, (5) no stage of the run is
// failed, interrupted or unfinished (only cleanup and evidence may continue such a run; a read-only stage may be re-attempted after review, with --retry-after-review),
// (6) the stages it depends on are complete in this run under this commit, and (7) any owner action it depends on is confirmed. Fail closed throughout.
import { spawnSync } from 'node:child_process';
import { STAGES, GROUPS, REREADABLE, RECOVERY, RETRYABLE_AFTER_REVIEW } from './stages.mjs';
import { REPO_ROOT } from './config.mjs';

export class GateRefused extends Error {}
const UNHEALTHY = new Set(['failed', 'interrupted', 'running']);

/** HEAD and cleanliness, from git subprocesses that are bounded (killed after `timeoutMs`), never prompt, and start from a minimal environment. A failure yields head '' (refused by the gates). */
export function gitState(repoRoot = REPO_ROOT, { timeoutMs = 10_000 } = {}) {
  const opts = { cwd: repoRoot, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } };
  const head = spawnSync('git', ['rev-parse', 'HEAD'], opts);
  if (head.error || head.status !== 0) return { head: '', clean: false, error: head.error?.code === 'ETIMEDOUT' ? 'git timed out' : 'git failed' };
  const dirty = spawnSync('git', ['status', '--porcelain'], opts);
  if (dirty.error || dirty.status !== 0) return { head: head.stdout.trim(), clean: false, error: dirty.error?.code === 'ETIMEDOUT' ? 'git timed out' : 'git failed' };
  return { head: head.stdout.trim(), clean: dirty.stdout.trim() === '' };
}

/**
 * flags: { authorized: 'S7@<40-hex>', 'confirm-mutating': '<stage>', 'owner-confirmed': '<action>[,<action>]', 'retry-after-review': true }
 * state: the run state; git: { head, clean }; targetsHash: a hash of the validated target set (null for local stages).
 */
export function checkGates(stage, flags, state, git, { profile, targetsHash = null } = {}) {
  const def = STAGES[stage];
  if (!def) throw new GateRefused(`unknown stage ${stage}`);
  if (def.local !== true) {
    const m = /^(S[6-9])@([0-9a-f]{40})$/.exec(flags.authorized ?? '');
    if (!m) throw new GateRefused(`--authorized=${def.group}@<full commit SHA> is required to contact a target (${GROUPS[def.group]} authorization)`);
    if (m[1] !== def.group) throw new GateRefused(`stage ${stage} belongs to authorization ${def.group}, not ${m[1]}`);
    if (!git.head || m[2] !== git.head) throw new GateRefused('the authorized commit is not the checked-out HEAD');
    if (!git.clean && profile === 'staging') throw new GateRefused('the working tree is not clean: run only committed, reviewed code');
  }
  if (def.mutating && flags['confirm-mutating'] !== stage) throw new GateRefused(`stage ${stage} changes state: add --confirm-mutating=${stage}`);
  const stages = state.stages ?? {};
  if (state.closed && !RECOVERY.has(stage)) throw new GateRefused('cleanup has closed this run: no stage except cleanup and evidence may run; start a new run');
  if (def.local !== true) {
    const b = state.binding;
    if (b) {
      if (b.commit !== git.head) throw new GateRefused(`this run is bound to commit ${String(b.commit).slice(0, 12)}, not ${String(git.head).slice(0, 12)}`);
      if (b.profile !== profile) throw new GateRefused(`this run is bound to the ${b.profile} profile`);
      if (b.targets !== targetsHash) throw new GateRefused('the validated target configuration differs from the one this run was started with');
    } else if (def.needs.length > 0 || stage === 'cleanup') throw new GateRefused('this run has not been started: run preflight first');
  }
  const unhealthy = Object.entries(stages).filter(([, s]) => UNHEALTHY.has(s?.status));
  if (unhealthy.length && !RECOVERY.has(stage)) {
    const onlyThis = unhealthy.length === 1 && unhealthy[0][0] === stage && unhealthy[0][1].status !== 'running';
    if (!(onlyThis && RETRYABLE_AFTER_REVIEW.has(stage) && flags['retry-after-review'] === true)) {
      const list = unhealthy.map(([k, s]) => `${k} (${s.status})`).join(', ');
      throw new GateRefused(`the run is not healthy: ${list}; only cleanup and evidence may continue it${RETRYABLE_AFTER_REVIEW.has(stage) ? ' (a read-only stage may be re-attempted after review with --retry-after-review)' : ''}`);
    }
  }
  const done = (s) => stages[s]?.status === 'done';
  for (const need of def.needs) {
    if (!done(need)) throw new GateRefused(`stage ${need} must be completed in this run before ${stage}`);
    const recordedAt = stages[need].inherited ? stages[need].inherited.adoptedAtCommit : stages[need].commit; // an adopted stage counts at the commit it was adopted at; its own `commit` stays the commit it truly ran under
    if (def.local !== true && recordedAt !== git.head) throw new GateRefused(`stage ${need} was recorded under commit ${String(recordedAt).slice(0, 12)}, not the authorized ${String(git.head).slice(0, 12)}`);
  }
  if (done(stage) && !REREADABLE.has(stage)) throw new GateRefused(`stage ${stage} already ran in this run and is not repeatable`);
  if (def.owner) {
    const have = String(flags['owner-confirmed'] ?? '').split(',').map((s) => s.trim());
    if (!have.includes(def.owner)) throw new GateRefused(`the owner action "${def.owner}" must be done and confirmed: add --owner-confirmed=${def.owner}`);
  }
  return def;
}
