// The standard wrapper for route handlers: assigns/echoes a request id, applies the origin check to mutations,
// maps every failure to the safe error response, logs without leaking, and defaults responses to no-store.
import 'server-only'; // Next.js fails the build if a Client Component ever imports this module
import type { RequestId } from '../actor.ts';
import { createLogger, consoleSink, withRequestId, type Logger, type LogSink } from '../log.ts';
import { assertSameOrigin } from './origin.ts';
import { isAppError, toErrorResponse } from './errors.ts';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id.ts';

export interface RequestContext { readonly requestId: RequestId; readonly log: Logger }
export interface HandlerOptions { appOrigin: string; sink?: LogSink }

export function withRequestContext(
  handler: (request: Request, ctx: RequestContext) => Promise<Response> | Response,
  options: HandlerOptions,
): (request: Request) => Promise<Response> {
  const root = createLogger(options.sink ?? consoleSink);
  return async (request) => {
    const requestId = resolveRequestId(request.headers);
    const log = withRequestId(root, requestId);
    try {
      assertSameOrigin(request, options.appOrigin);
      const response = await handler(request, { requestId, log });
      const headers = new Headers(response.headers);
      headers.set(REQUEST_ID_HEADER, requestId);
      if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (err) {
      if (isAppError(err)) log.info('request_rejected', { code: err.code });
      else log.error('request_failed', { error: err });
      return toErrorResponse(err, requestId);
    }
  };
}
