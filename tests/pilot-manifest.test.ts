// PX-3e: the pilot-specific migration and inventory manifest (25 migrations, 120 functions, 28 tables) matches the repository exactly, the expected SQL inventory equals the reviewed golden
// inventory of the pgTAP suite, and the historical staging records are preserved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const sha = (f: string) => createHash('sha256').update(readFileSync(join(root, f))).digest('hex');
const manifest = JSON.parse(read('docs/px3d/pilot-manifest.json'));
const files = readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
const inv = read('docs/px3d/pilot-inventory.expected.txt').split('\n').filter(Boolean);
const byC = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

test('the manifest lists exactly the 25 migrations of the repository, in order, with their SHA-256', () => {
  assert.equal(manifest.migrations.length, 25); assert.deepEqual(manifest.migrations.map((m: { file: string }) => m.file), files);
  for (const m of manifest.migrations) { assert.equal(m.sha256, sha(`supabase/migrations/${m.file}`), `${m.file} changed since the manifest was written`); assert.match(m.file, /^\d{14}_[a-z0-9_]+\.sql$/); }
  assert.deepEqual(manifest.migrations.slice(0, 21).map((m: { file: string }) => m.file), files.slice(0, 21), 'the first 21 are the F2 migrations'); assert.deepEqual(manifest.migrations.slice(21).map((m: { name: string }) => m.name), ['px3a_work_tables', 'px3a_work_helpers', 'px3a_work_api', 'px3a_work_erasure']);
  for (const r of manifest.rollbacks) assert.equal(r.sha256, sha(`supabase/rollbacks/${r.file}`)); assert.ok(manifest.rollbacks.some((r: { file: string }) => r.file === '20261020090000_px3a_down.sql'));
});
test('counts: 25 migrations, 120 functions, 28 tables; the inventory files fingerprints match', () => {
  assert.deepEqual({ ...manifest.counts }, { migrations: 25, functions: 120, tables: 28, inventoryLines: inv.length });
  assert.equal(inv.filter((l) => l.startsWith('F|')).length, 120); assert.equal(inv.filter((l) => l.startsWith('T|')).length, 28); assert.equal(inv.filter((l) => l.startsWith('L|')).length, 25);
  assert.ok(inv.includes('C|functions=120 tables=28 migrations=25')); assert.ok(inv.includes('P|table_privileges_held_by_anon_authenticated_service_role_hackass_worker=0'), 'no application role holds a table privilege');
  assert.equal(manifest.inventory.expectedSha256, sha('docs/px3d/pilot-inventory.expected.txt')); assert.equal(manifest.inventory.sqlSha256, sha('docs/px3d/pilot-inventory.sql'));
  const created = files.map((f) => read(`supabase/migrations/${f}`).replace(/--.*$/gm, '')).join('\n'); assert.equal([...created.matchAll(/create table (app\.\w+)/g)].length, 28, 'the migrations create 28 tables');
});
test('the ledger section equals the manifest (version and name) and every migration appears once', () => {
  const ledger = inv.filter((l) => l.startsWith('L|')).map((l) => l.slice(2)).sort(byC);
  assert.deepEqual(ledger, manifest.migrations.map((m: { version: string; name: string }) => `${m.version} ${m.name}`).sort(byC));
});
test('the FUNCTION lines of the expected inventory are exactly the golden inventory of 010_roles_and_grants.test.sql (120 lines), so the hosted check uses the same reviewed truth', () => {
  const golden = read('supabase/tests/database/010_roles_and_grants.test.sql').match(/\$golden\$([\s\S]*?)\$golden\$/)![1].split('\n').filter(Boolean).map((l) => `F|${l}`).sort(byC);
  assert.equal(golden.length, 120); assert.deepEqual(inv.filter((l) => l.startsWith('F|')).sort(byC), golden);
});
test('the inventory SQL is read-only and covers the application schemas only', () => {
  const sql = read('docs/px3d/pilot-inventory.sql').replace(/--.*$/gm, '');
  assert.doesNotMatch(sql, /\b(insert|update|delete|create|alter|drop|truncate|grant|revoke|copy|call|do)\b\s/i, 'a SELECT-only file'); assert.match(sql, /order by line collate "C"/);
  for (const s of ['app', 'app_guard', 'api', 'worker', 'app_bridge', 'app_content', 'app_review', 'app_budget', 'app_work']) assert.ok(sql.includes(`'${s}'`), s);
});
test('the HISTORICAL staging records are preserved: the staging plan still lists exactly the 21 F2 migrations, and the 2026-10-17 evidence is committed unchanged in aee5287, already an ancestor of the branch', () => {
  const plan = [...read('docs/hosted/staging-plan.md').matchAll(/^\d+\. `(\d{14}_[a-z0-9_]+\.sql)`$/gm)].map((m) => m[1]);
  assert.deepEqual(plan, files.filter((f) => !f.includes('_px3a_')), 'docs/hosted/staging-plan.md must keep listing the 21 F2 migrations'); assert.equal(plan.length, 21);
  assert.ok(existsSync(join(root, 'docs/hosted/evidence/2026-10-17-staging-stg-20261017-tls3.md')));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  assert.match(git('cat-file', '-t', 'aee5287').trim(), /commit/); execFileSync('git', ['merge-base', '--is-ancestor', 'aee5287', 'HEAD'], { cwd: root });
  assert.equal(git('status', '--porcelain', '--', 'docs/hosted/evidence', 'docs/hosted/staging-plan.md').trim(), '', 'the historical records have no local modification');
  assert.match(manifest.note, /aee5287/);
});
