// GET /work/results/:id · PUT (edit the member's own words; the snapshot is never touched) · DELETE ?expected_version=N.
import { BODY_LIMITS, deleteResult, getResult, parseExpectedVersion, parseUpdateResult, updateResult } from '@/src/modules/mywork';
import { gate, invalidRequest, readJson, reply, workDb, workRoute } from '../../_server/kit';

export const dynamic = 'force-dynamic';
type P = { id: string };

export const GET = workRoute<P>(async (_request, ctx, { id }) => {
  const refused = await gate(ctx, 'get_result', false); if (refused) return refused;
  return reply(ctx, 'get_result', await getResult(workDb(ctx), id));
});

export const PUT = workRoute<P>(async (request, ctx, { id }) => {
  const refused = await gate(ctx, 'update_result', true); if (refused) return refused;
  const body = await readJson(request, BODY_LIMITS.result); if (!body.ok) return body.res;
  const p = parseUpdateResult(body.json);
  if (!p.ok) return invalidRequest(ctx, 'update_result', p.fields);
  return reply(ctx, 'update_result', await updateResult(workDb(ctx), id, p.value));
});

export const DELETE = workRoute<P>(async (request, ctx, { id }) => {
  const refused = await gate(ctx, 'delete_result', true); if (refused) return refused;
  const v = parseExpectedVersion(new URL(request.url).searchParams.get('expected_version'));
  if (!v.ok) return invalidRequest(ctx, 'delete_result', v.fields);
  return reply(ctx, 'delete_result', await deleteResult(workDb(ctx), id, v.value));
});
