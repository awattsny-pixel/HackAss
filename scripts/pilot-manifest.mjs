#!/usr/bin/env node
// The PILOT migration and inventory manifest: the exact 25 migrations (order and SHA-256), the counts the pilot database must have, and the fingerprint of the expected catalogue
// inventory. It is separate from, and does not replace, the historical staging records (docs/hosted/staging-plan.md lists the 21 F2 migrations; the 2026-10-17 staging evidence was
// committed unchanged in aee5287).
//   node scripts/pilot-manifest.mjs --write     regenerate docs/px3d/pilot-manifest.json after a reviewed migration or inventory change
//   node scripts/pilot-manifest.mjs --check     exit 0 when the manifest matches the repository exactly, 1 otherwise (tests/pilot-manifest.test.ts runs the same comparison)
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (f) => createHash('sha256').update(readFileSync(path.join(root, f))).digest('hex');
const files = readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
const inv = readFileSync(path.join(root, 'docs/px3d/pilot-inventory.expected.txt'), 'utf8').split('\n').filter(Boolean);
const count = inv.find((l) => l.startsWith('C|'));
const m = /^C\|functions=(\d+) tables=(\d+) migrations=(\d+)$/.exec(count ?? '');
if (!m) { console.error('the expected inventory has no counts line'); process.exit(1); }

export const build = () => ({
  name: 'hackass-pilot migration and inventory manifest',
  note: 'The pilot database is the 21 F2 migrations plus the 4 PX-3a migrations. This manifest is pilot-specific. The historical staging records are preserved unchanged: docs/hosted/staging-plan.md (21 migrations) and docs/hosted/evidence/2026-10-17-staging-stg-20261017-tls3.md (committed unchanged in aee5287).',
  counts: { migrations: Number(m[3]), functions: Number(m[1]), tables: Number(m[2]), inventoryLines: inv.length },
  migrations: files.map((f, i) => ({ order: i + 1, file: f, version: f.slice(0, 14), name: f.slice(15, -4), sha256: sha(`supabase/migrations/${f}`) })),
  inventory: { sql: 'docs/px3d/pilot-inventory.sql', sqlSha256: sha('docs/px3d/pilot-inventory.sql'), expected: 'docs/px3d/pilot-inventory.expected.txt', expectedSha256: sha('docs/px3d/pilot-inventory.expected.txt'), runner: 'scripts/pilot-inventory.mjs' },
  rollbacks: readdirSync(path.join(root, 'supabase/rollbacks')).filter((f) => f.endsWith('.sql')).sort().map((f) => ({ file: f, sha256: sha(`supabase/rollbacks/${f}`) })),
});
const out = path.join(root, 'docs/px3d/pilot-manifest.json');
const mode = process.argv[2];
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (mode === '--write') { writeFileSync(out, JSON.stringify(build(), null, 2) + '\n'); console.log(`wrote ${path.relative(root, out)}: ${files.length} migrations`); }
  else if (mode === '--check') { const same = JSON.stringify(build()) === JSON.stringify(JSON.parse(readFileSync(out, 'utf8'))); console.log(same ? 'manifest matches the repository' : 'manifest DIFFERS from the repository'); process.exit(same ? 0 : 1); }
  else { console.error('usage: node scripts/pilot-manifest.mjs --write | --check'); process.exit(2); }
}
