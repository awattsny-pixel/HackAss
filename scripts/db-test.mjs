#!/usr/bin/env node
// Runs the database tests against the REAL local Supabase stack (Auth, PostgREST, Storage, Postgres in containers).
//
//   npm run db:test
//
// Exit codes (aligned with the smoke harness where they overlap):
//   0 tests passed and cleanup succeeded      1 database tests failed        2 BLOCKED (Docker or CLI missing)
//   3 stack failed to start                   4 a command timed out          8 cleanup (`supabase stop`) failed
// 8 takes precedence over every other result: a stack that could not be stopped is never reported as a clean run.
// Preflight problems are BLOCKED, not failures, so a machine without Docker says the checks could not run instead of
// silently skipping them or pretending they passed.
//
// Every external command is bounded by a timeout. Cleanup is attempted whenever `supabase start` was attempted
// (a partial start can leave containers behind), whatever happened afterwards; the exit happens only after it.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXIT = { OK: 0, TESTS_FAILED: 1, BLOCKED: 2, START_FAILED: 3, TIMEOUT: 4, CLEANUP_FAILED: 8 };
export const DEFAULT_TIMEOUTS = { preflightMs: 20_000, startMs: 10 * 60_000, testMs: 10 * 60_000, stopMs: 3 * 60_000 };
const EXCLUDE = 'studio,imgproxy,edge-runtime,logflare,vector,supavisor';

/** The real command runner: bounded, never throws. `{ status, timedOut, error }`. */
export function execCommand(cmd, args, { timeoutMs, env, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', env });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const missing = r.error?.code === 'ENOENT';
  return { status: r.status, timedOut, missing, error: r.error ? r.error.code ?? String(r.error.message) : null };
}

/**
 * The whole run, with the command runner and logger injected so tests drive it with command doubles (no Docker, no
 * Supabase CLI, no database). Returns the exit code; never calls process.exit itself.
 */
export function runDbTests({ exec = execCommand, env = process.env, timeouts = {}, log = { info: console.log, error: console.error } } = {}) {
  const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const blocked = (why, fix) => { log.error(`BLOCKED  ${why}\n         ${fix}`); return EXIT.BLOCKED; };

  const docker = exec('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: t.preflightMs, env, quiet: true });
  if (docker.timedOut) return blocked('`docker info` did not answer in time.', 'The Docker daemon is not responding; start or restart Docker, then re-run `npm run db:test`.');
  if (docker.status !== 0) return blocked('Docker is not available or its daemon is not running.', 'Install and start Docker Desktop (or another Docker-compatible runtime), then re-run `npm run db:test`. CI runs this on GitHub Actions.');
  const cli = exec('supabase', ['--version'], { timeoutMs: t.preflightMs, env, quiet: true });
  if (cli.status !== 0) return blocked('The Supabase CLI is not installed (or did not answer).', 'Install it (https://supabase.com/docs/guides/local-development/cli/getting-started) or run `npx supabase@2.120.0 <command>`; this repository pins 2.120.0.');

  let result = EXIT.OK;
  const start = exec('supabase', ['start', '-x', EXCLUDE], { timeoutMs: t.startMs, env });
  if (start.timedOut) { log.error(`FAIL  supabase start timed out after ${t.startMs}ms`); result = EXIT.TIMEOUT; }
  else if (start.status !== 0) { log.error('FAIL  supabase start failed'); result = EXIT.START_FAILED; }
  else {
    const tests = exec('supabase', ['test', 'db'], { timeoutMs: t.testMs, env });
    if (tests.timedOut) { log.error(`FAIL  supabase test db timed out after ${t.testMs}ms`); result = EXIT.TIMEOUT; }
    else if (tests.status !== 0) { log.error('FAIL  database tests failed'); result = EXIT.TESTS_FAILED; }
  }

  // Always attempted once start was attempted; its failure outranks every other result.
  const stop = exec('supabase', ['stop', '--no-backup'], { timeoutMs: t.stopMs, env });
  if (stop.timedOut || stop.status !== 0) {
    log.error(`FAIL  cleanup failed: \`supabase stop\` ${stop.timedOut ? `timed out after ${t.stopMs}ms` : 'exited nonzero'}; containers may still be running (check \`docker ps\`)`);
    return EXIT.CLEANUP_FAILED;
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const num = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : undefined; };
  const timeouts = Object.fromEntries(Object.entries({ preflightMs: num('preflight-timeout-ms'), startMs: num('start-timeout-ms'), testMs: num('test-timeout-ms'), stopMs: num('stop-timeout-ms') }).filter(([, v]) => Number.isFinite(v)));
  process.exitCode = runDbTests({ timeouts });
}
