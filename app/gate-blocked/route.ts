// The one answer for every path the private preview does not serve (next.config.js rewrites them here; see src/platform/preview-gate.ts). Any method, one uniform body,
// no detail about what exists. In an open (local development) build nothing rewrites here and a direct request simply gets the same 404.
const refuse = (): Response => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
export const GET = refuse, HEAD = refuse, POST = refuse, PUT = refuse, PATCH = refuse, DELETE = refuse, OPTIONS = refuse;
export const dynamic = 'force-dynamic';
