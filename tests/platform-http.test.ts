import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AppError, toErrorResponse } from '../src/platform/http/errors.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from '../src/platform/http/request-id.ts';
import { parseJsonBody } from '../src/platform/http/validate.ts';
import { assertSameOrigin } from '../src/platform/http/origin.ts';
import { withRequestContext } from '../src/platform/http/handler.ts';
import { REDACTED, createLogger, redact, redactString } from '../src/platform/log.ts';
import type { RequestId } from '../src/platform/actor.ts';

const ORIGIN = 'https://hackass.example.test';
// assembled at run time so this file holds no literal credential-shaped URL (the secret scanner would flag it)
const pg = (user: string, pw: string, host: string) => ['postgres', '://', user, ':', pw, '@', host].join('');
const rid = 'req-12345678' as RequestId;
const json = (body: unknown, extra: Record<string, string> = {}) => new Request('https://x.test/api', { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AppError; } assert.fail('expected a rejection'); };
const jwt = ['eyJ' + 'a'.repeat(12), 'eyJ' + 'b'.repeat(12), 'c'.repeat(12)].join('.');

test('request ids: safe inbound ids are kept; short, long, or unsafe ones (incl. newlines) are replaced', () => {
  // a stub, not new Headers(): the platform Headers constructor refuses some of these values outright
  const h = (v: string) => ({ get: (name: string) => (name === REQUEST_ID_HEADER ? v : null) }) as unknown as Headers;
  assert.equal(resolveRequestId(h('abcDEF12_-34')), 'abcDEF12_-34');
  for (const bad of ['short', 'x'.repeat(65), 'has space in it 1234', 'new\nline-12345678', '<script>alert(1)</script>', 'a'.repeat(8) + '%0d%0a']) {
    const out = resolveRequestId(h(bad));
    assert.notEqual(out, bad);
    assert.match(out, /^[0-9a-f-]{36}$/);
  }
  assert.match(resolveRequestId(new Headers()), /^[0-9a-f-]{36}$/);
});

test('errors: AppError maps to its status and public message; unknown errors are a generic 500 with no detail', async () => {
  const app = toErrorResponse(new AppError('forbidden', 'Nope.'), rid);
  assert.equal(app.status, 403);
  assert.deepEqual(await app.json(), { error: { code: 'forbidden', message: 'Nope.' }, requestId: rid });
  const leaky = new Error('connect ECONNREFUSED ' + pg('user', 'hunter2', 'db.internal:5432/app') + ' (SELECT secret FROM x)');
  const res = toErrorResponse(leaky, rid);
  const text = await res.text();
  assert.equal(res.status, 500);
  assert.ok(!/hunter2|postgres|SELECT|ECONNREFUSED|stack/i.test(text), text);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-request-id'), rid);
  assert.deepEqual(JSON.parse(text).error, { code: 'internal', message: 'Internal server error' });
});

const bodySchema = z.strictObject({ title: z.string().min(1).max(20), count: z.number().int().optional() });

test('JSON bodies: valid parses; wrong media type, bad JSON, and oversize are rejected with the right codes', async () => {
  assert.deepEqual(await parseJsonBody(json({ title: 'ok' }), bodySchema), { title: 'ok' });
  const wrongType = new Request('https://x.test', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal((await errorOf(parseJsonBody(wrongType, bodySchema))).code, 'unsupported_media_type');
  const bad = new Request('https://x.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal((await errorOf(parseJsonBody(bad, bodySchema))).code, 'validation_failed');
  assert.equal((await errorOf(parseJsonBody(json({ title: 'x'.repeat(5000) }), bodySchema, { maxBytes: 1024 }))).code, 'payload_too_large');
  const streamed = new Request('https://x.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x', pad: 'y'.repeat(5000) }), duplex: 'half' } as RequestInit);
  assert.equal((await errorOf(parseJsonBody(streamed, bodySchema, { maxBytes: 1024 }))).code, 'payload_too_large');
});

test('strict schemas reject unknown (privileged) fields; failures list field paths and codes, never submitted values', async () => {
  const canary = 'SUBMITTED-CANARY-77';
  const e1 = await errorOf(parseJsonBody(json({ title: 'ok', risk_class: 'low', role: canary }), bodySchema));
  assert.equal(e1.code, 'validation_failed');
  assert.ok(e1.fields.some((f) => f.code === 'unrecognized_keys'));
  assert.ok(!JSON.stringify(e1.fields).includes(canary) && !e1.message.includes(canary));
  const e2 = await errorOf(parseJsonBody(json({ title: canary.repeat(3), count: 'nope' }), bodySchema));
  assert.deepEqual(e2.fields.map((f) => f.path).sort(), ['count', 'title']);
  for (const f of e2.fields) assert.deepEqual(Object.keys(f).sort(), ['code', 'path'], 'a field issue may carry only a path and a code');
  assert.ok(!JSON.stringify(e2.fields).includes(canary));
});

test('origin check: safe methods pass; mutations need an Origin equal to the application origin', () => {
  const req = (method: string, origin?: string) => new Request('https://x.test', { method, headers: origin ? { origin } : {} });
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.doesNotThrow(() => assertSameOrigin(req(m), ORIGIN));
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.throws(() => assertSameOrigin(req(m), ORIGIN), (e: unknown) => e instanceof AppError && e.code === 'forbidden', `${m} without origin`);
    assert.throws(() => assertSameOrigin(req(m, 'https://evil.test'), ORIGIN), AppError, `${m} wrong origin`);
    assert.doesNotThrow(() => assertSameOrigin(req(m, ORIGIN), ORIGIN));
  }
  assert.throws(() => assertSameOrigin(req('POST', 'https://hackass.example.test.evil.test'), ORIGIN));
});

const collect = () => { const lines: string[] = []; return { lines, sink: { write: (l: string) => { lines.push(l); } } }; };

test('request wrapper: id echoed, no-store default, explicit cache-control preserved', async () => {
  const { sink } = collect();
  const ok = withRequestContext(async () => new Response('hi'), { appOrigin: ORIGIN, sink });
  const r = await ok(new Request('https://x.test', { headers: { [REQUEST_ID_HEADER]: 'caller-id-1234' } }));
  assert.equal(r.headers.get('x-request-id'), 'caller-id-1234');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const cached = withRequestContext(async () => new Response('hi', { headers: { 'cache-control': 'public, s-maxage=60' } }), { appOrigin: ORIGIN, sink });
  assert.equal((await cached(new Request('https://x.test'))).headers.get('cache-control'), 'public, s-maxage=60');
});

test('request wrapper: unexpected errors become a generic 500; the log has the request id and no leaked detail', async () => {
  const { lines, sink } = collect();
  const handler = withRequestContext(async () => { throw new Error('boom ' + pg('svc', 'p4ssw0rd', 'db.internal/x') + ' ' + jwt); }, { appOrigin: ORIGIN, sink });
  const res = await handler(new Request('https://x.test', { headers: { authorization: `Bearer ${jwt}`, cookie: 'sb=secretcookie' } }));
  const body = await res.text();
  assert.equal(res.status, 500);
  assert.ok(!/p4ssw0rd|boom|svc/.test(body));
  const log = lines.join('\n');
  assert.ok(lines.length >= 1);
  assert.ok(!/p4ssw0rd|secretcookie/.test(log) && !log.includes(jwt), 'secret reached the log');
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.requestId, res.headers.get('x-request-id'));
});

test('request wrapper: AppErrors are mapped (info log), and mutations are origin-checked before the handler runs', async () => {
  const { lines, sink } = collect();
  let ran = false;
  const handler = withRequestContext(async () => { ran = true; throw new AppError('not_found', 'Missing.'); }, { appOrigin: ORIGIN, sink });
  const crossOrigin = await handler(new Request('https://x.test', { method: 'POST', headers: { origin: 'https://evil.test' } }));
  assert.equal(crossOrigin.status, 403);
  assert.equal(ran, false, 'handler must not run for a cross-origin mutation');
  const res = await handler(new Request('https://x.test'));
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(lines[lines.length - 1]).level, 'info');
});

test('logger redaction: sensitive keys, credential-shaped values, emails, depth and size are all handled', () => {
  const out = redact({
    authorization: 'Bearer abc.def.ghi-secret', Cookie: 'a=b', password: 'pw', apiKey: 'k', user: { email: 'a@b.test', name: 'ok' },
    note: `token ${jwt} and Bearer abcdefghijkl and postgresql://u:pw@h/db and ${'sb_' + 'secret_' + 'a'.repeat(20)} mail me@x.test`,
    deep: { a: { b: { c: { d: { e: 'x' } } } } }, list: Array.from({ length: 50 }, (_, i) => i), long: 'z'.repeat(2000),
  }) as Record<string, unknown>;
  const s = JSON.stringify(out);
  for (const leak of [jwt, 'abcdefghijkl', 'u:pw@', 'a'.repeat(20), 'me@x.test', 'a@b.test', 'abc.def.ghi-secret']) assert.ok(!s.includes(leak), `leaked: ${leak}`);
  assert.equal(out.authorization, REDACTED);
  assert.equal(out.Cookie, REDACTED);
  assert.equal(out.password, REDACTED);
  assert.equal(out.apiKey, REDACTED);
  assert.equal((out.user as Record<string, unknown>).email, REDACTED);
  assert.equal((out.user as Record<string, unknown>).name, 'ok');
  assert.equal((out.list as unknown[]).length, 20);
  assert.ok((out.long as string).length <= 500);
  assert.ok(s.includes('[truncated]'));
  assert.equal(redactString('postgres://user:pw@host/db'), `postgres://${REDACTED}@host/db`);
});

test('logger: errors are logged by name/code and a redacted message, with no stack', () => {
  const { lines, sink } = collect();
  const err = Object.assign(new Error(`failed for ${jwt}`), { code: 'XX000' });
  createLogger(sink, { service: 'web-test' }, () => new Date('2026-10-13T00:00:00Z')).error('db_failed', { error: err });
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.ts, '2026-10-13T00:00:00.000Z');
  assert.deepEqual(Object.keys(rec.error).sort(), ['code', 'message', 'name']);
  assert.ok(!lines[0].includes(jwt));
  assert.ok(!('stack' in rec.error));
});
