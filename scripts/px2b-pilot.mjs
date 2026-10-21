#!/usr/bin/env node
// Starts / stops / reports the LOCAL pilot Auth stack used by the PX-2b checks (a separate project, `hackass-px2`, with public sign-up disabled, 12-character
// passwords and email templates that point at /auth/callback). The F2 local stack (`hackass-local`) and its tests are untouched. Local only: nothing hosted.
//   node scripts/px2b-pilot.mjs up | down | status        (needs Docker; SUPABASE_BIN may name the pinned CLI binary)
import { existsSync, lstatSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPABASE = process.env.SUPABASE_BIN || 'supabase';
const EXCLUDE = 'storage-api,imgproxy,edge-runtime,realtime,studio,logflare,vector,postgres-meta,supavisor';
const links = ['migrations', 'tests'].map((n) => [path.join(root, 'supabase-pilot', 'supabase', n), n]);
function ensureLink() {
  for (const [link, n] of links) {
    try { lstatSync(link); } catch { symlinkSync(path.join('..', '..', 'supabase', n), link); } // one set of migrations and tests, never a copy
    if (!existsSync(link)) { console.error(`the ${n} link is broken`); process.exit(2); }
  }
}
const run = (args) => spawnSync(SUPABASE, args, { cwd: root, stdio: 'inherit' }).status ?? 1;
const cmd = process.argv[2];
if (cmd === 'up') { ensureLink(); process.exit(run(['start', '--workdir', 'supabase-pilot', '-x', EXCLUDE])); }
else if (cmd === 'down') process.exit(run(['stop', '--workdir', 'supabase-pilot']));
else if (cmd === 'status') { const r = spawnSync(SUPABASE, ['status', '--workdir', 'supabase-pilot', '-o', 'env'], { cwd: root, encoding: 'utf8' }); console.log(r.status === 0 ? 'pilot stack: running' : 'pilot stack: not running'); process.exit(r.status === 0 ? 0 : 1); }
else { console.error('usage: node scripts/px2b-pilot.mjs up | down | status'); process.exit(2); }
