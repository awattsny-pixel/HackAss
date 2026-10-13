#!/usr/bin/env node
// Runs the database tests against the REAL local Supabase stack (Auth, PostgREST, Storage, Postgres in containers).
//
//   npm run db:test
//
// Preflight failures exit 2 (BLOCKED, not "failed") with an actionable message, so a machine without Docker reports
// that the checks could not run instead of silently skipping them or pretending they passed.
import { spawnSync } from 'node:child_process';

const BLOCKED = 2;
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...opts });
const quiet = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

const blocked = (why, fix) => { console.error(`BLOCKED  ${why}\n         ${fix}`); process.exit(BLOCKED); };

const docker = quiet('docker', ['info', '--format', '{{.ServerVersion}}']);
if (docker.error || docker.status !== 0) blocked('Docker is not available or its daemon is not running.', 'Install and start Docker Desktop (or another Docker-compatible runtime), then re-run `npm run db:test`. CI runs this on GitHub Actions.');

const cli = quiet('supabase', ['--version']);
const supabase = cli.status === 0 ? ['supabase'] : null;
if (!supabase) blocked('The Supabase CLI is not installed.', 'Install it (https://supabase.com/docs/guides/local-development/cli/getting-started) or run `npx supabase@2.120.0 <command>`; this repository pins 2.120.0.');

const exclude = 'studio,imgproxy,edge-runtime,logflare,vector,supavisor';
let code = 1;
try {
  const start = run(supabase[0], ['start', '-x', exclude]);
  if (start.status !== 0) { console.error('FAIL  supabase start failed'); process.exit(1); }
  code = run(supabase[0], ['test', 'db']).status ?? 1;
} finally {
  run(supabase[0], ['stop', '--no-backup']);
}
process.exit(code);
