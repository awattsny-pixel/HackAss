// Bounded body reading: the limit is enforced while streaming, a declared oversize is refused without reading, and a deadline ends a stalled or dripping upload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readBodyBounded, MAX_FORM_BODY_BYTES } from '../src/platform/http/body.ts';

const enc = new TextEncoder();
function streamOf(chunks: (string | Uint8Array)[], opts: { gapMs?: number; neverEnd?: boolean; onCancel?: () => void; pulled?: { n: number } } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (opts.pulled) opts.pulled.n = i;
      if (i < chunks.length) { if (opts.gapMs) await new Promise((r) => setTimeout(r, opts.gapMs)); const x = chunks[i++]; c.enqueue(typeof x === 'string' ? enc.encode(x) : x); }
      else if (opts.neverEnd) await new Promise(() => {});
      else c.close();
    },
    cancel() { opts.onCancel?.(); },
  });
}
const req = (body: ReadableStream<Uint8Array> | string | null, headers: Record<string, string> = {}) => new Request('http://x/', { method: 'POST', body: body as never, headers, ...(body && typeof body !== 'string' ? { duplex: 'half' } : {}) } as RequestInit);

test('a normal small body is read in full; no body is an empty string', async () => {
  assert.deepEqual(await readBodyBounded(req('{"a":"b"}')), { ok: true, text: '{"a":"b"}' });
  assert.deepEqual(await readBodyBounded(req(null)), { ok: true, text: '' });
  assert.deepEqual(await readBodyBounded(req(streamOf(['ab', 'cd', 'é']))), { ok: true, text: 'abcdé' });
});
test('exactly the limit is accepted, one byte more is refused', async () => {
  assert.ok((await readBodyBounded(req('a'.repeat(MAX_FORM_BODY_BYTES)))).ok);
  const r = await readBodyBounded(req('a'.repeat(MAX_FORM_BODY_BYTES + 1))); assert.deepEqual([r.ok, r.ok ? 0 : r.status], [false, 413]);
});
test('REGRESSION: the limit is enforced WHILE STREAMING: an oversize chunked upload is cancelled after the limit, not read to the end', async () => {
  let cancelled = false; const pulled = { n: 0 };
  const chunks = Array.from({ length: 1000 }, () => new Uint8Array(1024).fill(97)); // 1000 KiB offered, no Content-Length
  const r = await readBodyBounded(req(streamOf(chunks, { onCancel: () => { cancelled = true; }, pulled })));
  assert.deepEqual([r.ok, r.ok ? 0 : r.status, r.ok ? '' : r.reason], [false, 413, 'too_large']);
  assert.ok(pulled.n < 20, `read ${pulled.n} chunks before stopping (limit is 8)`); await new Promise((r2) => setTimeout(r2, 20)); assert.ok(cancelled, 'the stream was cancelled');
});
test('a declared Content-Length above the limit is refused without reading a byte; a malformed one is 400', async () => {
  const q0 = req(streamOf(['x'], { neverEnd: true }), { 'content-length': String(MAX_FORM_BODY_BYTES + 1) });
  const r = await readBodyBounded(q0, 8192, 5000); assert.deepEqual([r.ok, r.ok ? 0 : r.status], [false, 413]); assert.equal(q0.bodyUsed, false, 'the body was touched'); assert.equal(q0.body?.locked, false, 'a reader was attached');
  for (const bad of ['abc', '-5', 'NaN']) { const q = await readBodyBounded(req('x', { 'content-length': bad })); assert.deepEqual([q.ok, q.ok ? 0 : q.status], [false, 400], bad); }
});
test('REGRESSION: a deadline ends a stalled upload and a slow drip (408), and the stream is abandoned', async () => {
  let cancelled = false;
  const t0 = Date.now(); const stalled = await readBodyBounded(req(streamOf(['{"a"'], { neverEnd: true, onCancel: () => { cancelled = true; } })), 8192, 150);
  assert.deepEqual([stalled.ok, stalled.ok ? 0 : stalled.status, stalled.ok ? '' : stalled.reason], [false, 408, 'timeout']); assert.ok(Date.now() - t0 < 1000, 'deadline honoured'); await new Promise((r) => setTimeout(r, 20)); assert.ok(cancelled);
  const t1 = Date.now(); const drip = await readBodyBounded(req(streamOf(Array.from({ length: 50 }, () => 'x'), { gapMs: 40 })), 8192, 200);
  assert.deepEqual([drip.ok, drip.ok ? 0 : drip.status], [false, 408]); assert.ok(Date.now() - t1 < 1000, 'a drip is cut off at the deadline, not after all 50 chunks (2 s)');
});
test('granularity, stated plainly: the limit is checked per chunk the platform delivers, so a single oversize chunk is read once and then refused (a 64 KiB chunk costs 64 KiB, never more)', async () => {
  const pulled = { n: 0 }; const r = await readBodyBounded(req(streamOf([new Uint8Array(65536).fill(97), new Uint8Array(65536).fill(97), new Uint8Array(65536).fill(97)], { pulled }))); assert.deepEqual([r.ok, r.ok ? 0 : r.status], [false, 413]); assert.ok(pulled.n <= 2, `pulled ${pulled.n}`);
});
test('invalid UTF-8 is a 400, not a crash or a replacement-character decode', async () => {
  const r = await readBodyBounded(req(streamOf([new Uint8Array([0xff, 0xfe, 0x41])]))); assert.deepEqual([r.ok, r.ok ? 0 : r.status], [false, 400]);
});
test('a stream that errors is a 400', async () => {
  const s = new ReadableStream<Uint8Array>({ pull() { throw new Error('connection reset'); } });
  const r = await readBodyBounded(req(s)); assert.deepEqual([r.ok, r.ok ? 0 : r.status], [false, 400]);
});
