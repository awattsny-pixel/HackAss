#!/usr/bin/env node
// Authorization S7, READ-ONLY verification: `exposure` (H2b, after the OWNER exposes only `api`) and `inventory` (H4 catalog inventory against the golden, H5a triggers and bridge).
// Imports no module that can change hosted state.  Usage: node scripts/hosted/s7-verify.mjs exposure|inventory --run-id=... --authorized=S7@<sha> [--owner-confirmed=exposure]
import { runStage, checker, ok } from './lib/cli.mjs';
import { queryJson, runSql } from './lib/pg.mjs';
import { verifyExposure } from './lib/exposure.mjs';
import { INVENTORY_SQL, PRIVS_SQL, TRIGGERS_BRIDGE_SQL, goldenInventory } from './lib/sql.mjs';

const stage = process.argv[2];
if (!['exposure', 'inventory'].includes(stage)) { console.error('usage: s7-verify.mjs exposure|inventory [flags]'); process.exit(2); }

const code = await runStage(stage, process.argv.slice(3), async ({ ctx, run, profile, say }) => {
  const c = checker(run, say);
  if (stage === 'exposure') {
    await c.check('H2b', 'only the api schema is exposed: the OpenAPI description (read with the secret key) lists api functions only, and the anonymous credential is refused every other schema through a real endpoint', () => verifyExposure(ctx, { staging: profile === 'staging' }));
  }
  if (stage === 'inventory') {
    await c.check('H4', 'the function inventory equals the golden exactly; no table, column or sequence privileges; row-level security on every table; role attributes; public schema unchanged', async () => {
      const inv = await runSql(ctx, 'migrate', INVENTORY_SQL, { kind: 'read', timeoutMs: 90_000 });
      ok(inv.ok, `the inventory query failed: ${inv.stderr.split('\n')[0]}`);
      const got = inv.stdout.trim();
      const gold = goldenInventory();
      if (got !== gold) {
        const a = got.split('\n'); const b = gold.split('\n');
        const i = a.findIndex((l, k) => l !== b[k]);
        throw new Error(`inventory differs from the golden (${a.length} vs ${b.length} functions); first difference at line ${i + 1}: have "${(a[i] ?? '').slice(0, 120)}" want "${(b[i] ?? '').slice(0, 120)}"`);
      }
      const p = await queryJson(ctx, 'migrate', PRIVS_SQL);
      ok(p.table_privileges === 0, `anon, authenticated or the worker hold ${p.table_privileges} table privileges in the application schemas`);
      ok(p.column_privileges === 0, `anon, authenticated or the worker hold ${p.column_privileges} effective column privileges in the application schemas`);
      ok(p.sequence_privileges === 0, `anon, authenticated or the worker hold ${p.sequence_privileges} effective sequence privileges in the application schemas`);
      ok(p.tables_total > 0 && p.tables_without_rls.length === 0, `tables without row-level security: ${p.tables_without_rls.join(',') || '(none found: no application tables?)'}`);
      ok(p.owner_auth_privileges === false, 'hackass_owner holds a privilege on the auth schema');
      ok(p.owner_role?.login === false && p.owner_role?.connlimit === 0 && p.owner_role?.inherit === false, `hackass_owner attributes: ${JSON.stringify(p.owner_role)}`);
      ok(p.worker_role?.login === true && p.worker_role?.connlimit === 10 && p.worker_role?.inherit === false && p.worker_role?.super === false && p.worker_role?.createrole === false, `hackass_worker attributes: ${JSON.stringify(p.worker_role)}`);
      const before = run.state().facts.public_objects_before;
      ok(before === undefined || p.public_objects === before, `the public schema changed (${before} -> ${p.public_objects})`);
      return `${gold.split('\n').length} functions equal the golden; 0 table, column and sequence privileges for anon, authenticated and the worker; row-level security on all ${p.tables_total} application tables; roles as required; public objects ${p.public_objects}`;
    });
    await c.check('H5a', 'the Auth triggers and the session bridge exist with the required owner, definer mode, search_path and grants', async () => {
      const t = await queryJson(ctx, 'migrate', TRIGGERS_BRIDGE_SQL);
      const names = t.triggers.map((x) => x.name).join(',');
      ok(names === 'hackass_account_created,hackass_account_deleted', `triggers on auth.users: ${names}`);
      ok(t.triggers.every((x) => x.enabled === 'O'), 'a trigger is not enabled');
      ok(t.bridge.owner === 'postgres' && t.bridge.definer === true && JSON.stringify(t.bridge.config) === '["search_path=\\"\\""]', `bridge: ${JSON.stringify(t.bridge)}`);
      const e = t.bridge_execute;
      ok(e.hackass_owner === true && !e.anon && !e.authenticated && !e.hackass_worker, `bridge EXECUTE grants: ${JSON.stringify(e)}`);
      return 'two triggers enabled; app_bridge.session_valid owned by postgres, SECURITY DEFINER, search_path empty, executable by hackass_owner only';
    });
  }
  return c.out;
});
process.exitCode = code;
