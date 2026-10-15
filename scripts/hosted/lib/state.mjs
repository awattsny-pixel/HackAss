// A run: a private directory OUTSIDE the repository (mode 0700) holding the state (stage progress, fixture registry), the redacted results log, and a 0600 file
// of the secrets the fixtures need between stages (generated passwords, TOTP secrets). That directory is disposable: `cleanup` and `evidence --delete-raw` remove it.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './config.mjs';
import { redact, registerSecret } from './redact.mjs';

export const RUN_ID = /^[a-z0-9][a-z0-9-]{5,39}$/;

export function runBase(profile) {
  return profile === 'selftest' ? path.join(os.tmpdir(), 'hackass-hosted-selftest') : path.join(os.homedir(), '.hackass-staging-runs');
}
export function openRun({ runId, profile, repoRoot = REPO_ROOT, base = runBase(profile) }) {
  if (!RUN_ID.test(runId ?? '')) throw new Error('--run-id must be 6 to 40 lowercase letters, digits or hyphens');
  const dir = path.join(base, runId);
  const rel = path.relative(repoRoot, dir);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('the run directory must be outside the repository');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const st = statSync(dir);
  if ((st.mode & 0o777) !== 0o700) throw new Error('the run directory is not mode 0700');
  const f = (n) => path.join(dir, n);
  const run = {
    dir, runId, profile,
    state: () => (existsSync(f('state.json')) ? JSON.parse(readFileSync(f('state.json'), 'utf8')) : { runId, profile, stages: {}, fixtures: {}, facts: {} }),
    save(state) { const tmp = f('state.json.tmp'); writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 }); renameSync(tmp, f('state.json')); },
    secrets: () => (existsSync(f('secrets.json')) ? JSON.parse(readFileSync(f('secrets.json'), 'utf8')) : {}),
    saveSecrets(obj) { writeFileSync(f('secrets.json'), JSON.stringify(obj), { mode: 0o600 }); chmodSync(f('secrets.json'), 0o600); for (const v of flatten(obj)) registerSecret(v); },
    log(line) { appendFileSync(f('results.jsonl'), redact(JSON.stringify(line)) + '\n', { mode: 0o600 }); },
    results: () => (existsSync(f('results.jsonl')) ? readFileSync(f('results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    destroy() { rmSync(dir, { recursive: true, force: true }); },
  };
  for (const v of flatten(run.secrets())) registerSecret(v);
  return run;
}
function flatten(o) { return Object.values(o ?? {}).flatMap((v) => (v && typeof v === 'object' ? flatten(v) : typeof v === 'string' ? [v] : [])); }
