// H13 as a function with injectable dependencies (so the failure paths are unit-tested without a network). Every step is independent and idempotent: a failure in one is recorded
// and the others are still attempted; the stage's overall result is failed if any step failed. Users are found ONLY by the exact identities this run recorded (its registry and its
// creation intents, which were persisted BEFORE each Auth request), never by pattern. Everything that needs application tables or the worker role first checks that they exist, so
// cleanup also works for a run that stopped before the migrations.
import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { checker } from './cli.mjs';
import { adminFindUsersByEmails } from './flows.mjs';
import { request as httpRequest } from './http.mjs';
import { queryJson as pgQueryJson, queryText as pgQueryText, runSql as pgRunSql } from './pg.mjs';
import { MARKER_RESET_SQL } from './sqlguard.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function runCleanup({ ctx, run, say, deps = {} }) {
  const d = { request: httpRequest, queryJson: pgQueryJson, queryText: pgQueryText, runSql: pgRunSql, findUsers: adminFindUsersByEmails, ...deps };
  const c = checker(run, say, { continueOnFail: true });
  const state = run.state();
  const registered = Object.values(state.fixtures?.users ?? {});
  const intents = state.intents ?? [];
  const emails = [...new Set([...registered.map((u) => u.email), ...intents.map((i) => i.email)].filter(Boolean).map((e) => String(e).toLowerCase()))];
  const knownIds = new Set([...registered.map((u) => u.id), ...intents.map((i) => i.id)].filter(Boolean));

  await c.check('H13a', 'every synthetic Auth user the run recorded (registered, or intended and not yet confirmed) is deleted, every account row is retired and no staff assignment is active', async () => {
    const errors = [];
    let found = new Map();
    try { found = await d.findUsers(ctx, emails, { req: d.request }); } catch (e) { errors.push(`lookup by recorded e-mail failed: ${e.message}`); }
    const ids = new Set(knownIds);
    for (const u of found.values()) ids.add(u.id);
    let deleted = 0; let gone = 0;
    for (const id of ids) {
      if (!UUID.test(String(id))) { errors.push('a recorded user id is not a UUID; not deleted'); continue; }
      try {
        const r = await d.request(ctx, { method: 'DELETE', path: `/auth/v1/admin/users/${id}`, apikey: ctx.keys.secret });
        if (r.status === 200 || r.status === 204) deleted++; else if (r.status === 404) gone++; else errors.push(`deleting ${String(id).slice(0, 8)}: HTTP ${r.status}`);
      } catch (e) { errors.push(`deleting ${String(id).slice(0, 8)}: ${e.message}`); }
    }
    try { const left = await d.findUsers(ctx, emails, { req: d.request }); if (left.size) errors.push(`${left.size} recorded fixture user(s) still exist`); } catch (e) { errors.push(`confirmation lookup failed: ${e.message}`); }
    let dbNote = 'application tables not present: no account rows to check';
    try {
      const have = await d.queryText(ctx, 'migrate', "select (to_regclass('app.accounts') is not null and to_regclass('app.staff_assignments') is not null and exists (select 1 from pg_roles where rolname = 'hackass_owner'))::text");
      if (have === 'true' && ids.size) {
        const list = [...ids].filter((i) => UUID.test(String(i))).map((i) => `'${i}'`).join(',');
        const j = await d.queryJson(ctx, 'migrate', `set role hackass_owner;\nselect json_build_object('active_accounts', (select count(*) from app.accounts where user_id in (${list}) and status = 'active'), 'active_assignments', (select count(*) from app.staff_assignments where user_id in (${list}) and revoked_at is null))::text`);
        if (j.active_accounts !== 0) errors.push(`${j.active_accounts} synthetic account(s) are still active`);
        if (j.active_assignments !== 0) errors.push(`${j.active_assignments} staff assignment(s) of synthetic users are still active`);
        dbNote = `${j.active_accounts} active accounts, ${j.active_assignments} active staff assignments`;
      }
    } catch (e) { errors.push(`database verification failed: ${e.message}`); }
    if (errors.length) throw new Error(errors.join('; '));
    return `${emails.length} recorded identities (${ids.size} ids): ${deleted} deleted now, ${gone} already gone; none left by exact e-mail; ${dbNote}`;
  });

  await c.check('H13b', 'the worker marker (role comment) is removed, if the worker role exists', async () => {
    const exists = await d.queryText(ctx, 'migrate', "select exists (select 1 from pg_roles where rolname = 'hackass_worker')::text");
    if (exists !== 'true') return 'the worker role does not exist yet; there is no marker to remove';
    const r = await d.runSql(ctx, 'migrate', `${MARKER_RESET_SQL};`, { kind: 'admin' });
    if (!r.ok) throw new Error(`removing the marker failed: ${r.stderr.split('\n')[0]}`);
    const left = await d.queryText(ctx, 'migrate', "select coalesce((select shobj_description(r.oid, 'pg_authid') from pg_roles r where r.rolname = 'hackass_worker'), '')");
    if (left !== '') throw new Error('the role comment is still set');
    return 'comment on role hackass_worker is null; read back empty';
  });

  await c.check('H13c', "the run's private secrets files (generated passwords and TOTP secrets, a probe password file) are deleted", async () => {
    for (const n of ['secrets.json', 'secrets.json.tmp', 'wrong-pgpass']) rmSync(path.join(run.dir, n), { force: true });
    for (const n of ['secrets.json', 'wrong-pgpass']) if (existsSync(path.join(run.dir, n))) throw new Error(`${n} is still present`);
    return 'secrets.json removed from the run directory (only salted hashes remain, for redaction)';
  });
  return c.out;
}
