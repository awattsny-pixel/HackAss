#!/usr/bin/env node
// Applies the pilot migrations (docs/px3d/pilot-manifest.json: 25 files) to a database, one file per TRANSACTION, verifying every file against the manifest first.
//   node scripts/pilot-apply.mjs --local                       DRY RUN against the local pilot stack: prints what is applied and what would be
//   node scripts/pilot-apply.mjs --local --apply               applies the pending files to the LOCAL pilot stack (rehearsal)
//   node scripts/pilot-apply.mjs --libpq --expect-host db.<ref>.supabase.co                 DRY RUN against the hosted pilot (the operator's libpq environment)
//   node scripts/pilot-apply.mjs --libpq --expect-host db.<ref>.supabase.co --apply --confirm-pilot <ref>     the hosted apply (separately authorized; MUTATING)
// Rules (scripts/lib/pilot-plan.mjs): the ledger must be an exact prefix of the manifest; any file that differs from the manifest hash, an unknown or renamed ledger row, or a gap
// REFUSES the run. A hosted run additionally refuses anything but the direct host (db.<ref>.supabase.co), port 5432, login postgres, sslmode=verify-full with a root certificate,
// and requires --confirm-pilot <ref> to equal the project reference in the host. Server-side limits are set per session (lock 5 s, statement 120 s, idle-in-transaction 60 s).
// A failing file rolls back completely (psql -1 plus the ledger row in the same transaction); the run stops at the first failure and nothing after it is tried. Passwords are never read here.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHostedTarget, planApply } from './lib/pilot-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n); const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const local = flag('--local'), libpq = flag('--libpq'), apply = flag('--apply');
if (local === libpq) { console.error('usage: node scripts/pilot-apply.mjs (--local | --libpq --expect-host db.<ref>.supabase.co) [--apply [--confirm-pilot <ref>]]'); process.exit(2); }
const DOCKER = process.env.DOCKER_BIN || '/Applications/Docker.app/Contents/Resources/bin/docker';
const CONTAINER = process.env.PX_DB_CONTAINER || 'supabase_db_hackass-px2';
const LIMITS = '-c lock_timeout=5s -c statement_timeout=120s -c idle_in_transaction_session_timeout=60s';

if (libpq) {
  const refusals = checkHostedTarget({ host: process.env.PGHOST, port: process.env.PGPORT, user: process.env.PGUSER, database: process.env.PGDATABASE, env: process.env, sslmode: process.env.PGSSLMODE, sslrootcert: process.env.PGSSLROOTCERT, expectHost: val('--expect-host') });
  if (apply && val('--confirm-pilot') !== (process.env.PGHOST ?? '').split('.')[1]) refusals.push('--confirm-pilot must equal the project reference in PGHOST');
  if (refusals.length) { console.error('REFUSED:\n' + refusals.map((r) => `  - ${r}`).join('\n')); process.exit(1); }
}
const run = (sql, { file } = {}) => {
  const base = ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'];
  const [cmd, args, env] = local ? [DOCKER, ['exec', '-i', '-e', `PGOPTIONS=${LIMITS}`, CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', ...base], process.env] : ['psql', base, { ...process.env, PGOPTIONS: LIMITS }];
  void file; return spawnSync(cmd, args, { input: sql, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
};

const manifest = JSON.parse(readFileSync(path.join(root, 'docs/px3d/pilot-manifest.json'), 'utf8'));
const fileHashes = Object.fromEntries(readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).map((f) => [f, createHash('sha256').update(readFileSync(path.join(root, 'supabase/migrations', f))).digest('hex')]));
const led = run("select version || ' ' || name from supabase_migrations.schema_migrations order by version");
let ledger;
if (led.status !== 0) {
  if (/does not exist/.test(led.stderr)) ledger = [];   // a brand-new database: no ledger yet (created on the first apply)
  else { console.error(`could not read the ledger: ${(led.stderr || String(led.error)).split('\n')[0].slice(0, 160)}`); process.exit(2); }
} else ledger = led.stdout.trim().split('\n').filter(Boolean).map((l) => ({ version: l.split(' ')[0], name: l.split(' ').slice(1).join(' ') }));
const plan = planApply(manifest, fileHashes, ledger);
if (!plan.ok) { console.error('REFUSED:\n' + plan.refusals.map((r) => `  - ${r}`).join('\n')); process.exit(1); }
console.log(`ledger: ${plan.applied} of ${manifest.migrations.length} applied; ${plan.pending.length} pending${plan.pending.length ? `: ${plan.pending.map((p) => p.version).join(', ')}` : ''}`);
if (!apply) { console.log(plan.pending.length ? 'DRY RUN: nothing was changed (add --apply to apply the pending files)' : 'nothing to apply'); process.exit(0); }
if (!plan.pending.length) { console.log('nothing to apply'); process.exit(0); }
for (const p of plan.pending) {
  const body = readFileSync(path.join(root, 'supabase/migrations', p.file), 'utf8');
  const sql = `begin;\n${body}\n;\ncreate schema if not exists supabase_migrations;\ncreate table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);\ninsert into supabase_migrations.schema_migrations (version, name, statements) values ('${p.version}', '${p.name}', '{}');\ncommit;\n`;
  const r = run(sql);
  if (r.status !== 0) { console.error(`FAILED at ${p.file} (rolled back): ${(r.stderr || String(r.error)).split('\n').find((l) => /ERROR/.test(l))?.slice(0, 200) ?? 'see psql output'}\nStopped: nothing after this file was tried.`); process.exit(1); }
  console.log(`applied ${p.order}/${manifest.migrations.length}  ${p.version} ${p.name}`);
}
console.log('done');
