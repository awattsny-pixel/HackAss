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
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = { OK: 0, TESTS_FAILED: 1, BLOCKED: 2, START_FAILED: 3, TIMEOUT: 4, CLEANUP_FAILED: 8 };
export const DEFAULT_TIMEOUTS = { probeMs: 10_000, preflightMs: 20_000, startMs: 10 * 60_000, testMs: 10 * 60_000, stopMs: 3 * 60_000 };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Is `cmd --version` answering? Bounded: a hung binary (a stuck Docker CLI, a dead socket) is killed at the timeout and
 * counts as "not available" instead of blocking discovery forever. Never throws.
 */
export function probeCommand(cmd, timeoutMs = DEFAULT_TIMEOUTS.probeMs) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: timeoutMs, killSignal: 'SIGKILL' });
  return r.status === 0 && !r.error;
}

/**
 * Finds the tools to use. The Supabase CLI must be the pinned version (scripts/supabase-cli-pin.json): an explicit
 * SUPABASE_BIN, then .tools/supabase/<version>/supabase (scripts/install-supabase-cli.mjs), then `supabase` on PATH.
 * Docker Desktop on macOS may not have linked `docker` into PATH or /var/run/docker.sock; its own CLI and per-user
 * socket are used when present. An explicit DOCKER_BIN / SUPABASE_BIN always wins (tests use it to stay hermetic). Returns { docker, supabase, env, cliVersion }.
 */
export function resolveTools({ env = process.env, exists = existsSync, home = os.homedir(), pin = JSON.parse(readFileSync(path.join(root, 'scripts/supabase-cli-pin.json'), 'utf8')), probe = null } = {}) {
  const out = { ...env };
  const dockerDesktopBin = '/Applications/Docker.app/Contents/Resources/bin';
  let docker = env.DOCKER_BIN || 'docker';
  if (!env.DOCKER_BIN && !probe?.(docker) && exists(path.join(dockerDesktopBin, 'docker'))) { docker = path.join(dockerDesktopBin, 'docker'); out.PATH = `${dockerDesktopBin}:${env.PATH ?? ''}`; }
  const userSock = path.join(home, '.docker', 'run', 'docker.sock');
  if (!out.DOCKER_HOST && !exists('/var/run/docker.sock') && exists(userSock)) out.DOCKER_HOST = `unix://${userSock}`;
  const local = path.join(root, '.tools', 'supabase', pin.version, 'supabase');
  const supabase = env.SUPABASE_BIN || (exists(local) ? local : 'supabase');
  return { docker, supabase, env: out, cliVersion: pin.version };
}

const EXCLUDE = 'studio,imgproxy,edge-runtime,logflare,vector,supavisor';

/** The real command runner: bounded, never throws. `{ status, timedOut, error }`. */
export function execCommand(cmd, args, { timeoutMs, env, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', env });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const missing = r.error?.code === 'ENOENT';
  return { status: r.status, stdout: r.stdout ?? '', timedOut, missing, error: r.error ? r.error.code ?? String(r.error.message) : null };
}

/**
 * The whole run, with the command runner and logger injected so tests drive it with command doubles (no Docker, no
 * Supabase CLI, no database). Returns the exit code; never calls process.exit itself.
 */
export function runDbTests({ exec = execCommand, env = process.env, timeouts = {}, log = { info: console.log, error: console.error }, tools = { docker: 'docker', supabase: 'supabase' }, expectCliVersion = null, extraSteps = [] } = {}) {
  const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const blocked = (why, fix) => { log.error(`BLOCKED  ${why}\n         ${fix}`); return EXIT.BLOCKED; };

  const docker = exec(tools.docker, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: t.preflightMs, env, quiet: true });
  if (docker.timedOut) return blocked('`docker info` did not answer in time.', 'The Docker daemon is not responding; start or restart Docker, then re-run `npm run db:test`.');
  if (docker.status !== 0) return blocked('Docker is not available or its daemon is not running.', 'Install and start Docker Desktop (or another Docker-compatible runtime), then re-run `npm run db:test`. CI runs this on GitHub Actions.');
  const cli = exec(tools.supabase, ['--version'], { timeoutMs: t.preflightMs, env, quiet: true });
  if (cli.status === 0 && expectCliVersion && cli.stdout?.trim() !== expectCliVersion) return blocked(`The Supabase CLI is version ${JSON.stringify(cli.stdout?.trim())}, not the pinned ${expectCliVersion}.`, 'Run `node scripts/install-supabase-cli.mjs` (installs the pinned, SHA-256-verified release into .tools/).');
  if (cli.status !== 0) return blocked('The Supabase CLI is not installed (or did not answer).', 'Install it (https://supabase.com/docs/guides/local-development/cli/getting-started) or run `node scripts/install-supabase-cli.mjs` (pinned 2.120.0, SHA-256 verified).');

  let result = EXIT.OK;
  const start = exec(tools.supabase, ['start', '-x', EXCLUDE], { timeoutMs: t.startMs, env });
  if (start.timedOut) { log.error(`FAIL  supabase start timed out after ${t.startMs}ms`); result = EXIT.TIMEOUT; }
  else if (start.status !== 0) { log.error('FAIL  supabase start failed'); result = EXIT.START_FAILED; }
  else {
    const tests = exec(tools.supabase, ['test', 'db'], { timeoutMs: t.testMs, env });
    if (tests.timedOut) { log.error(`FAIL  supabase test db timed out after ${t.testMs}ms`); result = EXIT.TIMEOUT; }
    else if (tests.status !== 0) { log.error('FAIL  database tests failed'); result = EXIT.TESTS_FAILED; }
    else {
      // optional follow-up steps against the same running stack (e.g. the local Auth/session/MFA checks)
      for (const step of extraSteps) {
        const r = exec(step.cmd, step.args, { timeoutMs: step.timeoutMs ?? t.testMs, env: { ...env, ...(step.env ?? {}) } });
        if (r.timedOut) { log.error(`FAIL  ${step.name} timed out after ${step.timeoutMs ?? t.testMs}ms`); result = EXIT.TIMEOUT; break; }
        if (r.status !== 0) { log.error(`FAIL  ${step.name} failed`); result = EXIT.TESTS_FAILED; break; }
      }
    }
  }

  // Always attempted once start was attempted; its failure outranks every other result.
  const stop = exec(tools.supabase, ['stop', '--no-backup'], { timeoutMs: t.stopMs, env });
  if (stop.timedOut || stop.status !== 0) {
    log.error(`FAIL  cleanup failed: \`supabase stop\` ${stop.timedOut ? `timed out after ${t.stopMs}ms` : 'exited nonzero'}; containers may still be running (check \`docker ps\`)`);
    return EXIT.CLEANUP_FAILED;
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const num = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : undefined; };
  const timeouts = Object.fromEntries(Object.entries({ preflightMs: num('preflight-timeout-ms'), startMs: num('start-timeout-ms'), testMs: num('test-timeout-ms'), stopMs: num('stop-timeout-ms') }).filter(([, v]) => Number.isFinite(v)));
  const probe = (d) => probeCommand(d, timeouts.probeMs);
  const tools = resolveTools({ probe });
  const extraSteps = process.argv.includes('--auth-spikes')
    ? ['local-auth-spikes.mjs', 'local-f2a-checks.mjs', 'local-f2b-checks.mjs', 'local-f2c-checks.mjs', 'local-f2c2-checks.mjs', 'local-f2d1-checks.mjs', 'local-f2d2-checks.mjs', 'local-f2e-checks.mjs'].map((file) => ({ name: { 'local-f2a-checks.mjs': 'F2-A authority checks', 'local-f2b-checks.mjs': 'F2-B content checks', 'local-f2c-checks.mjs': 'F2-C1 review checks', 'local-f2c2-checks.mjs': 'F2-C2 publication checks', 'local-f2d1-checks.mjs': 'F2-D1 job checks', 'local-f2d2-checks.mjs': 'F2-D2 budget checks', 'local-f2e-checks.mjs': 'F2-E catalog checks' }[file] ?? 'local Auth/session/MFA checks', cmd: process.execPath, args: ['--conditions=react-server', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(root, 'scripts', file)], env: { SUPABASE_BIN: tools.supabase, DOCKER_BIN: tools.docker } }))
    : [];
  process.exitCode = runDbTests({ timeouts, tools: { docker: tools.docker, supabase: tools.supabase }, env: tools.env, expectCliVersion: tools.cliVersion, extraSteps });
}
