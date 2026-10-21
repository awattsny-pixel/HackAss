// GET /work/prompts: the member's prompts, newest edit first (keyset pages). POST /work/prompts: create a prompt (request id makes a retry safe).
import { BODY_LIMITS, createPrompt, listPrompts, parseCreatePrompt, parseListPrompts } from '@/src/modules/mywork';
import { gate, invalidRequest, readJson, reply, workDb, workRoute } from '../_server/kit';

export const dynamic = 'force-dynamic';

export const GET = workRoute(async (request, ctx) => {
  const refused = await gate(ctx, 'list_prompts', false); if (refused) return refused;
  const q = parseListPrompts(new URL(request.url).searchParams);
  if (!q.ok) return invalidRequest(ctx, 'list_prompts', q.fields);
  return reply(ctx, 'list_prompts', await listPrompts(workDb(ctx), q.value));
});

export const POST = workRoute(async (request, ctx) => {
  const refused = await gate(ctx, 'create_prompt', true); if (refused) return refused;
  const body = await readJson(request, BODY_LIMITS.prompt); if (!body.ok) return body.res;
  const p = parseCreatePrompt(body.json);
  if (!p.ok) return invalidRequest(ctx, 'create_prompt', p.fields);
  const r = await createPrompt(workDb(ctx), p.value);
  return reply(ctx, 'create_prompt', r, r.ok && r.data.replay ? 200 : 201);
});
