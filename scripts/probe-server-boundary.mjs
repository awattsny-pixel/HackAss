#!/usr/bin/env node
// Proves the production build-time boundary with real `next build`s in a throwaway copy of the tracked files:
//   A. a server route handler that imports the server-only platform surface MUST build;
//   B. a Client Component that imports it MUST fail, and the failure must be the `server-only` error.
// The working tree is never modified. Exit codes: 0 both probes behaved, 1 a probe misbehaved, 8 cleanup failed.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'hackass-boundary-'));
const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmp, NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'dummy', SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_KEY: 'dummy', SUPABASE_SERVICE_ROLE_KEY: 'dummy' };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
let result = 1;

try {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const f of files) {
    if (!existsSync(path.join(root, f)) || f.startsWith('frontend/')) continue;
    mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
    cpSync(path.join(root, f), path.join(tmp, f));
  }
  const run = (cmd, args, timeout) => spawnSync(cmd, args, { cwd: tmp, env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  const ci = run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 600_000);
  if (ci.status !== 0) throw new Error('npm ci failed in the probe copy');

  mkdirSync(path.join(tmp, 'app/api/boundary-probe'), { recursive: true });
  writeFileSync(path.join(tmp, 'app/api/boundary-probe/route.ts'), "import { getEnv } from '@/src/platform/server';\nexport async function GET() { return Response.json({ ok: typeof getEnv }); }\n");
  const a = run('npm', ['run', 'build'], 600_000);
  const aOk = a.status === 0;
  console.log(`${aOk ? 'PASS' : 'FAIL'}  A. server route importing @/src/platform/server builds (exit ${a.status})`);

  mkdirSync(path.join(tmp, 'app/boundary-probe-client'), { recursive: true });
  writeFileSync(path.join(tmp, 'app/boundary-probe-client/page.tsx'), "'use client';\nimport { getEnv } from '@/src/platform/server';\nexport default function P() { return <p>{String(typeof getEnv)}</p>; }\n");
  const b = run('npm', ['run', 'build'], 600_000);
  const out = strip(`${b.stdout}\n${b.stderr}`);
  const bOk = b.status !== 0 && /depends on "server-only"/.test(out);
  console.log(`${bOk ? 'PASS' : 'FAIL'}  B. Client Component importing @/src/platform/server fails the build with the server-only error (exit ${b.status})`);
  if (!bOk) console.log(out.split('\n').slice(-25).join('\n'));
  result = aOk && bOk ? 0 : 1;
} catch (e) {
  console.error(`FAIL  probe could not run: ${e.message}`);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.error(`FAIL  cleanup failed: ${e.message}`); result = 8; }
}
process.exit(result);
