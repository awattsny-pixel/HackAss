// Bounded request-body reading. The limit is enforced WHILE STREAMING (bytes counted as they arrive; the read is cancelled the moment the limit is passed),
// not after the whole body was buffered, and the whole read has a DEADLINE so a client that sends nothing, or drips bytes, cannot hold the request open.
// A declared Content-Length above the limit is refused without reading anything.
export const MAX_FORM_BODY_BYTES = 8 * 1024;
export const BODY_READ_DEADLINE_MS = 3000;

export type BodyRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly status: 400 | 408 | 413; readonly reason: 'malformed' | 'timeout' | 'too_large' };

export async function readBodyBounded(request: Request, maxBytes = MAX_FORM_BODY_BYTES, deadlineMs = BODY_READ_DEADLINE_MS): Promise<BodyRead> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0) return { ok: false, status: 400, reason: 'malformed' };
    if (n > maxBytes) return { ok: false, status: 413, reason: 'too_large' };
  }
  if (!request.body) return { ok: true, text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), deadlineMs); });
  const abandon = () => { void reader.cancel().catch(() => {}); };   // never awaited: a stuck stream must not hold the response
  try {
    for (;;) {
      const r = await Promise.race([reader.read(), deadline]);
      if (r === 'timeout') { abandon(); return { ok: false, status: 408, reason: 'timeout' }; }
      if (r.done) break;
      total += r.value.byteLength;
      if (total > maxBytes) { abandon(); return { ok: false, status: 413, reason: 'too_large' }; }
      chunks.push(r.value);
    }
  } catch { return { ok: false, status: 400, reason: 'malformed' }; }
  finally { if (timer) clearTimeout(timer); }
  const all = new Uint8Array(total); let off = 0; for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  try { return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(all) }; } catch { return { ok: false, status: 400, reason: 'malformed' }; }
}
