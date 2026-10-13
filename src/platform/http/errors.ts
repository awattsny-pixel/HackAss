// Application errors and their safe public form. Anything that is not an AppError is an unexpected failure and is
// reported as a generic 500: no message, no stack, no database detail ever reaches the response.
import type { RequestId } from '../actor.ts';

export type ErrorCode = 'validation_failed' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' | 'payload_too_large' | 'unsupported_media_type' | 'internal';

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 400, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409,
  rate_limited: 429, payload_too_large: 413, unsupported_media_type: 415, internal: 500,
};

export interface FieldIssue { path: string; code: string }

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields: readonly FieldIssue[];
  constructor(code: ErrorCode, publicMessage: string, fields: readonly FieldIssue[] = []) {
    super(publicMessage);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.fields = fields;
  }
}
export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

export interface ErrorBody { error: { code: ErrorCode; message: string; fields?: readonly FieldIssue[] }; requestId: string }

/**
 * The only place an error becomes a response. Unknown errors, and any error that maps to a 5xx status (including an
 * AppError created with code 'internal'), are ALWAYS the fixed generic body: their message and field details are
 * never sent, because a server-side failure's text can carry internals.
 */
export function toErrorResponse(err: unknown, requestId: RequestId): Response {
  const app = isAppError(err) && err.status < 500 ? err : null;
  const body: ErrorBody = app
    ? { error: { code: app.code, message: app.message, ...(app.fields.length ? { fields: app.fields } : {}) }, requestId }
    : { error: { code: 'internal', message: 'Internal server error' }, requestId };
  return new Response(JSON.stringify(body), {
    status: app ? app.status : 500, // never an AppError's own 5xx status: always exactly 500
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId },
  });
}
