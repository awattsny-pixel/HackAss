// HTTP to the target API only: the URL is the validated one, every call has a deadline, secrets are set as headers in code (never in an argument or URL), and
// responses are returned parsed and never logged here. No retries.
import { assertContext } from './context.mjs';

export class HttpFailure extends Error { constructor(message, detail = {}) { super(message); Object.assign(this, detail); } }

export async function request(ctx, { method = 'GET', path, token, apikey, body, headers = {}, timeoutMs = 20_000 }) {
  assertContext(ctx);
  if (!path.startsWith('/')) throw new Error('path must start with /');
  const key = apikey ?? ctx.keys.publishable;
  const h = { apikey: key, ...headers };
  const bearer = token ?? (typeof key === 'string' && key.startsWith('eyJ') ? key : null); // new-style sb_ keys are sent in apikey only
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(ctx.targets.url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new HttpFailure(`${method} ${path} exceeded ${timeoutMs}ms`, { timedOut: true });
    throw new HttpFailure(`${method} ${path} failed: ${e?.cause?.code ?? e?.name ?? 'error'}`);
  }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text: json === null ? text.slice(0, 2000) : null };
}
/** PostgREST function call in schema `api` (or another profile), as a user (token) or anonymously. */
export const rpc = (ctx, name, token, args = {}, { schema = 'api', apikey, timeoutMs } = {}) =>
  request(ctx, { method: 'POST', path: `/rest/v1/rpc/${name}`, token, apikey, body: args, headers: { 'content-profile': schema, 'accept-profile': schema }, timeoutMs });
