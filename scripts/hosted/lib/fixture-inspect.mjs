// READ-ONLY inspection of the recorded fixture users for `adopt --through=s8`: nothing is created, deleted, signed in or reset.
import { request } from './http.mjs';
import { queryText } from './pg.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** READ-ONLY inspection of the fixture users: one GET per user against the Auth admin API (secret key, apikey header only) and two read queries as the owner role (account status, active assignments). */
export async function inspectFixtures(ctx, users) {
  const out = {};
  for (const [name, u] of Object.entries(users)) {
    if (!UUID.test(u?.id ?? '')) throw new Error(`fixture ${name} has no valid id`);
    const r = await request(ctx, { path: `/auth/v1/admin/users/${u.id}`, apikey: ctx.keys.secret });
    if (r.status !== 200 && r.status !== 404) throw new Error(`fixture ${name}: Auth admin lookup answered HTTP ${r.status}`);
    const accountStatus = await queryText(ctx, 'migrate', `set role hackass_owner; select coalesce((select status from app.accounts where user_id = '${u.id}'), 'none')`);
    const assignments = Number(await queryText(ctx, 'migrate', `set role hackass_owner; select count(*) from app.staff_assignments where user_id = '${u.id}' and revoked_at is null`));
    out[name] = { auth: r.status === 200 ? 'present' : 'absent', accountStatus, assignments };
  }
  return out;
}
