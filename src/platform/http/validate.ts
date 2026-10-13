// Request-body validation with Zod. Schemas for request bodies should be z.strictObject(...) so unknown (and
// especially privileged) fields are rejected rather than ignored. Failures report field paths and issue codes only,
// never submitted values.
import type { z } from 'zod';
import { AppError, type FieldIssue } from './errors.ts';

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const SAFE_PATH_SEGMENT = /[^A-Za-z0-9_.-]/g;

export function issuesToFields(issues: readonly z.core.$ZodIssue[]): FieldIssue[] {
  return issues.slice(0, 20).map((i) => ({
    path: i.path.map((p) => String(p).replace(SAFE_PATH_SEGMENT, '_').slice(0, 64)).join('.') || '(root)',
    code: i.code,
  }));
}

export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError('validation_failed', 'The request is invalid.', issuesToFields(r.error.issues));
  return r.data;
}

export async function parseJsonBody<S extends z.ZodType>(request: Request, schema: S, opts: { maxBytes?: number } = {}): Promise<z.output<S>> {
  const max = opts.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(type)) throw new AppError('unsupported_media_type', 'Content-Type must be application/json.');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new AppError('payload_too_large', 'The request body is too large.');
  const text = await readLimited(request, max);
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new AppError('validation_failed', 'The request body is not valid JSON.'); }
  return parseWith(schema, json);
}

async function readLimited(request: Request, max: number): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw new AppError('payload_too_large', 'The request body is too large.'); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(all);
}
