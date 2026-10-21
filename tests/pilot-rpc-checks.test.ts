// PX-3e delta: the pilot RPC checker stops on failure, always cleans up and VERIFIES the cleanup, is bound to one HTTPS pilot project before any key is read, and positively covers
// all 11 member functions; the shared project binding (database, API) refuses staging, poolers and connection overrides. No database or provider is contacted: a local fake API is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHostedApiTarget, checkHostedTarget, FORBIDDEN_PILOT_REFS } from '../scripts/lib/pilot-plan.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const REF = 'abcdefghijklmnopqrst';
const scratch = mkdtempSync(join(tmpdir(), 'px3e-rpc-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

test('the API target: only https://<ref>.supabase.co, confirmed by reference, never staging; refused before any key file is read', () => {
  const good = { apiUrl: `https://${REF}.supabase.co`, confirmRef: REF };
  assert.deepEqual(checkHostedApiTarget(good), []);
  const refused = (o: object) => checkHostedApiTarget({ ...good, ...o }).join(' | ');
  assert.match(refused({ apiUrl: `http://${REF}.supabase.co` }), /https/);
  assert.match(refused({ apiUrl: `https://${REF}.supabase.co:8443` }), /exactly/);
  assert.match(refused({ apiUrl: `https://${REF}.supabase.co/rest/v1` }), /exactly/);
  assert.match(refused({ apiUrl: `https://user:pw@${REF}.supabase.co` }), /exactly/);
  assert.match(refused({ apiUrl: 'https://example.com' }), /supabase\.co/);
  assert.match(refused({ apiUrl: `https://${REF}.supabase.co.evil.test` }), /supabase\.co/);
  assert.match(refused({ apiUrl: undefined }), /URL/);
  assert.match(refused({ confirmRef: undefined }), /confirm-pilot/);
  assert.match(refused({ confirmRef: 'zzzzzzzzzzzzzzzzzzzz' }), /confirm-pilot/);
  const staging = FORBIDDEN_PILOT_REFS[0];
  assert.match(refused({ apiUrl: `https://${staging}.supabase.co`, confirmRef: staging }), /staging/);
});

test('the database target shares the binding: database name, staging, and connection overrides are refused', () => {
  const host = `db.${REF}.supabase.co`;
  const good = { host, port: '5432', user: 'postgres', database: 'postgres', sslmode: 'verify-full', sslrootcert: '/x/ca.pem', expectHost: host, env: {} };
  assert.deepEqual(checkHostedTarget(good), []);
  const refused = (o: object) => checkHostedTarget({ ...good, ...o }).join(' | ');
  assert.match(refused({ database: undefined }), /PGDATABASE/); assert.match(refused({ database: 'template1' }), /PGDATABASE/);
  const sh = `db.${FORBIDDEN_PILOT_REFS[0]}.supabase.co`; assert.match(refused({ host: sh, expectHost: sh }), /staging/);
  for (const n of ['PGSERVICE', 'PGSERVICEFILE', 'PGHOSTADDR', 'PGOPTIONS']) assert.match(refused({ env: { [n]: 'x' } }), new RegExp(n));
});

test('the apply and inventory tools both use the shared database binding; the RPC checker binds before reading a key file', () => {
  const strip = (f: string) => readFileSync(join(root, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['scripts/pilot-apply.mjs', 'scripts/pilot-inventory.mjs']) { const s = strip(f); assert.match(s, /checkHostedTarget\(/, f); assert.match(s, /database: process\.env\.PGDATABASE/, f); assert.match(s, /env: process\.env/, f); }
  const r = strip('scripts/pilot-rpc-checks.mjs');
  assert.ok(r.indexOf('checkHostedApiTarget(') < r.indexOf("f('PILOT_SECRET_KEY_FILE')"), 'binding check precedes reading the secret key file');
  assert.match(r, /AbortSignal\.timeout\(Math\.min\(CALL_MS, left\)\)/); assert.match(r, /stopped = true/); assert.match(r, /deleteUser/); assert.match(r, /getUserById/); assert.match(r, /process\.exit\(3\)/);
  assert.match(r, /'delete_my_prompt', \{ p_id: bothIds\.prompt\.id/); assert.match(r, /positive\.has\(f\)/, 'every one of the 11 functions needs a recorded SUCCESS for the owner');
});

test('hosted mode refuses a non-pilot URL without reading any key file or sending a request', async () => {
  const keyFile = join(scratch, 'k'); writeFileSync(keyFile, 'x'); chmodSync(keyFile, 0o600);
  const code = await new Promise<{ code: number | null; out: string }>((res) => { let out = ''; const c = spawn(process.execPath, ['scripts/pilot-rpc-checks.mjs', '--hosted', '--confirm-pilot', REF], { cwd: root, env: { ...process.env, PILOT_API_URL: 'http://127.0.0.1:9', PILOT_PUBLISHABLE_KEY_FILE: keyFile, PILOT_SECRET_KEY_FILE: keyFile } }); c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d)); c.on('exit', (code) => res({ code, out })); });
  assert.equal(code.code, 2); assert.match(code.out, /REFUSED/); assert.match(code.out, /https/);
});

// --- a fake API (local only) to prove stop-on-failure, deadlines and verified cleanup ----------------------------------------------------------------------------------------------------------
type Fake = { deleteFails?: boolean; create?: 'ok' | 'delayed-before-create' | 'delayed-after-create' | 'refuse422'; listHangs?: boolean };
function fakeApi(opts: Fake) {
  const created = new Map<string, string>(); const deleted = new Set<string>(); const hits: string[] = []; const t0 = Date.now(); const aborted: number[] = [];
  const userJson = (id: string, email: string) => ({ id, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() });
  const server = createServer((req, res) => {
    const url = req.url ?? ''; const path = url.split('?')[0]; hits.push(`${req.method} ${path}`);
    const send = (status: number, body: unknown) => { if (!res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
    res.on('close', () => { if (!res.writableEnded) aborted.push(Date.now() - t0); });
    let raw = ''; req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.method === 'POST' && path === '/auth/v1/admin/users') {
        const email = (JSON.parse(raw || '{}').email as string) ?? 'x@example.test'; const id = `00000000-0000-4000-8000-${String(created.size + 1).padStart(12, '0')}`;
        if (opts.create === 'refuse422') return send(422, { code: 'validation_failed', msg: 'refused' });
        if (opts.create === 'delayed-before-create') { setTimeout(() => { if (!res.destroyed) { created.set(id, email); send(200, userJson(id, email)); } }, 4000); return; }
        created.set(id, email);
        if (opts.create === 'delayed-after-create') { setTimeout(() => send(200, userJson(id, email)), 4000); return; }
        return send(200, userJson(id, email));
      }
      if (req.method === 'POST' && path.startsWith('/auth/v1/token')) return send(400, { error: 'invalid_grant', error_description: 'forced failure', code: 'invalid_credentials' });
      if (req.method === 'GET' && path === '/auth/v1/admin/users') { if (opts.listHangs) return; return send(200, { users: [...created].filter(([id]) => !deleted.has(id)).map(([id, e]) => userJson(id, e)), aud: 'authenticated' }); }
      if (req.method === 'DELETE' && path.startsWith('/auth/v1/admin/users/')) { if (opts.deleteFails) return send(500, { msg: 'boom' }); deleted.add(path.split('/').pop()!); return send(200, {}); }
      if (req.method === 'GET' && path.startsWith('/auth/v1/admin/users/')) { const id = path.split('/').pop()!; return created.has(id) && !deleted.has(id) ? send(200, userJson(id, created.get(id)!)) : send(404, { msg: 'not found', code: 'user_not_found' }); }
      return send(200, []);   // the public ping answers
    });
  });
  return { server, hits, aborted, created };
}
// The checker's local mode confirms erasure with a database subprocess (docker exec psql). These tests are fully isolated from Docker: DOCKER_BIN ALWAYS points at this stub, which reads the SQL
// and answers from STUB_DOCKER_OUT / STUB_DOCKER_EXIT (default: a count of 0, success). The real checker's strict handling is exercised by making the stub report rows or fail.
const dockerStub = () => { const f = join(scratch, 'docker-stub.sh'); writeFileSync(f, '#!/bin/sh\ncat > /dev/null\n[ -n "$STUB_DOCKER_ERR" ] && echo "$STUB_DOCKER_ERR" >&2\necho "${STUB_DOCKER_OUT-0}"\nexit "${STUB_DOCKER_EXIT-0}"\n'); chmodSync(f, 0o755); return f; };
function runLocal(port: number, env: Record<string, string> = {}) {
  const bin = join(scratch, `fake-supabase-${port}.sh`);
  writeFileSync(bin, `#!/bin/sh\necho '{"API_URL":"http://127.0.0.1:${port}","PUBLISHABLE_KEY":"pk-fake","SECRET_KEY":"sk-fake"}'\n`); chmodSync(bin, 0o755);
  const recDir = mkdtempSync(join(scratch, 'rec-'));
  return new Promise<{ code: number | null; out: string; recDir: string; ms: number }>((res) => { const t = Date.now(); let out = ''; const c = spawn(process.execPath, ['scripts/pilot-rpc-checks.mjs', '--local'], { cwd: root, env: { ...process.env, SUPABASE_BIN: bin, DOCKER_BIN: dockerStub(), PILOT_RPC_RECORD_DIR: recDir, ...env } }); c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d)); c.on('exit', (code) => res({ code, out, recDir, ms: Date.now() - t })); });
}
const listen = (s: ReturnType<typeof createServer>) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));
const recordFiles = (dir: string) => readdirSync(dir).map((d) => join(dir, d, 'fixtures.jsonl'));

test('a failed check stops the run: later checks are SKIPPED (none runs, none mutates), cleanup still runs and is verified; exit 1', async () => {
  const { server, hits } = fakeApi({}); const port = await listen(server);
  try {
    const r = await runLocal(port);
    assert.equal(r.code, 1, r.out); assert.match(r.out, /FAIL  R0/); assert.match(r.out, /SKIP  R1/); assert.match(r.out, /SKIP  R7/);
    assert.doesNotMatch(r.out, /PASS  R[1-9]/); assert.match(r.out, /cleanup verified: 1 fixture/);
    assert.ok(!hits.some((h) => h.includes('/rpc/') && !h.includes('list_public_hacks')), 'no RPC call but the initial reachability ping was made');
    assert.ok(hits.some((h) => h.startsWith('DELETE ')) && hits.some((h) => h.startsWith('GET /auth/v1/admin/users/')), 'cleanup deleted and then verified');
    assert.deepEqual(recordFiles(r.recDir).filter((f) => existsSync(f)), [], 'the private record is removed once every fixture is established gone');
  } finally { server.close(); }
});

test('an incomplete cleanup (the deletion error is returned, the user remains) is reported and fails the run with exit 3, never as success', async () => {
  const { server } = fakeApi({ deleteFails: true }); const port = await listen(server);
  try {
    const r = await runLocal(port);
    assert.equal(r.code, 3, r.out); assert.match(r.out, /CLEANUP INCOMPLETE/); assert.match(r.out, /NOT ESTABLISHED CLEAN \(remains\)/); assert.doesNotMatch(r.out, /cleanup verified/);
    assert.doesNotMatch(r.out, /@example\.test|0000-4000-8000/, 'no address or id in the public log');
  } finally { server.close(); }
});

test('DEADLINE: a request inside a running check is cut at the remaining run budget and later requests are not sent; cleanup then has its OWN allowance', async () => {
  const { server, hits, aborted } = fakeApi({ create: 'delayed-after-create' }); const port = await listen(server);
  try {
    const r = await runLocal(port, { PILOT_RPC_RUN_MS: '700' });
    assert.ok(aborted.length >= 1 && aborted[0] < 2500, `the slow createUser was cut at the run budget (aborted at ${aborted[0]} ms, the server would have answered at ~4000)`);
    assert.ok(!hits.some((h) => h.startsWith('POST /auth/v1/token')), 'no request was sent after the run budget ended (the sign-in that would follow createUser)');
    assert.match(r.out, /FAIL  R0/);
    assert.ok(hits.some((h) => h.startsWith('GET /auth/v1/admin/users')) && hits.some((h) => h.startsWith('DELETE ')), 'cleanup still ran after the run deadline had passed');
    assert.equal(r.code, 1, r.out); assert.match(r.out, /cleanup verified: 1 fixture/, 'the created user was found by address, removed and confirmed gone');
    assert.ok(r.ms < 10_000);
  } finally { server.close(); }
});

test('UNCERTAIN FIXTURE: a creation that times out and cannot be found afterwards is NEVER reported as verified clean; exit 3; the identifier is only in a private 0600 record', async () => {
  const { server, created } = fakeApi({ create: 'delayed-before-create' }); const port = await listen(server);
  try {
    const r = await runLocal(port, { PILOT_RPC_RUN_MS: '700' });
    assert.equal(r.code, 3, r.out); assert.match(r.out, /CLEANUP INCOMPLETE: 1 fixture/); assert.match(r.out, /NOT ESTABLISHED CLEAN \(unestablished\)/); assert.doesNotMatch(r.out, /cleanup verified/);
    assert.doesNotMatch(r.out, /pilot-rpc-[ab]-|@example\.test/, 'the intended address never appears in the public log');
    const files = recordFiles(r.recDir).filter((f) => existsSync(f)); assert.equal(files.length, 1, 'the record is kept for the operator');
    assert.equal(statSync(files[0]).mode & 0o777, 0o600, 'the record is 0600'); assert.equal(statSync(join(files[0], '..')).mode & 0o777, 0o700, 'its directory is 0700');
    const text = readFileSync(files[0], 'utf8'); assert.match(text, /pilot-rpc-a-[0-9a-f]{8}@example\.test/); assert.match(text, /"state":"intended"/); assert.match(text, /could not be established/);
    assert.match(r.out, new RegExp(files[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the log names the file path (not its contents)');
    void created;
  } finally { server.close(); }
});

test('a creation the API definitively refused (4xx) is proven never created and is not reported as incomplete', async () => {
  const { server } = fakeApi({ create: 'refuse422' }); const port = await listen(server);
  try { const r = await runLocal(port); assert.equal(r.code, 1, r.out); assert.match(r.out, /never created \(refused\)/); assert.match(r.out, /cleanup verified/); } finally { server.close(); }
});

test('the cleanup allowance is bounded too: a lookup that never answers ends within it, as incomplete (exit 3)', async () => {
  const { server } = fakeApi({ create: 'delayed-before-create', listHangs: true }); const port = await listen(server);
  try { const r = await runLocal(port, { PILOT_RPC_RUN_MS: '600', PILOT_RPC_CLEANUP_MS: '1200' }); assert.equal(r.code, 3, r.out); assert.match(r.out, /CLEANUP INCOMPLETE/); assert.ok(r.ms < 12_000, `took ${r.ms} ms`); } finally { server.close(); }
});

test('ISOLATION: the fake-API tests never reach a real Docker: the subprocess is always the stub, never the default macOS path or a docker on PATH', () => {
  const t = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.match(t, /DOCKER_BIN: dockerStub\(\)/); assert.doesNotMatch(t.split('// --- a fake API')[1], /Docker\.app|\/usr\/local\/bin\/docker|spawn\('docker'/);
});

test('local-mode content check, three outcomes kept apart: confirmed rows remaining and verification unavailable BOTH fail the run (exit 3), with different wording; confirmed none passes', async () => {
  const { server } = fakeApi({}); const port = await listen(server);
  try {
    const none = await runLocal(port); assert.equal(none.code, 1, none.out); assert.match(none.out, /cleanup verified/);                         // the stub says 0 rows
    const remains = await runLocal(port, { STUB_DOCKER_OUT: '2' }); assert.equal(remains.code, 3, remains.out); assert.match(remains.out, /CONFIRMED remaining \(2 row/); assert.doesNotMatch(remains.out, /UNAVAILABLE/); assert.doesNotMatch(remains.out, /cleanup verified/);
    const failed = await runLocal(port, { STUB_DOCKER_EXIT: '1', STUB_DOCKER_OUT: '', STUB_DOCKER_ERR: 'docker: not available' }); assert.equal(failed.code, 3, failed.out); assert.match(failed.out, /verification was UNAVAILABLE/); assert.doesNotMatch(failed.out, /CONFIRMED remaining/); assert.doesNotMatch(failed.out, /cleanup verified/);
    const garbled = await runLocal(port, { STUB_DOCKER_OUT: 'not a number' }); assert.equal(garbled.code, 3, garbled.out); assert.match(garbled.out, /UNAVAILABLE/);
  } finally { server.close(); }
});
