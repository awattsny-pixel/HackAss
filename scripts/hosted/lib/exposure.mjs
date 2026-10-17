// What the staging project exposes over the Data API, checked with the right credential for each question.
//  * METADATA (what is listed): the OpenAPI description at GET /rest/v1/. Supabase serves that root only to a secret key (a publishable or member credential gets HTTP 401; self-hosted and the
//    local stack are unaffected for the publishable key, which is why the local selftest could not show it). So the description is read with the SECRET key, in `apikey` only (never a Bearer header),
//    and nothing else. PostgREST lists only what the calling role may execute, and the secret key is the service role, which has no EXECUTE on the api functions (measured on the local stack: the
//    description lists only `/`). So this read proves that api is exposed and that no table, view or unexpected function is listed; it can NOT show the public functions, which is why the public
//    catalog read is proved by an actual anonymous call instead.
//  * PUBLIC ACCESS AND ISOLATION (what a credential may reach): actual API endpoints with that credential. A non-exposed schema is probed with a function call (POST /rest/v1/rpc/<fn>, profile =
//    the schema) and must answer HTTP 406 PGRST106 naming the exposed list; a table that must not exist in api is probed with GET /rest/v1/<table> and must be "not found". None of these touch the root.
import { request, rpc } from './http.mjs';
import { API_FUNCTIONS } from './config.mjs';
import { openApiSurface } from './openapi.mjs';
import { classifyRefusal, requireSchemaExcluded } from './refusal.mjs';

const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
/** A harmless public function: only its schema profile matters to the probe. */
export const PROBE_FUNCTION = 'list_public_hacks';

/** Metadata inspection: the OpenAPI description of the api schema, read with the secret key. Returns { doc, surface }. */
export async function readOpenApiWithSecretKey(ctx, what = 'OpenAPI description (secret key)') {
  const r = await request(ctx, { path: '/rest/v1/', apikey: ctx.keys.secret, headers: { 'accept-profile': 'api' } });
  ok(r.status === 200 && r.body, `${what}: HTTP ${r.status}${r.body?.code ? ` ${r.body.code}` : ''}`);
  return { doc: r.body, surface: openApiSurface(r.body) };
}
/** The shape rules for the description: only the documented api functions, no table or view path. */
export function checkApiSurface(surface, what) {
  const extra = surface.rpc.filter((n) => !API_FUNCTIONS.includes(n));
  ok(extra.length === 0, `${what}: functions outside the api allowlist are listed: ${extra.join(',')}`);
  ok(surface.other.length === 0, `${what}: non-function paths are listed (tables or views): ${surface.other.slice(0, 5).join(',')}`);
}
/** A credential (publishable key, a member or staff token, the secret key) asks for a schema that must not be exposed, through an ACTUAL endpoint. Must be a schema-exclusion refusal (HTTP 406 PGRST106). */
export async function schemaIsRefused(ctx, schema, { token, apikey, expectExact = null, what } = {}) {
  const r = await rpc(ctx, PROBE_FUNCTION, token, {}, { schema, apikey });
  return requireSchemaExcluded(r, what ?? `Accept-Profile ${schema}`, { expectExact });
}
/** A table that must not be reachable in the api schema (api exposes functions only): the answer must be "not found", never data and never a different failure. */
export async function tableAbsentFromApi(ctx, table, { token, apikey, what } = {}) {
  const r = await request(ctx, { path: `/rest/v1/${table}`, token, apikey, headers: { 'accept-profile': 'api' } });
  const c = classifyRefusal(r);
  ok(c.kind === 'not-found', `${what ?? table}: expected "not found" for api.${table}, got ${c.kind} (HTTP ${c.status}${c.code ? ` ${c.code}` : ''})`);
  return c;
}

/** H2b. `staging` demands that public and graphql_public are refused with an exposed list of exactly ['api']. */
export async function verifyExposure(ctx, { staging }) {
  const { surface: s } = await readOpenApiWithSecretKey(ctx);
  checkApiSurface(s, 'OpenAPI description');
  // public access: the anonymous (publishable-key) credential really can call a public catalog read through api (which also proves api is exposed to it)
  const pub = await rpc(ctx, PROBE_FUNCTION, undefined, {}, { schema: 'api' });
  ok(pub.status === 200 && pub.body && typeof pub.body === 'object', `anonymous ${PROBE_FUNCTION} through api: HTTP ${pub.status}${pub.body?.code ? ` ${pub.body.code}` : ''} (is api exposed?)`);
  // isolation: the publishable (anonymous) credential, through a real endpoint, is refused every non-exposed schema
  const priv = await schemaIsRefused(ctx, 'app', { what: 'anonymous Accept-Profile app' });
  let note = `; private schema app refused through POST /rpc (exposed: ${priv.schemas.join(',')})`;
  if (staging) { // the disposable local stack deliberately exposes public and graphql_public; the staging project must expose api only
    const parts = [];
    for (const other of ['public', 'graphql_public']) {
      const c = await schemaIsRefused(ctx, other, { expectExact: ['api'], what: `anonymous Accept-Profile ${other}` });
      parts.push(`${other}: refused (exposed: ${c.schemas.join(',')})`);
    }
    note += `; ${parts.join('; ')}`;
  } else note += '; the local stack exposes public and graphql_public by design, that sub-check is staging-only';
  return `metadata read with the secret key: ${s.rpc.length} functions listed, no table or view paths; anonymous ${PROBE_FUNCTION} through api: HTTP 200${note}`;
}
