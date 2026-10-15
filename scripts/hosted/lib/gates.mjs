// Execution gates. A stage runs only if (1) its targets passed H0, (2) the caller names the exact commit being run and it is HEAD of a clean tree,
// (3) a mutating stage is additionally confirmed by name, (4) the stages it depends on are complete in this run, and (5) any owner action it depends on is confirmed.
import { spawnSync } from 'node:child_process';
import { STAGES, GROUPS, REREADABLE } from './stages.mjs';
import { REPO_ROOT } from './config.mjs';

export class GateRefused extends Error {}

export function gitState(repoRoot = REPO_ROOT) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  return { head: head.stdout.trim(), clean: dirty.status === 0 && dirty.stdout.trim() === '' };
}

/** flags: { authorized: 'S7@<40-hex>', 'confirm-mutating': '<stage>', 'owner-confirmed': '<action>[,<action>]' }; state: the run state; git: { head, clean } */
export function checkGates(stage, flags, state, git, { profile }) {
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
  const done = (s) => state.stages[s]?.status === 'done';
  for (const need of def.needs) if (!done(need)) throw new GateRefused(`stage ${need} must be completed in this run before ${stage}`);
  if (state.stages[stage]?.status === 'failed' && stage !== 'cleanup') throw new GateRefused(`stage ${stage} failed earlier in this run; run cleanup and start a new run (cleanup itself may be repeated until it passes)`);
  if (done(stage) && !REREADABLE.has(stage)) throw new GateRefused(`stage ${stage} already ran in this run and is not repeatable`);
  if (def.owner) {
    const have = String(flags['owner-confirmed'] ?? '').split(',').map((s) => s.trim());
    if (!have.includes(def.owner)) throw new GateRefused(`the owner action "${def.owner}" must be done and confirmed: add --owner-confirmed=${def.owner}`);
  }
  return def;
}
