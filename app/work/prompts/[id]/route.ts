// GET /work/prompts/:id · PUT (update; needs the version the caller holds) · DELETE ?expected_version=N (hard delete; the result count is in the detail so the caller can warn).
// A malformed id, another member's id and a missing id all answer the same 404.
import { BODY_LIMITS, deletePrompt, getPrompt, parseExpectedVersion, parseUpdatePrompt, updatePrompt } from '@/src/modules/mywork';
import { gate, invalidRequest, readJson, reply, workDb, workRoute } from '../../_server/kit';

export const dynamic = 'force-dynamic';
type P = { id: string };

export const GET = workRoute<P>(async (_request, ctx, { id }) => {
  const refused = await gate(ctx, 'get_prompt', false); if (refused) return refused;
  return reply(ctx, 'get_prompt', await getPrompt(workDb(ctx), id));
});

export const PUT = workRoute<P>(async (request, ctx, { id }) => {
  const refused = await gate(ctx, 'update_prompt', true); if (refused) return refused;
  const body = await readJson(request, BODY_LIMITS.prompt); if (!body.ok) return body.res;
  const p = parseUpdatePrompt(body.json);
  if (!p.ok) return invalidRequest(ctx, 'update_prompt', p.fields);
  return reply(ctx, 'update_prompt', await updatePrompt(workDb(ctx), id, p.value));
});

export const DELETE = workRoute<P>(async (request, ctx, { id }) => {
  const refused = await gate(ctx, 'delete_prompt', true); if (refused) return refused;
  const v = parseExpectedVersion(new URL(request.url).searchParams.get('expected_version'));
  if (!v.ok) return invalidRequest(ctx, 'delete_prompt', v.fields);
  return reply(ctx, 'delete_prompt', await deletePrompt(workDb(ctx), id, v.value));
});
