import type { RequestId } from '../actor.ts';

export const REQUEST_ID_HEADER = 'x-request-id';
const SAFE = /^[A-Za-z0-9_-]{8,64}$/;

/** Accepts a caller-supplied id only if it is short and made of safe characters (no log injection); otherwise mints one. */
export function resolveRequestId(headers: Headers): RequestId {
  const inbound = headers.get(REQUEST_ID_HEADER);
  return (inbound && SAFE.test(inbound) ? inbound : crypto.randomUUID()) as RequestId;
}
