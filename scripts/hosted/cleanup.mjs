#!/usr/bin/env node
// Authorization S9 (MUTATING, repeatable): `cleanup` = H13. Deletes the synthetic Auth users of the run through the admin API (the delete trigger retires the accounts and revokes staff
// assignments), confirms no active assignment remains, removes the worker marker (a role comment, as postgres) and deletes the run's private secrets file. It needs only `preflight`, so a
// failed or interrupted run can always be cleaned up; every step is idempotent. Keys, the owner's password file, and the project itself are OWNER actions, listed at the end.
// Usage: node scripts/hosted/cleanup.mjs --run-id=... --authorized=S9@<sha> --confirm-mutating=cleanup [--profile=...] [--owner-deletion-date=YYYY-MM-DD]
import { rmSync } from 'node:fs';
import path from 'node:path';
import { runStage, checker, ok } from './lib/cli.mjs';
import { queryText, runSql } from './lib/pg.mjs';
import { request } from './lib/http.mjs';
import { MARKER_RESET_SQL } from './lib/sqlguard.mjs';

const code = await runStage('cleanup', process.argv.slice(2), async ({ ctx, run, flags, say }) => {
  const c = checker(run, say);
  const state = run.state();
  const users = Object.entries(state.fixtures?.users ?? {});

  await c.check('H13a', 'every synthetic Auth user is deleted, every account row is retired and no staff assignment is active', async () => {
    let deleted = 0; let gone = 0;
    for (const [, u] of users) {
      const r = await request(ctx, { method: 'DELETE', path: `/auth/v1/admin/users/${u.id}`, apikey: ctx.keys.secret });
      if (r.status === 200 || r.status === 204) deleted++; else if (r.status === 404) gone++; else ok(false, `deleting ${u.email}: HTTP ${r.status}`);
    }
    let notDeleted = 0; let active = 0;
    for (const [, u] of users) {
      const st = await queryText(ctx, 'migrate', `set role hackass_owner; select coalesce((select status from app.accounts where user_id = '${u.id}'), 'none')`);
      if (st === 'active') notDeleted++;
      active += Number(await queryText(ctx, 'migrate', `set role hackass_owner; select count(*) from app.staff_assignments where user_id = '${u.id}' and revoked_at is null`));
    }
    ok(notDeleted === 0, `${notDeleted} synthetic account(s) are still active`);
    ok(active === 0, `${active} staff assignment(s) of synthetic users are still active`);
    return `${users.length} fixture users: ${deleted} deleted now, ${gone} already gone; 0 active accounts, 0 active staff assignments`;
  });

  await c.check('H13b', 'the worker marker (role comment) is removed', async () => {
    const r = await runSql(ctx, 'migrate', `${MARKER_RESET_SQL};`, { kind: 'admin' });
    ok(r.ok, `removing the marker failed: ${r.stderr.split('\n')[0]}`);
    const left = await queryText(ctx, 'migrate', "select coalesce((select shobj_description(r.oid, 'pg_authid') from pg_roles r where r.rolname = 'hackass_worker'), '')");
    ok(left === '', 'the role comment is still set');
    return 'comment on role hackass_worker is null; read back empty';
  });

  await c.check('H13c', "the run's private secrets file (generated passwords and TOTP secrets) is deleted", async () => {
    rmSync(path.join(run.dir, 'secrets.json'), { force: true });
    rmSync(path.join(run.dir, 'wrong-pgpass'), { force: true });
    return 'secrets.json removed from the run directory';
  });

  const date = flags['owner-deletion-date'];
  const st = run.state(); st.facts.owner_deletion_date = date ?? null; run.save(st);
  say('OWNER ACTIONS still open after this stage (not performed by the script):');
  say('  - revoke or rotate the secret key and any other key or token created for the run;');
  say('  - delete the password file(s) and unset every exported secret in the operator shell;');
  say('  - delete the staging project (O9); the synthetic content cannot be deleted by design; until then keep sign-ups closed and point no application at it;');
  say(`  - owner-confirmed project deletion date: ${date ?? 'NOT YET RECORDED (pass --owner-deletion-date=YYYY-MM-DD when the owner confirms)'}`);
  return c.out;
});
process.exitCode = code;
