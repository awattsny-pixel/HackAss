// A run: a private directory OUTSIDE the repository (mode 0700) holding the state (stage progress, fixture registry, creation intents), the redacted results log, a 0600 file of
// the secrets the fixtures need between stages (generated passwords, TOTP secrets), and salted hashes of every secret the run ever registered (so redaction survives the secrets
// file being deleted). That directory is disposable: `evidence --delete-raw` removes it.
// Only one process may execute a stage against a run at a time (an exclusive lock directory); a lock left by a dead process is taken over only by the recovery stages.
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './config.mjs';
import { hashSecret, hashableParts, loadHashedSecrets, redact, registerSecret, setRegisterSink } from './redact.mjs';

export const RUN_ID = /^[a-z0-9][a-z0-9-]{5,39}$/;
export class LockRefused extends Error {}

export function runBase(profile) {
  return profile === 'selftest' ? path.join(os.tmpdir(), 'hackass-hosted-selftest') : path.join(os.homedir(), '.hackass-staging-runs');
}
export const hashTargets = (targets) => createHash('sha256').update(JSON.stringify(targets)).digest('hex');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

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
  const lockDir = f('lock');
  let held = null;
  const run = {
    dir, runId, profile,
    state: () => (existsSync(f('state.json')) ? JSON.parse(readFileSync(f('state.json'), 'utf8')) : { runId, profile, stages: {}, fixtures: {}, facts: {}, intents: [] }),
    save(state) { const tmp = f('state.json.tmp'); writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 }); renameSync(tmp, f('state.json')); },
    secrets: () => (existsSync(f('secrets.json')) ? JSON.parse(readFileSync(f('secrets.json'), 'utf8')) : {}),
    saveSecrets(obj) { writeFileSync(f('secrets.json'), JSON.stringify(obj), { mode: 0o600 }); chmodSync(f('secrets.json'), 0o600); for (const v of flatten(obj)) registerSecret(v); },
    log(line) { appendFileSync(f('results.jsonl'), redact(JSON.stringify(line)) + '\n', { mode: 0o600 }); },
    results: () => (existsSync(f('results.jsonl')) ? readFileSync(f('results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    /** Persist the intent to create an Auth user BEFORE the request, so an interrupted or uncertain creation can be found again by its exact e-mail address. */
    addIntent(intent) { const s = run.state(); s.intents = s.intents ?? []; if (!s.intents.some((i) => i.email === intent.email)) s.intents.push({ ...intent, at: new Date().toISOString() }); run.save(s); },
    completeIntent(email, id) { const s = run.state(); const i = (s.intents ?? []).find((x) => x.email === email); if (i) { i.id = id; run.save(s); } },
    destroy() { rmSync(dir, { recursive: true, force: true }); },
    /** Take the run's exclusive lock. A lock held by a live process is always refused; one left by a dead process is taken over only when `takeoverDead` (cleanup, evidence). */
    acquireLock({ takeoverDead = false } = {}) {
      const token = randomBytes(8).toString('hex');
      const create = () => { try { mkdirSync(lockDir, { mode: 0o700 }); } catch (e) { if (e?.code === 'EEXIST') return false; throw e; } writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), { mode: 0o600 }); return true; };
      if (!create()) {
        let owner = null;
        try { owner = JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8')); } catch { throw new LockRefused('this run is locked by a process whose state cannot be read; refusing to continue'); }
        if (alive(owner.pid)) throw new LockRefused(`another process (pid ${owner.pid}) is executing a stage in this run`);
        if (!takeoverDead) throw new LockRefused(`a previous invocation (pid ${owner.pid}) died without finishing this run; only cleanup or evidence may continue it`);
        const moved = `${lockDir}.dead-${token}`;
        try { renameSync(lockDir, moved); } catch { throw new LockRefused('the stale lock was taken by another process'); }
        let seen = null; try { seen = JSON.parse(readFileSync(path.join(moved, 'owner.json'), 'utf8')); } catch { /* fall through */ }
        if (!seen || seen.token !== owner.token) { try { renameSync(moved, lockDir); } catch { /* best effort */ } throw new LockRefused('the lock changed hands while it was being taken over'); }
        rmSync(moved, { recursive: true, force: true });
        if (!create()) throw new LockRefused('another process took the lock first');
      }
      held = token;
      return token;
    },
    releaseLock() {
      if (!held) return;
      try { const o = JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8')); if (o.token === held) rmSync(lockDir, { recursive: true, force: true }); } catch { /* the run directory may already be gone */ }
      held = null;
    },
  };
  // Redaction that survives the secrets file: every secret registered by any process of this run is stored only as a salted hash.
  const saltFile = f('redaction.salt'); const hashFile = f('redaction.hashes');
  if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(16).toString('hex'), { mode: 0o600 });
  const salt = readFileSync(saltFile, 'utf8').trim();
  setRegisterSink((v) => { const lines = hashableParts(v).map((p) => hashSecret(salt, p)).join('\n'); try { appendFileSync(hashFile, `${lines}\n`, { mode: 0o600 }); } catch { /* the run directory may already be gone */ } });
  loadHashedSecrets({ salt, hashes: existsSync(hashFile) ? readFileSync(hashFile, 'utf8').split('\n').filter(Boolean) : [] });
  for (const v of flatten(run.secrets())) registerSecret(v);
  return run;
}
function flatten(o) { return Object.values(o ?? {}).flatMap((v) => (v && typeof v === 'object' ? flatten(v) : typeof v === 'string' ? [v] : [])); }
