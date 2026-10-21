// POST /work/saves: save a prompt AND a result as ONE operation (one database transaction: both are stored or neither). With `prompt_id` and
// `expected_prompt_version` it updates that prompt; without them it creates one.
import { BODY_LIMITS, parseSaveBoth, savePromptAndResult } from '@/src/modules/mywork';
import { gate, invalidRequest, readJson, reply, workDb, workRoute } from '../_server/kit';

export const dynamic = 'force-dynamic';

export const POST = workRoute(async (request, ctx) => {
  const refused = await gate(ctx, 'save_both', true); if (refused) return refused;
  const body = await readJson(request, BODY_LIMITS.both); if (!body.ok) return body.res;
  const p = parseSaveBoth(body.json);
  if (!p.ok) return invalidRequest(ctx, 'save_both', p.fields);
  const r = await savePromptAndResult(workDb(ctx), p.value);
  return reply(ctx, 'save_both', r, r.ok && r.data.replay ? 200 : 201);
});
