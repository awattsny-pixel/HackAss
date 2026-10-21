// PX-3e: the pilot apply planner (pure) and the connection safety rules, plus source guarantees of the apply tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHostedTarget, planApply } from '../scripts/lib/pilot-plan.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'docs/px3d/pilot-manifest.json'), 'utf8'));
const hashes = Object.fromEntries(manifest.migrations.map((m: { file: string; sha256: string }) => [m.file, m.sha256]));
const ledgerOf = (n: number) => manifest.migrations.slice(0, n).map((m: { version: string; name: string }) => ({ version: m.version, name: m.name }));

test('planner: an empty ledger needs all 25; a prefix needs the rest; a complete ledger needs nothing', () => {
  const all = planApply(manifest, hashes, []); assert.ok(all.ok && all.applied === 0 && all.pending.length === 25 && all.pending[0].order === 1 && all.pending[24].order === 25);
  const part = planApply(manifest, hashes, ledgerOf(21)); assert.ok(part.ok && part.applied === 21 && part.pending.map((p) => p.name).join() === 'px3a_work_tables,px3a_work_helpers,px3a_work_api,px3a_work_erasure');
  const done = planApply(manifest, hashes, ledgerOf(25)); assert.ok(done.ok && done.pending.length === 0);
  const unordered = planApply(manifest, hashes, [...ledgerOf(5)].reverse()); assert.ok(unordered.ok, 'ledger order in the query result does not matter');
});
test('planner REFUSES: a changed file, a missing file, an extra file, an unknown ledger version, a gap, a renamed row, a duplicate, a ledger beyond the manifest', () => {
  const refusal = (r: ReturnType<typeof planApply>) => { assert.equal(r.ok, false); return (r as { refusals: string[] }).refusals.join(' | '); };
  assert.match(refusal(planApply(manifest, { ...hashes, [manifest.migrations[3].file]: 'f'.repeat(64) }, [])), /differs from the manifest/);
  const missing = { ...hashes }; delete missing[manifest.migrations[0].file]; assert.match(refusal(planApply(manifest, missing, [])), /missing on disk/);
  assert.match(refusal(planApply(manifest, { ...hashes, '99999999999999_extra.sql': 'a'.repeat(64) }, [])), /not in the manifest/);
  assert.match(refusal(planApply(manifest, hashes, [...ledgerOf(3), { version: '20990101000000', name: 'unknown' }])), /not a prefix/);
  assert.match(refusal(planApply(manifest, hashes, [ledgerOf(1)[0], ledgerOf(3)[2]])), /not a prefix/);
  assert.match(refusal(planApply(manifest, hashes, [{ ...ledgerOf(1)[0], name: 'renamed' }])), /ledger name differs/);
  assert.match(refusal(planApply(manifest, hashes, [ledgerOf(1)[0], ledgerOf(1)[0]])), /twice/);
  assert.match(refusal(planApply(manifest, hashes, [...ledgerOf(25), { version: '29990101000000', name: 'later' }])), /beyond the manifest/);
});
test('hosted target safety: only the direct host of one project, port 5432, login postgres, verify-full with a root certificate; poolers and mismatches are refused', () => {
  const good = { host: 'db.abcdefghijklmnopqrst.supabase.co', port: '5432', user: 'postgres', database: 'postgres', sslmode: 'verify-full', sslrootcert: '/x/ca.pem', expectHost: 'db.abcdefghijklmnopqrst.supabase.co' };
  assert.deepEqual(checkHostedTarget(good), []);
  const refused = (o: object) => checkHostedTarget({ ...good, ...o }).join(' | ');
  assert.match(refused({ host: 'aws-0-us-east-1.pooler.supabase.com' }), /pooler|PGHOST/); assert.match(refused({ user: 'postgres.abcdefghijklmnopqrst' }), /pooler|PGUSER/); assert.match(refused({ port: '6543' }), /5432/);
  assert.match(refused({ sslmode: 'require' }), /verify-full/); assert.match(refused({ sslrootcert: '' }), /ROOTCERT/); assert.match(refused({ expectHost: undefined }), /expect-host/); assert.match(refused({ host: 'db.zzzzzzzzzzzzzzzzzzzz.supabase.co' }), /does not equal/);
  assert.match(refused({ host: 'localhost', expectHost: 'localhost' }), /direct host/); assert.match(refused({ user: 'authenticator' }), /postgres/);
});
test('apply tool source: dry run by default, --apply and --confirm-pilot for a hosted write, one transaction per file with the ledger row inside it, stop at the first failure, limits set, no password handling', () => {
  const s = readFileSync(join(root, 'scripts/pilot-apply.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(s, /if \(!apply\) \{ console\.log\(plan\.pending\.length \? 'DRY RUN/); assert.match(s, /--confirm-pilot must equal the project reference/); assert.match(s, /begin;\\n\$\{body\}[\s\S]*insert into supabase_migrations\.schema_migrations[\s\S]*commit;/);
  assert.match(s, /process\.exit\(1\); \}\n  console\.log\(`applied/); assert.match(s, /lock_timeout=5s -c statement_timeout=120s -c idle_in_transaction_session_timeout=60s/);
  assert.doesNotMatch(s, /PGPASSWORD|password|--password|readFileSync\([^)]*pgpass/i, 'passwords are never read or passed here');
});
