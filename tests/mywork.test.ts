// PX-3b: the mywork module (strict parsing, failure mapping, allowlisted responses, the replay/superseded contract) and the write throttle.
// Live behaviour against the real database and Auth is in scripts/px3b-local-checks.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryCounterStore } from '../src/modules/identity/index.ts';
import {
  classifyWorkFailure, createPrompt, deletePrompt, exportMyData, failureResponse, getPrompt, listPrompts, parseCreatePrompt, parseExpectedVersion, parseExport, parseListPrompts, parseListResults,
  parseSaveBoth, parseSaveResult, parseUpdatePrompt, parseUpdateResult, savePromptAndResult, saveResult, updateResult, updatePrompt, getResult, deleteResult, listResults, type WorkRpc,
} from '../src/modules/mywork/index.ts';
import { createWriteThrottle, WRITE_RULES } from '../app/work/_server/throttle.ts';

const UUID = '3f2a6b1c-8d4e-4f60-9a7b-1c2d3e4f5a6b', UUID2 = '4a3b7c2d-9e5f-4071-8b8c-2d3e4f5a6b7c';
const prompt = { title: 'My prompt', output_format: 'Concise summary', full_prompt: 'do it', origin_kind: 'scratch' };
const result = { outcome: 'partial', reflection: 'half', next_change: 'more' };
const NOW = '2026-10-20T12:00:00.123456+00:00';

/** A recording fake of the only capability the module has. */
function fake(answer: { data?: unknown; error?: { code?: string; message?: string; details?: string } | null; status?: number } | (() => never)) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: WorkRpc = { rpc: async (fn, args) => { calls.push({ fn, args }); if (typeof answer === 'function') answer(); return { data: (answer as { data?: unknown }).data ?? null, error: (answer as { error?: null }).error ?? null, status: (answer as { status?: number }).status }; } };
  return { db, calls };
}

test('request bodies are strict: unknown keys (including any owner) are refused, and problems name the field only', () => {
  assert.equal(parseCreatePrompt({ request_id: UUID, prompt }).ok, true);
  for (const bad of [{ request_id: UUID, prompt, owner_id: UUID2 }, { request_id: UUID, prompt: { ...prompt, owner_id: UUID2 } }, { request_id: UUID, prompt: { ...prompt, user_id: UUID2 } }, { request_id: UUID, prompt: { ...prompt, id: UUID } }, { prompt }, { request_id: 'nope', prompt }]) assert.equal(parseCreatePrompt(bad).ok, false, JSON.stringify(bad).slice(0, 60));
  const r = parseCreatePrompt({ request_id: UUID, prompt: { ...prompt, title: 'SECRET-TITLE-VALUE', owner_id: 'SECRET-OWNER-VALUE' } });
  assert.equal(r.ok, false);
  assert.doesNotMatch(JSON.stringify(r), /SECRET/, 'a refused request never echoes a submitted value');
  assert.equal(parseCreatePrompt(null).ok, false); assert.equal(parseCreatePrompt([]).ok, false); assert.equal(parseCreatePrompt('x').ok, false);
});
test('prompt fields: length limits, the output-format allowlist, and origin rules', () => {
  const ok = (p: object) => parseCreatePrompt({ request_id: UUID, prompt: { ...prompt, ...p } }).ok;
  assert.equal(ok({}), true);
  assert.equal(ok({ title: 'x'.repeat(121) }), false); assert.equal(ok({ title: '' }), false); assert.equal(ok({ title: '   ' }), false);
  assert.equal(ok({ output_format: 'Free text' }), false, 'a format outside the allowlist');
  for (const f of ['Clear step-by-step plan', 'Comparison table', 'Creative draft', 'Concise summary']) assert.equal(ok({ output_format: f }), true, f);
  assert.equal(ok({ full_prompt: 'x'.repeat(20001) }), false); assert.equal(ok({ full_prompt: '' }), false); assert.equal(ok({ goal: 'x'.repeat(2001) }), false); assert.equal(ok({ context: 'x'.repeat(4001) }), false);
  assert.equal(ok({ origin_kind: 'catalog' }), false, 'catalog origin needs a slug'); assert.equal(ok({ origin_kind: 'catalog', origin_slug: 'good-slug' }), true);
  assert.equal(ok({ origin_kind: 'scratch', origin_slug: 'good-slug' }), false, 'a slug only belongs to a catalog origin'); assert.equal(ok({ origin_kind: 'catalog', origin_slug: '../x' }), false);
  assert.equal(ok({ origin_kind: 'demo', origin_title: 'Pantry meal' }), true, 'demo-origin prompts are allowed with attribution'); assert.equal(ok({ origin_kind: 'other' }), false);
});
test('versions, results and the combined save', () => {
  assert.equal(parseUpdatePrompt({ request_id: UUID, expected_version: 1, prompt }).ok, true);
  for (const v of [0, -1, 1.5, '1', null, 2 ** 31]) assert.equal(parseUpdatePrompt({ request_id: UUID, expected_version: v, prompt }).ok, false, String(v));
  assert.equal(parseUpdatePrompt({ request_id: UUID, prompt }).ok, false, 'an update must state the version it holds');
  assert.equal(parseSaveResult({ request_id: UUID, expected_prompt_version: 3, result }).ok, true);
  assert.equal(parseSaveResult({ request_id: UUID, result }).ok, false, 'a result must state the prompt version that was tried');
  assert.equal(parseSaveResult({ request_id: UUID, expected_prompt_version: 1, result: { ...result, outcome: 'maybe' } }).ok, false);
  assert.equal(parseSaveResult({ request_id: UUID, expected_prompt_version: 1, result: { ...result, prompt_title: 'forged snapshot' } }).ok, false, 'snapshot fields cannot be supplied');
  assert.equal(parseSaveResult({ request_id: UUID, expected_prompt_version: 1, result: { ...result, reflection: 'x'.repeat(4001) } }).ok, false);
  assert.equal(parseUpdateResult({ expected_version: 2, result }).ok, true); assert.equal(parseUpdateResult({ result }).ok, false);
  assert.equal(parseSaveBoth({ request_id: UUID, prompt, result }).ok, true, 'create both');
  assert.equal(parseSaveBoth({ request_id: UUID, prompt, result, prompt_id: UUID2, expected_prompt_version: 2 }).ok, true, 'update the prompt and add the result');
  assert.equal(parseSaveBoth({ request_id: UUID, prompt, result, prompt_id: UUID2 }).ok, false, 'an id without its version');
  assert.equal(parseSaveBoth({ request_id: UUID, prompt, result, expected_prompt_version: 2 }).ok, false, 'a version without its id');
  assert.equal(parseExpectedVersion('3').ok, true); for (const v of [null, '', '0', '-1', '1.5', 'abc', '12345678901', '1e3']) assert.equal(parseExpectedVersion(v).ok, false, String(v));
});
test('list and export queries are bounded', () => {
  const q = (s: string) => new URLSearchParams(s);
  assert.deepEqual(parseListPrompts(q('')), { ok: true, value: { limit: 25, after: null } });
  assert.equal(parseListPrompts(q('limit=0')).ok, false); assert.equal(parseListPrompts(q('limit=101')).ok, false); assert.equal(parseListPrompts(q('limit=abc')).ok, false); assert.equal(parseListPrompts(q('limit=100')).ok, true);
  assert.equal(parseListPrompts(q(`after_id=${UUID}`)).ok, false, 'a cursor needs both parts'); assert.equal(parseListPrompts(q(`after_id=${UUID}&after_updated_at=${encodeURIComponent(NOW)}`)).ok, true);
  assert.equal(parseListPrompts(q('after_id=x&after_updated_at=y')).ok, false);
  assert.equal(parseListResults(q('outcome=yes')).ok, true); assert.equal(parseListResults(q('outcome=maybe')).ok, false);
  assert.equal(parseExport(q('kind=summary')).ok, true); assert.equal(parseExport(q('kind=prompts&limit=50')).ok, true); assert.equal(parseExport(q('kind=prompts&limit=51')).ok, false);
  assert.equal(parseExport(q('kind=everything')).ok, false); assert.equal(parseExport(q('')).ok, false); assert.equal(parseExport(q('kind=results&after_id=bad')).ok, false);
});

test('database errors map to fixed kinds; no database text, request value or id survives', () => {
  const k = (code: string, message = '', details?: string, status?: number) => classifyWorkFailure({ code, message, ...(details ? { details } : {}) }, status);
  assert.deepEqual(k('PT404', 'not_found'), { ok: false, kind: 'not_found' });
  assert.deepEqual(k('PT409', 'version_conflict', 'saved_prompts'), { ok: false, kind: 'version_conflict' });
  assert.deepEqual(k('PT409', 'request_reuse', 'p_request_id'), { ok: false, kind: 'request_reuse' });
  assert.deepEqual(k('PT429', 'quota_exceeded', 'saved_prompts'), { ok: false, kind: 'quota_exceeded' });
  assert.deepEqual(k('PT422', 'invalid_content', 'title'), { ok: false, kind: 'invalid_content', field: 'title' });
  assert.deepEqual(k('PT422', 'invalid_content', '(root).owner_id'), { ok: false, kind: 'invalid_content', field: '(root).owner_id' });
  assert.deepEqual(k('PT422', 'invalid_content', 'secret text with spaces, a value!'), { ok: false, kind: 'invalid_content' }, 'a detail that is not a plain field name is dropped');
  assert.deepEqual(k('28000', 'session_invalid'), { ok: false, kind: 'unauthenticated' });
  assert.deepEqual(k('42501', 'permission denied'), { ok: false, kind: 'denied' });
  assert.deepEqual(classifyWorkFailure(null, 401), { ok: false, kind: 'unauthenticated' });
  assert.deepEqual(k('XX000', 'relation "app.saved_prompts" does not exist'), { ok: false, kind: 'unavailable' });
  assert.deepEqual(k('', '', undefined, 500), { ok: false, kind: 'unavailable' });
  for (const kind of ['unauthenticated', 'denied', 'not_found', 'version_conflict', 'request_reuse', 'invalid_content', 'quota_exceeded', 'unavailable', 'invalid_response'] as const) {
    const r = failureResponse(kind); assert.ok(r.status >= 400 && r.message.length > 5, kind); assert.doesNotMatch(r.message, /saved_|app\.|api\.|postgres|sql|PT\d/i, kind);
  }
});

test('availability takes precedence: transport failures and HTTP 5xx/408 are retryable unavailable whatever database code or text came with them', () => {
  const U = { ok: false, kind: 'unavailable' };
  for (const [code, status] of [['28000', 503], ['42501', 503], ['PT404', 503], ['PT409', 502], ['PT422', 500], ['PT429', 504], ['28000', 500], ['PGRST301', 503], ['42501', 408], ['PT404', 0], ['28000', 0]] as const)
    assert.deepEqual(classifyWorkFailure({ code, message: 'not_found' }, status), U, `${code} with HTTP ${status}`);
  assert.deepEqual(classifyWorkFailure({ message: 'TypeError: fetch failed' }, 0), U, 'transport failure');
  assert.deepEqual(classifyWorkFailure({ code: '', message: 'boom' }), U, 'no status, no code');
  // verdicts are still believed on a 4xx answer from the database
  assert.deepEqual(classifyWorkFailure({ code: 'PT404', message: 'not_found' }, 404), { ok: false, kind: 'not_found' });
  assert.deepEqual(classifyWorkFailure({ code: 'PT409', message: 'version_conflict' }, 409), { ok: false, kind: 'version_conflict' });
  assert.deepEqual(classifyWorkFailure({ code: '42501', message: 'x' }, 403), { ok: false, kind: 'denied' });
  assert.deepEqual(classifyWorkFailure({ code: '28000', message: 'x' }, 401), { ok: false, kind: 'unauthenticated' });
});
test('the receipt contract keeps replay and superseded, so a stale acknowledgment can be reconciled', async () => {
  const receipt = { id: UUID, version: 1, updated_at: NOW, replay: true, superseded: true };
  const f = fake({ data: receipt });
  const r = await createPrompt(f.db, { requestId: UUID2, doc: parseCreatePrompt({ request_id: UUID2, prompt }).ok ? (parseCreatePrompt({ request_id: UUID2, prompt }) as { value: { doc: never } }).value.doc : (null as never) });
  assert.ok(r.ok && r.data.version === 1 && r.data.replay === true && r.data.superseded === true);
  const both = await savePromptAndResult(fake({ data: { prompt: { id: UUID, version: 4, updated_at: NOW }, result: { id: UUID2, version: 1, created_at: NOW }, replay: true, superseded: true } }).db,
    (parseSaveBoth({ request_id: UUID, prompt, result }) as { value: never }).value);
  assert.ok(both.ok && both.data.prompt.version === 4 && both.data.replay === true && both.data.superseded === true);
  const rr = await saveResult(fake({ data: { id: UUID, version: 1, created_at: NOW, prompt_version: 2, replay: true, superseded: true } }).db, UUID2, (parseSaveResult({ request_id: UUID, expected_prompt_version: 2, result }) as { value: never }).value);
  assert.ok(rr.ok && rr.data.replay === true && rr.data.superseded === true && rr.data.prompt_version === 2);
  const first = await createPrompt(fake({ data: { id: UUID, version: 1, updated_at: NOW } }).db, (parseCreatePrompt({ request_id: UUID, prompt }) as { value: never }).value);
  assert.ok(first.ok && first.data.replay === undefined, 'a first-time answer carries no replay flag');
});

test('responses are parsed against allowlists: unknown fields are dropped, malformed answers are invalid_response, outages are unavailable', async () => {
  const r = await createPrompt(fake({ data: { id: UUID, version: 1, updated_at: NOW, owner_id: UUID2, request_hash: 'abc' } }).db, (parseCreatePrompt({ request_id: UUID, prompt }) as { value: never }).value);
  assert.ok(r.ok); assert.deepEqual(Object.keys(r.data).sort(), ['id', 'updated_at', 'version']);
  for (const data of [null, 'x', [], { id: 'not-a-uuid', version: 1, updated_at: NOW }, { id: UUID, version: 0, updated_at: NOW }, { id: UUID, version: 1 }]) assert.deepEqual(await getPrompt(fake({ data }).db, UUID), { ok: false, kind: 'invalid_response' }, JSON.stringify(data));
  assert.deepEqual(await getPrompt(fake(() => { throw new Error('network down with secret text'); }).db, UUID), { ok: false, kind: 'unavailable' });
  const detail = { id: UUID, version: 2, title: 't', goal: '', context: '', output_format: 'Concise summary', full_prompt: 'p', starting_prompt: '', origin_kind: 'scratch', origin_slug: null, origin_title: null, created_at: NOW, updated_at: NOW, result_count: 3, owner_id: UUID2 };
  const d = await getPrompt(fake({ data: detail }).db, UUID); assert.ok(d.ok && d.data.result_count === 3 && !('owner_id' in d.data));
  const ex = await exportMyData(fake({ data: { kind: 'summary', exported_at: NOW, prompts: 2, results: 5 } }).db, { kind: 'summary', after: null, limit: 25 }); assert.ok(ex.ok && ex.data.kind === 'summary');
  const page = (kind: string) => ({ kind, items: [], page_size: 25, next_after_id: null });
  for (const [asked, got] of [['results', 'prompts'], ['prompts', 'results'], ['prompts', 'summary'], ['summary', 'prompts'], ['results', 'summary']] as const) {
    const data = got === 'summary' ? { kind: 'summary', exported_at: NOW, prompts: 1, results: 1 } : page(got);
    assert.deepEqual(await exportMyData(fake({ data }).db, { kind: asked, after: null, limit: 25 }), { ok: false, kind: 'invalid_response' }, `asked ${asked}, got ${got}`);
  }
  for (const k of ['prompts', 'results'] as const) assert.equal((await exportMyData(fake({ data: page(k) }).db, { kind: k, after: null, limit: 25 })).ok, true, `${k} matches`);
});

test('a malformed id never reaches the database and answers exactly like a missing one', async () => {
  const f = fake({ data: {} });
  const nf = { ok: false, kind: 'not_found' };
  const one = (await getPrompt(f.db, 'not-an-id')); assert.deepEqual(one, nf);
  assert.deepEqual(await deletePrompt(f.db, '../../etc', 1), nf); assert.deepEqual(await getResult(f.db, ''), nf); assert.deepEqual(await deleteResult(f.db, 'x', 1), nf);
  assert.deepEqual(await updateResult(f.db, 'x', { expectedVersion: 1, doc: (parseUpdateResult({ expected_version: 1, result }) as { value: { doc: never } }).value.doc }), nf);
  assert.deepEqual(await updatePrompt(f.db, 'x', (parseUpdatePrompt({ request_id: UUID, expected_version: 1, prompt }) as { value: never }).value), nf);
  assert.deepEqual(await saveResult(f.db, 'x', (parseSaveResult({ request_id: UUID, expected_prompt_version: 1, result }) as { value: never }).value), nf);
  assert.equal(f.calls.length, 0, 'no database call for any malformed id');
});

test('arguments sent to the database: no owner anywhere, optional parts become null, undefined keys are not sent', async () => {
  const f = fake({ data: { items: [], page_size: 25, next_cursor: null } });
  await listPrompts(f.db, { limit: 25, after: null }); await listResults(f.db, { limit: 10, outcome: 'yes', after: null });
  assert.deepEqual(f.calls[0], { fn: 'list_my_prompts', args: { p_limit: 25, p_after_updated_at: null, p_after_id: null } });
  assert.deepEqual(f.calls[1], { fn: 'list_my_results', args: { p_limit: 10, p_outcome: 'yes', p_after_created_at: null, p_after_id: null } });
  const g = fake({ data: { id: UUID, version: 1, updated_at: NOW } });
  await createPrompt(g.db, (parseCreatePrompt({ request_id: UUID, prompt }) as { value: never }).value);
  const sent = g.calls[0].args.p_doc as Record<string, unknown>;
  assert.ok(!('origin_slug' in sent) && !('origin_title' in sent), 'absent optionals are omitted'); assert.deepEqual(Object.keys(g.calls[0].args).sort(), ['p_doc', 'p_request_id']);
  for (const c of [...f.calls, ...g.calls]) assert.ok(!Object.keys(c.args).some((k) => /owner|user/.test(k)), c.fn);
});

test('the module source: pure (no environment, database client, Node built-in or server-only marker), eleven functions only', () => {
  const src = readFileSync(new URL('../src/modules/mywork/index.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /process\.env|node:|server-only|@supabase|from '\.\.|from '@\/src\/(?!platform)/);
  const fns = [...src.matchAll(/'(save_prompt|get_my_prompt|list_my_prompts|delete_my_prompt|save_reflection|save_prompt_and_result|update_my_reflection|delete_my_reflection|list_my_results|get_my_result|export_my_data)'/g)].map((m) => m[1]);
  assert.equal(new Set(fns).size, 11);
});

// ---- write throttle ---------------------------------------------------------------------------------------------------------------------------------
const SECRET = 'x'.repeat(40);
test('write throttle: per member, per address, global; counted together; fails closed', async () => {
  let t = 1_000_000; const now = () => t;
  const th = createWriteThrottle({ secret: SECRET, store: createMemoryCounterStore(), now });
  const me = { userId: UUID, ip: '198.51.100.1' };
  for (let i = 0; i < WRITE_RULES.member.max; i++) assert.equal((await th.check(me)).allowed, true, `write ${i + 1}`);
  const over = await th.check(me); assert.equal(over.allowed, false); assert.ok(!over.allowed && over.retryAfterSec >= 1 && over.retryAfterSec <= 300);
  assert.equal((await th.check({ userId: UUID2, ip: '198.51.100.2' })).allowed, true, 'another member on another address is unaffected');
  t += WRITE_RULES.member.windowMs + 1; assert.equal((await th.check(me)).allowed, true, 'the window ends');
  const ipOnly = createWriteThrottle({ secret: SECRET, store: createMemoryCounterStore(), now });
  let denied = 0; for (let i = 0; i < WRITE_RULES.ip.max + 5; i++) if (!(await ipOnly.check({ userId: `${i}`.padStart(8, '0') + UUID.slice(8), ip: '203.0.113.9' })).allowed) denied++;
  assert.equal(denied, 5, 'many members behind one address share the address rule');
  const unknown = createWriteThrottle({ secret: SECRET, store: createMemoryCounterStore(), now });
  for (let i = 0; i < WRITE_RULES.ip.max; i++) await unknown.check({ userId: UUID, ip: null }); assert.equal((await unknown.check({ userId: UUID2, ip: null })).allowed, false, 'no trusted address: one shared bucket, never looser');
  const broken = createWriteThrottle({ secret: SECRET, store: { hit: async () => { throw new Error('store down'); } }, now });
  assert.equal((await broken.check(me)).allowed, false, 'a failing store denies');
  const full = createWriteThrottle({ secret: SECRET, store: createMemoryCounterStore({ maxKeys: 2 }), now });
  await full.check(me); assert.equal((await full.check({ userId: UUID2, ip: '198.51.100.7' })).allowed, false, 'a full store denies new keys');
  assert.throws(() => createWriteThrottle({ secret: 'short', store: createMemoryCounterStore() }));
});
