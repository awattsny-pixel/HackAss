// GET /work/results: "My results", newest first (keyset pages), optionally one outcome. Items show the SNAPSHOT title, not the parent's current title.
import { listResults, parseListResults } from '@/src/modules/mywork';
import { gate, invalidRequest, reply, workDb, workRoute } from '../_server/kit';

export const dynamic = 'force-dynamic';

export const GET = workRoute(async (request, ctx) => {
  const refused = await gate(ctx, 'list_results', false); if (refused) return refused;
  const q = parseListResults(new URL(request.url).searchParams);
  if (!q.ok) return invalidRequest(ctx, 'list_results', q.fields);
  return reply(ctx, 'list_results', await listResults(workDb(ctx), q.value));
});
