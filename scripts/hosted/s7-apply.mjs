#!/usr/bin/env node
// Authorization S7 (MUTATING): `identity` (H1b), `migrate` (H2a), `worker-marker` (H2c), `rerun` (H3).  Usage: node scripts/hosted/s7-apply.mjs <stage> --run-id=... --authorized=S7@<sha> --confirm-mutating=<stage> [--profile=...]
// Read-only verification of the same group lives in s7-verify.mjs (exposure, inventory).
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { runStage, checker, ok } from './lib/cli.mjs';
import { queryJson, queryText, runSql } from './lib/pg.mjs';
import { adminCreateUser, adminDeleteUser } from './lib/flows.mjs';
import { LEDGER_EXISTS_SQL, LEDGER_SQL, FINGERPRINT_SQL } from './lib/sql.mjs';
import { MARKER_SET_SQL, MARKER_READ_SQL } from './lib/sqlguard.mjs';
import { runBounded, childEnv } from './lib/exec.mjs';
import { cliUrl, REPO_ROOT, STAGING } from './lib/config.mjs';

const stage = process.argv[2];
const argv = process.argv.slice(3);
if (!['identity', 'migrate', 'worker-marker', 'rerun'].includes(stage)) { console.error('usage: s7-apply.mjs identity|migrate|worker-marker|rerun [flags]'); process.exit(2); }

const cli = () => process.env.SUPABASE_BIN || path.join(REPO_ROOT, '.tools/supabase/2.120.0/supabase');
const repoVersions = () => readdirSync(path.join(REPO_ROOT, 'supabase/migrations')).filter((f) => /^\d{14}_.*\.sql$/.test(f)).map((f) => f.split('_')[0]).sort();
async function push(ctx, dryRun) {
  const m = ctx.targets.migrate;
  const args = ['--output-format', 'stream-json', 'db', 'push', '--db-url', cliUrl({ host: m.host, port: m.port, user: m.user, profile: ctx.profile }), ...(dryRun ? ['--dry-run'] : [])];
  const r = await runBounded(cli(), args, { cwd: REPO_ROOT, timeoutMs: dryRun ? 120_000 : 600_000, env: childEnv({ PGPASSFILE: ctx.targets.passfile }) });
  if (r.timedOut) throw new Error(`supabase db push${dryRun ? ' --dry-run' : ''} exceeded its deadline`);
  const lines = (r.stdout + '\n' + r.stderr).split('\n').filter((l) => l.trim().startsWith('{'));
  const doc = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const result = doc.find((d) => d.type === 'result')?.data;
  const error = doc.find((d) => d.type === 'error' || d._tag === 'Error');
  if (r.code !== 0) throw new Error(`supabase db push${dryRun ? ' --dry-run' : ''} failed (exit ${r.code}): ${JSON.stringify(error ?? r.stderr.slice(-300)).slice(0, 400)}`);
  if (!result) throw new Error(`supabase db push printed no result document (exit ${r.code}, ${doc.length} JSON lines, stderr tail: ${r.stderr.slice(-200)})`);
  return result;
}
const ledger = async (ctx, ep = 'migrate') => ((await queryText(ctx, ep, LEDGER_EXISTS_SQL)) === 'true' ? queryJson(ctx, ep, LEDGER_SQL) : { count: 0, versions: [], md5: '' });

const code = await runStage(stage, argv, async ({ ctx, run, profile, say }) => {
  const c = checker(run, say);
  const keep = (k, v) => { const st = run.state(); st.facts[k] = v; run.save(st); };

  if (stage === 'identity') {
    await c.check('H1b', 'the API and every database endpoint are the same project (a throwaway Auth user is visible through all three, then removed)', async () => {
      const nonce = randomBytes(6).toString('hex');
      const email = `staging-${nonce}-ident@example.test`;
      ok(/^staging-[0-9a-f]{12}-ident@example\.test$/.test(email), 'unexpected identity email');
      const user = await adminCreateUser(ctx, { email, password: `Pw-${randomBytes(16).toString('base64url')}` });
      const counts = {};
      try {
        for (const ep of ['migrate', 'session', 'txn']) counts[ep] = Number(await queryText(ctx, ep, `select count(*) from auth.users where email = '${email}'`));
      } finally { await adminDeleteUser(ctx, user.id); }
      const after = Number(await queryText(ctx, 'migrate', `select count(*) from auth.users where email = '${email}'`));
      ok(Object.values(counts).every((n) => n === 1), `the throwaway user was not visible on every endpoint (${JSON.stringify(counts)}): an endpoint is a different project or database`);
      ok(after === 0, 'the throwaway user is still present after deletion');
      return `visible on migration, session and transaction endpoints (${JSON.stringify(counts)}); removed (${after})`;
    });
  }

  if (stage === 'migrate') {
    await c.check('H2a', 'the pending migrations are exactly the expected ones, apply cleanly, and the ledger matches the repository', async () => {
      const repo = repoVersions();
      const before = await ledger(ctx);
      const unknown = before.versions.filter((v) => !repo.includes(v));
      ok(unknown.length === 0, `the target ledger has versions that are not in the repository: ${unknown.join(',')}`);
      const expectedPending = repo.filter((v) => !before.versions.includes(v));
      if (profile === 'staging') ok(before.count === 0 && expectedPending.length === repo.length, `a fresh project must have an empty ledger (found ${before.count}); this procedure applies all ${repo.length} migrations once`);
      ok(expectedPending.length > 0, 'nothing is pending');
      const dry = await push(ctx, true);
      const listed = (dry.migrations ?? []).map((f) => f.split('_')[0]);
      ok(JSON.stringify(listed) === JSON.stringify(expectedPending), `the dry-run lists ${listed.length} migrations that differ from the expected ${expectedPending.length}`);
      const done = await push(ctx, false);
      ok(done.upToDate === false, 'the real run did not report applying migrations');
      const after = await ledger(ctx);
      ok(JSON.stringify(after.versions) === JSON.stringify(repo), `the ledger after the run (${after.count}) does not equal the repository's ${repo.length} migrations`);
      keep('ledger_md5_after_migrate', after.md5);
      return `applied ${expectedPending.length} of ${repo.length} (${expectedPending[0]} .. ${expectedPending.at(-1)}); ledger ${after.count}`;
    });
  }

  if (stage === 'worker-marker') {
    await c.check('H2c', 'the worker endpoints are the same project (a marker set as postgres is read back as hackass_worker through the transaction and session pooler)', async () => {
      const nonce = randomBytes(8).toString('hex');
      const set = await runSql(ctx, 'migrate', MARKER_SET_SQL(nonce), { kind: 'admin' });
      ok(set.ok, `could not set the marker as postgres: ${set.stderr.split('\n')[0]}`);
      keep('worker_marker', nonce);
      const seen = {};
      for (const ep of ['worker-txn', 'worker-session']) {
        const r = await runSql(ctx, ep, MARKER_READ_SQL, { kind: 'read' });
        ok(r.ok, `the worker login could not connect through ${ep}: ${r.stderr.split('\n')[0]}`);
        seen[ep] = r.stdout.trim();
      }
      ok(Object.values(seen).every((v) => v === nonce), 'the marker read through a worker endpoint does not equal the marker that was set: that endpoint is not this database');
      return 'marker visible through both worker endpoints';
    });
  }

  if (stage === 'rerun') {
    await c.check('H3', 'the migration runner invoked again applies nothing: dry-run empty, ledger and catalog fingerprint unchanged', async () => {
      const repo = repoVersions();
      const l1 = await ledger(ctx); const f1 = await queryText(ctx, 'migrate', FINGERPRINT_SQL);
      ok(JSON.stringify(l1.versions) === JSON.stringify(repo), 'the ledger is not fully applied before the rerun');
      const dry = await push(ctx, true);
      ok(dry.upToDate === true && (dry.migrations ?? []).length === 0, `the dry-run still lists migrations (${(dry.migrations ?? []).length})`);
      const real = await push(ctx, false);
      ok(real.upToDate === true && (real.migrations ?? []).length === 0, 'the real second invocation applied something');
      const l2 = await ledger(ctx); const f2 = await queryText(ctx, 'migrate', FINGERPRINT_SQL);
      ok(l2.count === l1.count && l2.md5 === l1.md5, 'the ledger changed');
      ok(f1 === f2, 'the catalog fingerprint changed');
      keep('catalog_fingerprint', f2);
      return `ledger ${l2.count} unchanged; fingerprint ${f2.slice(0, 12)} unchanged; expected project ${STAGING.ref === ctx.targets.ref ? 'staging' : 'selftest'}`;
    });
  }
  return c.out;
});
process.exitCode = code;
