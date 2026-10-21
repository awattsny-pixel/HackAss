#!/usr/bin/env node
// Runs the pilot catalogue inventory (docs/px3d/pilot-inventory.sql, read-only) and compares it LINE FOR LINE with docs/px3d/pilot-inventory.expected.txt.
//   node scripts/pilot-inventory.mjs --local            the local pilot stack (docker exec into its database container as postgres)
//   node scripts/pilot-inventory.mjs --libpq --expect-host db.<ref>.supabase.co   the operator's own libpq environment (PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSFILE, PGSSLMODE, PGSSLROOTCERT):
//                                                       use it for the hosted pilot over the DIRECT connection (never a pooler)
//   node scripts/pilot-inventory.mjs --write-expected   (local only) regenerate the expected file from the local pilot stack after a reviewed catalogue change
// Exit 0: identical. Exit 1: differs (the differing lines are printed). Exit 2: could not run. Passwords are never read or printed here.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHostedTarget } from './lib/pilot-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL = readFileSync(path.join(root, 'docs/px3d/pilot-inventory.sql'), 'utf8');
const EXPECTED = path.join(root, 'docs/px3d/pilot-inventory.expected.txt');
const DOCKER = process.env.DOCKER_BIN || '/Applications/Docker.app/Contents/Resources/bin/docker';
const CONTAINER = process.env.PX_DB_CONTAINER || 'supabase_db_hackass-px2';
const mode = process.argv[2];
if (!['--local', '--libpq', '--write-expected'].includes(mode)) { console.error('usage: node scripts/pilot-inventory.mjs --local | --libpq | --write-expected'); process.exit(2); }

if (mode === '--libpq') {
  // the same project binding as pilot-apply: direct host of ONE project, postgres/postgres, verify-full, no staging, no connection overrides
  const i = process.argv.indexOf('--expect-host');
  const refusals = checkHostedTarget({ host: process.env.PGHOST, port: process.env.PGPORT, user: process.env.PGUSER, database: process.env.PGDATABASE, sslmode: process.env.PGSSLMODE, sslrootcert: process.env.PGSSLROOTCERT, expectHost: i >= 0 ? process.argv[i + 1] : undefined, env: process.env });
  if (refusals.length) { console.error('REFUSED:\n' + refusals.map((x) => `  - ${x}`).join('\n')); process.exit(1); }
}
const [cmd, args] = mode === '--libpq' ? ['psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1']] : [DOCKER, ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1']];
const r = spawnSync(cmd, args, { input: SQL, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (r.status !== 0) { console.error(`could not run the inventory: ${(r.stderr || String(r.error)).split('\n')[0].slice(0, 200)}`); process.exit(2); }
const actual = r.stdout.trim().split('\n').filter(Boolean).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
if (mode === '--write-expected') { writeFileSync(EXPECTED, actual.join('\n') + '\n'); console.log(`wrote ${actual.length} lines to docs/px3d/pilot-inventory.expected.txt`); process.exit(0); }
const expected = readFileSync(EXPECTED, 'utf8').trim().split('\n').filter(Boolean).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const e = new Set(expected), a = new Set(actual);
const missing = expected.filter((l) => !a.has(l)), extra = actual.filter((l) => !e.has(l));
if (!missing.length && !extra.length && actual.length === expected.length) { console.log(`inventory identical: ${actual.length} lines (${actual.filter((l) => l.startsWith('F|')).length} functions, ${actual.filter((l) => l.startsWith('T|')).length} tables, ${actual.filter((l) => l.startsWith('L|')).length} ledger rows)`); process.exit(0); }
console.error(`inventory DIFFERS: ${missing.length} expected line(s) missing, ${extra.length} unexpected line(s)`);
for (const l of missing.slice(0, 20)) console.error(`  - ${l}`); for (const l of extra.slice(0, 20)) console.error(`  + ${l}`);
process.exit(1);
