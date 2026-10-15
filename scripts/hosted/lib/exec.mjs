// Bounded child processes. Every child has a wall-clock limit (the whole process group is killed on expiry), an output cap, and an explicitly constructed
// environment: nothing is inherited from the caller except the few names listed here, so no secret in the parent environment can reach a child by accident.
import { spawn } from 'node:child_process';

const PASS_THROUGH = ['PATH', 'HOME', 'USER', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'LANG'];
const active = new Set();
/** Kill every child still running (its whole process group). Used when this process is interrupted, so nothing it started outlives it. */
export function killActiveChildren() { for (const c of active) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* already gone */ } } active.clear(); }
export function childEnv(extra = {}) {
  const env = {};
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

/** Resolves { code, signal, stdout, stderr, timedOut, truncated }. Never rejects for a nonzero exit; rejects only if the process cannot be started. */
export function runBounded(cmd, args, { input = null, env = childEnv(), timeoutMs = 60_000, maxBytes = 1_000_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    active.add(child);
    let stdout = ''; let stderr = ''; let truncated = false; let timedOut = false; let done = false;
    const add = (which) => (d) => { const cur = which === 'o' ? stdout : stderr; if (cur.length + d.length > maxBytes) { truncated = true; return; } if (which === 'o') stdout += d; else stderr += d; };
    child.stdout.on('data', add('o')); child.stderr.on('data', add('e'));
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    child.on('error', (e) => { active.delete(child); if (done) return; done = true; clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => { active.delete(child); if (done) return; done = true; clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut, truncated }); });
    child.stdin.on('error', () => { /* the child exited before reading its input */ });
    child.stdin.end(input ?? '');
  });
}
