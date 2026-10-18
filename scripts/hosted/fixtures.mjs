#!/usr/bin/env node
// Authorization S8 (MUTATING): `fixtures` creates the synthetic users and the category, and performs H5b (the Auth triggers create and retire app.accounts rows).
// Fixture creation is separate from the checks that use the fixtures. Every user id created here is registered in the run state; the SQL guard refuses a staff statement
// that names any other id.  Usage: node scripts/hosted/fixtures.mjs --run-id=... --authorized=S8@<sha> --confirm-mutating=fixtures [--profile=...]
import { runStage, checker, ok } from './lib/cli.mjs';
import { queryText, runSql } from './lib/pg.mjs';
import { adminCreateUser, adminDeleteUser, fixtureEmail, newPassword, signIn, mfaEnroll, mfaVerify } from './lib/flows.mjs';
import { CATEGORY_INSERT_SQL, STAFF_INSERT_SQL } from './lib/sqlguard.mjs';

const code = await runStage('fixtures', process.argv.slice(2), async ({ ctx, run, say }) => {
  const c = checker(run, say);
  const state = run.state();
  state.fixtures.users = state.fixtures.users ?? {};
  const secrets = run.secrets(); secrets.users = secrets.users ?? {};
  const saveAll = () => { const st = run.state(); st.fixtures = state.fixtures; run.save(st); run.saveSecrets(secrets); };
  const ids = () => new Set(Object.values(state.fixtures.users).map((u) => u.id.toLowerCase()));
  const fresh = async (name) => {
    const password = newPassword();
    const email = fixtureEmail(run.runId, name);
    run.addIntent({ kind: 'fixture', name, email }); // recorded BEFORE the request: cleanup finds an interrupted creation again by this exact address
    const u = await adminCreateUser(ctx, { email, password });
    run.completeIntent(email, u.id);
    state.fixtures.users[name] = { id: u.id, email: u.email };
    secrets.users[name] = { password };
    saveAll();
    return u;
  };
  const accountStatus = (id) => queryText(ctx, 'migrate', `set role hackass_owner; select coalesce((select status from app.accounts where user_id = '${id}'), 'none')`);
  const activeAssignments = async (id) => Number(await queryText(ctx, 'migrate', `set role hackass_owner; select count(*) from app.staff_assignments where user_id = '${id}' and revoked_at is null`));

  await c.check('FX0', 'the synthetic category exists (no migration seeds one)', async () => {
    const slug = `stg-${run.runId.slice(0, 30)}`.replace(/-+$/, '');
    state.fixtures.category = slug; saveAll();
    const r = await runSql(ctx, 'migrate', `set role hackass_owner;\n${CATEGORY_INSERT_SQL(slug)};`, { kind: 'fixture' });
    ok(r.ok, `category insert failed: ${r.stderr.split('\n')[0]}`);
    return `category ${slug}`;
  });

  await c.check('H5b', 'creating an Auth user creates an active app.accounts row; deleting it retires the account and its staff assignments', async () => {
    const b1 = await fresh('b1'); const b2 = await fresh('b2');
    for (const u of [b1, b2]) ok((await accountStatus(u.id)) === 'active', `no active account row for ${u.email}`);
    await adminDeleteUser(ctx, b2.id);
    ok((await accountStatus(b2.id)) === 'deleted', 'the deleted user\'s account is not marked deleted');
    ok((await activeAssignments(b2.id)) === 0, 'the deleted user still has an active staff assignment');
    return 'b1 active; b2 created, then deleted: account status deleted, no active staff assignment';
  });

  await c.check('FX1', 'the session, staff-removal, MFA and catalog fixture users exist; staff fixtures have verified TOTP and an active staff assignment', async () => {
    await fresh('s-sess');
    for (const name of ['s-rm', 's-mfa', 's-rev']) {
      const u = await fresh(name);
      const s = await signIn(ctx, u.email, secrets.users[name].password);
      const f = await mfaEnroll(ctx, s.access_token, name);
      secrets.users[name].factorId = f.factorId; secrets.users[name].totpSecret = f.secret; saveAll();
      await mfaVerify(ctx, s.access_token, f.factorId, f.secret);
      secrets.users[name].lastWindow = Math.floor(Date.now() / 30_000); saveAll();
      const ins = await runSql(ctx, 'migrate', `set role hackass_owner;\n${STAFF_INSERT_SQL(u.id)};`, { kind: 'fixture', fixtureIds: ids() });
      ok(ins.ok, `staff assignment for ${name} failed: ${ins.stderr.split('\n')[0]}`);
      ok((await activeAssignments(u.id)) === 1, `${name} has no single active staff assignment`);
    }
    return 'users s-sess, s-rm, s-mfa, s-rev; three staff fixtures with TOTP and one active assignment each';
  });
  return c.out;
});
process.exitCode = code;
