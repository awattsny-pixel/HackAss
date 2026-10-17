// The hosted Data API serves the OpenAPI description (GET /rest/v1/) to a SECRET key only: a publishable or member credential gets HTTP 401 (the S7 part B attempt recorded exactly that,
// "OpenAPI description: HTTP 401"; self-hosted stacks and the local selftest are unaffected, which hid it). These tests run the exposure checks against a stub that behaves like the hosted
// project and prove: the description is read with the secret key in `apikey` only; the public and isolation checks use real endpoints with their own credentials and never the root; and
// a schema that IS exposed is still caught. Nothing here contacts a hosted system: the stub listens on 127.0.0.1 and the keys are fake, assembled at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const load = (f: string) => import(pathToFileURL(join(root, 'scripts/hosted', f)).href);
const ctxm = await load('lib/context.mjs'); const expo = await load('lib/exposure.mjs'); const httpLib = await load('lib/http.mjs'); const cfg = await load('lib/config.mjs');

const PUB = `sb_publishable_${'p'.repeat(20)}`; const SEC = `sb_secret_${'s'.repeat(20)}`;
const made: string[] = [];
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

type Opts = { exposed?: string[]; openApiPaths?: string[]; tableVisible?: boolean; rootOpenToAll?: boolean };
type Seen = { method: string; path: string; apikey?: string; authorization?: string; profile?: string };
async function withStub(opts: Opts, fn: (ctx: any, seen: Seen[]) => Promise<void>) {
  const exposed = opts.exposed ?? ['api'];
  const paths = opts.openApiPaths ?? ['/', ...cfg.API_FUNCTIONS.map((n: string) => `/rpc/${n}`)];
  const seen: Seen[] = [];
  const send = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const refuse = (res: http.ServerResponse) => send(res, 406, { code: 'PGRST106', message: 'The schema must be one of the following: ' + exposed.join(', '), hint: `Only the following schemas are exposed: ${exposed.join(', ')}` });
  const server = http.createServer((req, res) => {
    const h = req.headers; const p = req.url ?? '';
    const profile = (req.method === 'POST' ? h['content-profile'] : h['accept-profile']) as string | undefined;
    seen.push({ method: req.method ?? '', path: p, apikey: h.apikey as string | undefined, authorization: h.authorization as string | undefined, profile });
    req.resume();
    if (p === '/rest/v1/') { // the OpenAPI root
      if (!opts.rootOpenToAll && h.apikey !== SEC) return send(res, 401, { message: 'Access to schema is forbidden', hint: 'Accessing the schema via the Data API is only allowed using a secret API key.' });
      if (profile && !exposed.includes(profile)) return refuse(res);
      return send(res, 200, { swagger: '2.0', paths: Object.fromEntries(paths.map((x) => [x, {}])) });
    }
    if (p.startsWith('/rest/v1/rpc/')) { if (profile && !exposed.includes(profile)) return refuse(res); return exposed.includes(profile ?? 'api') && (profile ?? 'api') === 'api' ? send(res, 200, []) : send(res, 404, { code: 'PGRST202', message: 'function not found' }); }
    if (p.startsWith('/rest/v1/')) { if (profile && !exposed.includes(profile)) return refuse(res); return opts.tableVisible ? send(res, 200, []) : send(res, 404, { code: 'PGRST205', message: 'Could not find the table' }); }
    send(res, 404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), 'hs-oa-')); chmodSync(dir, 0o700); made.push(dir);
  const pf = join(dir, 'pgpass'); writeFileSync(pf, 'host.docker.internal:54322:postgres:postgres:p1\nhost.docker.internal:54322:postgres:hackass_worker:p2\n', { mode: 0o600 });
  const ctx = ctxm.createContext({ HOSTED_SELFTEST: '1', STAGING_REF: 'selftest', STAGING_URL: `http://127.0.0.1:${port}`, STAGING_MIGRATE_HOST: 'host.docker.internal', STAGING_MIGRATE_PORT: '54322', STAGING_MIGRATE_USER: 'postgres', STAGING_POOLER_USER: 'postgres',
    STAGING_POOLER_TXN_HOST: 'host.docker.internal', STAGING_POOLER_TXN_PORT: '54322', STAGING_POOLER_SESSION_HOST: 'host.docker.internal', STAGING_POOLER_SESSION_PORT: '54322', STAGING_WORKER_USER: 'hackass_worker',
    STAGING_PGPASSFILE: pf, STAGING_PUBLISHABLE_KEY: PUB, STAGING_SECRET_KEY: SEC }, { profile: 'selftest' });
  try { await fn(ctx, seen); } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
}

test('hosted restriction: the OpenAPI root refuses the publishable key (HTTP 401) and serves the secret key', async () => {
  await withStub({}, async (ctx) => {
    const withPublishable = await httpLib.request(ctx, { path: '/rest/v1/', headers: { 'accept-profile': 'api' } }); // what H2b did before: the publishable key
    assert.equal(withPublishable.status, 401);
    const withSecret = await httpLib.request(ctx, { path: '/rest/v1/', apikey: ctx.keys.secret, headers: { 'accept-profile': 'api' } });
    assert.equal(withSecret.status, 200);
  });
});
test('H2b: the description is read with the secret key in apikey only; the isolation probes use real endpoints with the publishable key; the root never sees the publishable key', async () => {
  await withStub({}, async (ctx, seen) => {
    const note = await expo.verifyExposure(ctx, { staging: true });
    assert.match(note, /metadata read with the secret key/); assert.match(note, /public: refused \(exposed: api\)/); assert.match(note, /graphql_public: refused \(exposed: api\)/);
    const roots = seen.filter((s) => s.path === '/rest/v1/');
    assert.equal(roots.length, 1, 'exactly one request to the restricted root');
    assert.equal(roots[0].apikey, SEC); assert.equal(roots[0].method, 'GET'); assert.equal(roots[0].profile, 'api');
    const probes = seen.filter((s) => s.path !== '/rest/v1/');
    assert.deepEqual(probes.map((s) => s.profile), ['app', 'public', 'graphql_public']);
    for (const p of probes) { assert.equal(p.method, 'POST'); assert.equal(p.path, '/rest/v1/rpc/list_public_hacks'); assert.equal(p.apikey, PUB); }
    for (const s of seen) assert.equal(s.authorization, undefined, 'an sb_ key is never sent as a Bearer token');
    assert.ok(!seen.some((s) => s.apikey === PUB && s.path === '/rest/v1/'), 'the publishable key never reaches the root');
  });
});
test('H2b still fails when a non-exposed schema is exposed (the refusal checks are retained)', async () => {
  await withStub({ exposed: ['api', 'public'] }, async (ctx) => { await assert.rejects(() => expo.verifyExposure(ctx, { staging: true }), /public/); }); // public answers as an exposed schema: not a refusal
  await withStub({ exposed: ['api', 'graphql_public'] }, async (ctx) => { await assert.rejects(() => expo.verifyExposure(ctx, { staging: true }), /graphql_public|exposed schemas are/); });
  await withStub({ exposed: ['api', 'app'] }, async (ctx) => { await assert.rejects(() => expo.verifyExposure(ctx, { staging: true }), /private schema is exposed|app/); });
});
test('H2b still inspects the description: a table path, an extra function or a missing public read fails', async () => {
  const base = ['/', ...cfg.API_FUNCTIONS.map((n: string) => `/rpc/${n}`)];
  await withStub({ openApiPaths: [...base, '/hacks'] }, async (ctx) => { await assert.rejects(() => expo.verifyExposure(ctx, { staging: true }), /non-function paths/); });
  await withStub({ openApiPaths: [...base, '/rpc/not_in_the_allowlist'] }, async (ctx) => { await assert.rejects(() => expo.verifyExposure(ctx, { staging: true }), /outside the api allowlist/); });
  await withStub({ openApiPaths: ['/', '/rpc/whoami'] }, async (ctx) => { await assert.rejects(() => expo.verifyExposure(ctx, { staging: true }), /public catalog reads are not listed/); });
});
test('a secret key that is refused at the root is reported with its status, never hidden', async () => {
  await withStub({}, async (ctx) => {
    const bad = Object.freeze({ ...ctx, keys: Object.freeze({ publishable: PUB, secret: PUB }) }); // the publishable key in the secret slot: the root answers 401
    Object.defineProperty(bad, Object.getOwnPropertySymbols(ctx)[0], { value: true });
    await assert.rejects(() => expo.readOpenApiWithSecretKey(bad), /HTTP 401/);
  });
});
test('public access: private tables are "not found" in api for each credential; a served table fails; other statuses are not accepted', async () => {
  await withStub({}, async (ctx, seen) => {
    await expo.tableAbsentFromApi(ctx, 'hacks', { token: undefined, apikey: undefined, what: 'anonymous' });
    await expo.tableAbsentFromApi(ctx, 'hacks', { token: 'member-token', apikey: undefined, what: 'member' });
    const last = seen.at(-1)!; assert.equal(last.path, '/rest/v1/hacks'); assert.equal(last.authorization, 'Bearer member-token'); assert.equal(last.profile, 'api');
    assert.ok(seen.every((s) => s.path !== '/rest/v1/'), 'no request to the OpenAPI root');
  });
  await withStub({ tableVisible: true }, async (ctx) => { await assert.rejects(() => expo.tableAbsentFromApi(ctx, 'hacks', { what: 'anonymous' }), /expected "not found"/); });
});
test('non-exposed schemas are refused for each credential through POST /rpc, member token as a Bearer header, publishable key as apikey', async () => {
  await withStub({}, async (ctx, seen) => {
    await expo.schemaIsRefused(ctx, 'public', { token: 'member-token', apikey: undefined, expectExact: ['api'], what: 'member' });
    const s = seen.at(-1)!; assert.equal(s.method, 'POST'); assert.equal(s.path, '/rest/v1/rpc/list_public_hacks'); assert.equal(s.authorization, 'Bearer member-token'); assert.equal(s.apikey, PUB); assert.equal(s.profile, 'public');
    await expo.schemaIsRefused(ctx, 'graphql_public', { token: undefined, apikey: ctx.keys.secret, expectExact: ['api'], what: 'secret key' });
    assert.equal(seen.at(-1)!.apikey, SEC);
  });
});
test('source guard: the only request to the OpenAPI root in the hosted scripts is the secret-key read in lib/exposure.mjs', () => {
  const files = [...readdirSync(join(root, 'scripts/hosted')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/hosted/${f}`), ...readdirSync(join(root, 'scripts/hosted/lib')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/hosted/lib/${f}`)];
  const hits: string[] = [];
  for (const f of files) for (const [i, line] of readFileSync(join(root, f), 'utf8').split('\n').entries()) if (/path:\s*'\/rest\/v1\/'/.test(line) && !/^\s*\/\//.test(line)) hits.push(`${f}:${i + 1}:${line.trim()}`);
  assert.equal(hits.length, 1, hits.join('\n')); assert.match(hits[0], /^scripts\/hosted\/lib\/exposure\.mjs:/); assert.match(hits[0], /apikey: ctx\.keys\.secret/); assert.ok(!/token/.test(hits[0]));
});
