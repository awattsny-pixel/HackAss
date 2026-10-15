#!/usr/bin/env node
// Authorization S8 (MUTATING class): `isolation` = H12. It creates Auth sessions for the fixture users and POSTs to private functions that WOULD RUN if isolation were broken, so it is
// confirmed like any mutating stage. Phase 1 proves each credential works on something it may do; phase 2 that the same credential is refused every private table and function FOR THE
// EXPECTED REASON (the schema is not exposed: HTTP 406 PGRST106, with the exposed list naming no private schema; a rate limit, a malformed request or a missing function proves nothing);
// phase 3 that the OpenAPI description lists only the documented api functions, and that public and graphql_public are not exposed.
// Usage: node scripts/hosted/isolation.mjs --run-id=... --authorized=S8@<sha> --confirm-mutating=isolation [--profile=...]
import { runStage, checker, ok } from './lib/cli.mjs';
import { request, rpc } from './lib/http.mjs';
import { signIn, steppedUp } from './lib/flows.mjs';
import { API_FUNCTIONS } from './lib/config.mjs';
import { openApiSurface } from './lib/openapi.mjs';
import { requireSchemaExcluded } from './lib/refusal.mjs';

const TABLES = ['hacks', 'publications', 'jobs', 'ai_ledger', 'accounts', 'staff_assignments'];
const PRIVATE_FUNCTIONS = [['app_review', 'public_blockers', { p_publication_id: '00000000-0000-0000-0000-000000000000' }], ['app_budget', 'reserve', {}], ['worker', 'claim_job', { p_job_type: 'publication_recheck' }], ['app_guard', 'require_member', {}]];
const NON_API_SCHEMAS = ['app_review', 'app_budget', 'app_guard', 'app_content', 'app_bridge', 'worker'];
const LEAKS = ['content_hash', 'user_id', 'staff_assignments', 'version_id', 'lease_epoch'];
const NOT_EXPOSED = ['public', 'graphql_public'];

const code = await runStage('isolation', process.argv.slice(2), async ({ ctx, run, profile, say }) => {
  const c = checker(run, say);
  const exact = profile === 'staging' ? ['api'] : null; // hosted: the exposed list must be exactly api; the local stack exposes more by design
  const state = run.state(); const sec = run.secrets();
  let creds;
  await c.check('H12a', 'phase 1: each credential works on an endpoint it is allowed to use (without this, its refusals prove nothing)', async () => {
    const b1 = await signIn(ctx, state.fixtures.users.b1.email, sec.users.b1.password);
    const rev = await steppedUp(ctx, run, 's-rev');
    creds = [
      { name: 'anonymous', token: undefined, apikey: undefined },
      { name: 'member', token: b1.access_token, apikey: undefined },
      { name: 'staff', token: rev.access_token, apikey: undefined },
      { name: 'secret key', token: undefined, apikey: ctx.keys.secret },
    ];
    const okOn = [];
    const anon = await rpc(ctx, 'list_public_hacks', undefined, {}); ok(anon.status === 200 && anon.body && typeof anon.body === 'object', `anonymous list_public_hacks: HTTP ${anon.status}`); okOn.push('anonymous list_public_hacks 200');
    const mem = await rpc(ctx, 'whoami', b1.access_token, {}); ok(mem.status === 200, `member whoami: HTTP ${mem.status}`); okOn.push('member whoami 200');
    const stf = await rpc(ctx, 'staff_probe', rev.access_token, {}); ok(stf.status === 200, `staff staff_probe: HTTP ${stf.status}`); okOn.push('staff staff_probe 200');
    const adm = await request(ctx, { path: '/auth/v1/admin/users?per_page=1', apikey: ctx.keys.secret }); ok(adm.status === 200, `secret key admin users: HTTP ${adm.status}`); okOn.push('secret key admin users 200');
    return okOn.join('; ');
  });

  await c.check('H12b', 'phase 2: the same credentials are refused every private table and function, with no application rows or column names in the answer', async () => {
    const statuses = new Set(); let n = 0;
    for (const cr of creds) {
      for (const t of TABLES) {
        const r = await request(ctx, { path: `/rest/v1/${t}`, token: cr.token, apikey: cr.apikey, headers: { 'accept-profile': 'app' } });
        requireSchemaExcluded(r, `${cr.name}: GET app.${t}`, { expectExact: exact });
        ok(!(Array.isArray(r.body) && r.body.length) && !LEAKS.some((w) => (r.text ?? JSON.stringify(r.body ?? '')).includes(w)), `${cr.name}: GET app.${t} body holds application data`);
        statuses.add(`${r.status}/${r.body?.code}`); n++;
      }
      for (const [schema, fn, body] of PRIVATE_FUNCTIONS) {
        const r = await rpc(ctx, fn, cr.token, body, { schema, apikey: cr.apikey });
        requireSchemaExcluded(r, `${cr.name}: POST ${schema}.${fn}`, { expectExact: exact });
        ok(!LEAKS.some((w) => JSON.stringify(r.body ?? r.text ?? '').includes(w)), `${cr.name}: POST ${schema}.${fn} body holds application data`);
        statuses.add(`${r.status}/${r.body?.code}`); n++;
      }
      if (profile === 'staging') {
        for (const other of NOT_EXPOSED) { requireSchemaExcluded(await request(ctx, { path: '/rest/v1/', token: cr.token, apikey: cr.apikey, headers: { 'accept-profile': other } }), `${cr.name}: Accept-Profile ${other}`, { expectExact: exact }); n++; }
      }
    }
    return `${n} direct requests across ${creds.length} credentials, every one refused for the expected reason, schema not exposed (${[...statuses].sort().join(' ')}), no application data in any body`;
  });

  await c.check('H12c', 'phase 3: the OpenAPI description lists only api functions, no tables and no private schema; GraphQL is off or shows no application type', async () => {
    const notes = [];
    for (const cr of creds.slice(0, 2)) {
      const r = await request(ctx, { path: '/rest/v1/', token: cr.token, headers: { 'accept-profile': 'api' } });
      ok(r.status === 200 && r.body, `${cr.name}: OpenAPI HTTP ${r.status}`);
      const s = openApiSurface(r.body);
      const extra = s.rpc.filter((x) => !API_FUNCTIONS.includes(x));
      ok(extra.length === 0, `${cr.name}: functions outside the allowlist are listed: ${extra.join(',')}`);
      ok(s.other.length === 0, `${cr.name}: non-function paths are listed: ${s.other.slice(0, 5).join(',')}`);
      const defs = Object.keys(r.body.definitions ?? r.body.components?.schemas ?? {});
      ok(!defs.some((d) => /^(hacks|publications|jobs|ai_ledger|accounts|staff_assignments)$/.test(d)), `${cr.name}: a table definition is listed`);
      const text = JSON.stringify(r.body);
      for (const sch of NON_API_SCHEMAS) ok(!text.includes(`${sch}.`) && !defs.includes(sch), `${cr.name}: the description mentions schema ${sch}`);
      notes.push(`${cr.name}: ${s.rpc.length} functions`);
    }
    const g = await request(ctx, { path: '/graphql/v1', method: 'POST', body: { query: '{ __schema { types { name } } }' } });
    if (g.status === 200) ok(!JSON.stringify(g.body).match(/hacks|publications|ai_ledger|staff_assignments/i), 'GraphQL introspection shows an application type');
    else ok(g.status >= 400 && g.status < 500, `GraphQL answered HTTP ${g.status}`);
    notes.push(`GraphQL HTTP ${g.status}`);
    const st = run.state(); st.facts.graphql_status = g.status; run.save(st);
    return notes.join('; ');
  });
  return c.out;
});
process.exitCode = code;
