// GET /work/export?kind=summary|prompts|results[&after_id=…&limit=…]: the member's own data, in pages of at most 50 rows (no owner id, no request internals).
// A read, so it is T2 and not write-throttled; it is bounded by the page size.
import { exportMyData, parseExport } from '@/src/modules/mywork';
import { gate, invalidRequest, reply, workDb, workRoute } from '../_server/kit';

export const dynamic = 'force-dynamic';

export const GET = workRoute(async (request, ctx) => {
  const refused = await gate(ctx, 'export', false); if (refused) return refused;
  const q = parseExport(new URL(request.url).searchParams);
  if (!q.ok) return invalidRequest(ctx, 'export', q.fields);
  return reply(ctx, 'export', await exportMyData(workDb(ctx), q.value));
});
