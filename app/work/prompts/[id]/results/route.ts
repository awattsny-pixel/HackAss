// POST /work/prompts/:id/results: save a result for a prompt. The caller states the prompt VERSION it tried; a stale version is a 409, so a result can never
// describe text the member did not try. The result keeps its own snapshot of what was tried.
import { BODY_LIMITS, parseSaveResult, saveResult } from '@/src/modules/mywork';
import { gate, invalidRequest, readJson, reply, workDb, workRoute } from '../../../_server/kit';

export const dynamic = 'force-dynamic';

export const POST = workRoute<{ id: string }>(async (request, ctx, { id }) => {
  const refused = await gate(ctx, 'save_result', true); if (refused) return refused;
  const body = await readJson(request, BODY_LIMITS.result); if (!body.ok) return body.res;
  const p = parseSaveResult(body.json);
  if (!p.ok) return invalidRequest(ctx, 'save_result', p.fields);
  const r = await saveResult(workDb(ctx), id, p.value);
  return reply(ctx, 'save_result', r, r.ok && r.data.replay ? 200 : 201);
});
