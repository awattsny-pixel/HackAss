// PX-3c: the save journey as pure logic with delayed, lost and out-of-order responses (like the session-race tests). The browser journeys are in scripts/px3c-browser-checks.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, promptSaveView, reduce, resultSaveView, type Action, type ExperienceState } from '../src/ui/experience/state.ts';
import type { ExperienceHack } from '../src/ui/experience/types.ts';
import { createWorkController } from '../src/ui/work/controller.ts';
import type { ApiResult, WorkApi } from '../src/ui/work/api.ts';
import { buildPromptDoc, buildResultDoc, promptMatches } from '../src/ui/work/doc.ts';
import type { PromptDetail, ResultDetail } from '../src/modules/mywork/index.ts';

const NOW = '2026-10-20T12:00:00.000000+00:00';
const hack: ExperienceHack = { source: 'catalog', key: 'meal-plan', title: 'Meal plan', summary: 's', category: 'Home', goal: 'g', context: 'c', format: 'Concise summary', starterPrompt: 'starter', href: '/spark/catalog/meal-plan' };
const ok = <T,>(data: T, status = 200): ApiResult<T> => ({ ok: true, data, status });
const bad = (kind: string, extra: object = {}): ApiResult<never> => ({ ok: false, kind, status: 0, ...extra } as never);
const detail = (o: Partial<PromptDetail> = {}): PromptDetail => ({ id: 'p1', version: 1, title: 'T', goal: 'g', context: 'c', output_format: 'Concise summary', full_prompt: 'one', starting_prompt: 'starter', origin_kind: 'catalog', origin_slug: 'meal-plan', origin_title: 'Meal plan', created_at: NOW, updated_at: NOW, result_count: 0, ...o });
const rdetail = (o: Partial<ResultDetail> = {}): ResultDetail => ({ id: 'r1', version: 1, outcome: 'yes', reflection: 'words', next_change: 'next', attempted_prompt: 'one', starting_prompt: 'starter', title: 'T', prompt_version: 1, prompt_id: 'p1', origin_kind: 'scratch', origin_slug: null, origin_title: null, created_at: NOW, updated_at: NOW, ...o });

/** A deferred promise so a test decides WHEN a response arrives. */
function defer<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

function rig(over: Partial<WorkApi> = {}) {
  const store = { s: reduce(initialState, { type: 'startFromHack', hack }) as ExperienceState };
  store.s = reduce(store.s, { type: 'editField', field: 'title', value: 'T' }); // a title, so the draft can be saved
  const dispatch = (a: Action) => { store.s = reduce(store.s, a); };
  const calls: { fn: string; args: unknown[] }[] = [];
  const rec = <K extends keyof WorkApi>(fn: K, impl: WorkApi[K]): WorkApi[K] => ((...args: unknown[]) => { calls.push({ fn, args }); return (impl as (...a: unknown[]) => unknown)(...args); }) as WorkApi[K];
  const unexpected = (n: string) => () => { throw new Error(`unexpected api call ${n}`); };
  const api: WorkApi = {
    createPrompt: rec('createPrompt', unexpected('createPrompt') as never), updatePrompt: rec('updatePrompt', unexpected('updatePrompt') as never), getPrompt: rec('getPrompt', unexpected('getPrompt') as never),
    listPrompts: unexpected('listPrompts') as never, deletePrompt: unexpected('deletePrompt') as never, saveResult: rec('saveResult', unexpected('saveResult') as never), saveBoth: rec('saveBoth', unexpected('saveBoth') as never),
    updateResult: rec('updateResult', unexpected('updateResult') as never), getResult: rec('getResult', unexpected('getResult') as never), listResults: unexpected('listResults') as never, deleteResult: unexpected('deleteResult') as never, exportPage: unexpected('exportPage') as never,
  };
  Object.assign(api, Object.fromEntries(Object.entries(over).map(([k, v]) => [k, rec(k as keyof WorkApi, v as never)])));
  let n = 0; const ctl = createWorkController({ api, getState: () => store.s, dispatch, newId: () => `req-${++n}`, now: () => 1_000 });
  const edit = (value: string) => dispatch({ type: 'editPrompt', value });
  return { store, ctl, calls, dispatch, edit };
}
const receipt = (version: number, extra: object = {}) => ok({ id: 'p1', version, updated_at: NOW, ...extra });

test('TYPING DURING A SAVE: the response marks only the submitted revision; the draft stays "changed since last save" and the leave-page warning stays on', async () => {
  const d = defer<ApiResult<never>>(); const r = rig({ createPrompt: (() => d.promise) as never });
  r.edit('first text'); const submitted = r.store.s.work.revision;
  const saving = r.ctl.savePrompt();
  assert.equal(promptSaveView(r.store.s), 'saving'); assert.equal(r.store.s.work.inFlight?.revision, submitted);
  r.edit('first text, and more typed while saving'); // typing continues during the request
  d.resolve(receipt(1) as never); await saving;
  assert.equal(r.store.s.work.saved?.version, 1); assert.equal(r.store.s.work.savedRevision, submitted);
  assert.equal(promptSaveView(r.store.s), 'changed', 'newer than what was saved'); assert.equal(r.store.s.dirty, true, 'the leave-page warning stays on');
  assert.equal(r.store.s.fullPrompt, 'first text, and more typed while saving', 'the draft is untouched by the response');
});
test('a save with no typing in between marks the draft saved and clears the warning', async () => {
  const r = rig({ createPrompt: (async () => receipt(1)) as never }); r.edit('x');
  assert.equal(r.store.s.dirty, true); await r.ctl.savePrompt();
  assert.equal(promptSaveView(r.store.s), 'saved'); assert.equal(r.store.s.dirty, false);
});
test('only one save is in flight; a second request is refused as busy and sends nothing', async () => {
  const d = defer<ApiResult<never>>(); const r = rig({ createPrompt: (() => d.promise) as never }); r.edit('x');
  const first = r.ctl.savePrompt(); const second = await r.ctl.savePrompt();
  assert.equal(second, 'busy'); assert.equal(r.calls.filter((c) => c.fn === 'createPrompt').length, 1);
  d.resolve(receipt(1) as never); await first;
});
test('out-of-order and foreign responses are ignored (a saveDone that is not for the save in flight changes nothing)', async () => {
  const d = defer<ApiResult<never>>(); const r = rig({ createPrompt: (() => d.promise) as never }); r.edit('x');
  const saving = r.ctl.savePrompt(); const before = r.store.s;
  r.dispatch({ type: 'saveDone', requestId: 'some-older-save', epoch: r.store.s.work.epoch, prompt: { id: 'zzz', version: 9, at: 1 } });
  assert.equal(r.store.s, before, 'ignored'); assert.equal(r.store.s.work.saved, null);
  d.resolve(receipt(1) as never); await saving; r.dispatch({ type: 'saveDone', requestId: 'req-1', epoch: r.store.s.work.epoch, prompt: { id: 'p1', version: 1, at: 2 } });
  assert.equal(r.store.s.work.saved?.version, 1, 'a duplicate of an already applied response does nothing');
});
test('a response for a draft that was replaced meanwhile is ignored (no saved link to a prompt the member left)', async () => {
  const d = defer<ApiResult<never>>(); const r = rig({ createPrompt: (() => d.promise) as never }); r.edit('x');
  const saving = r.ctl.savePrompt(); r.dispatch({ type: 'startBlank' });
  d.resolve(receipt(1) as never); await saving;
  assert.equal(r.store.s.work.saved, null); assert.equal(r.store.s.work.inFlight, null);
});
test('FAILURE keeps the draft and everything unsaved; the retry reuses the request id while the content is unchanged, and a new one once it changed', async () => {
  let attempt = 0; const ids: string[] = [];
  const r = rig({ createPrompt: (async (req: { request_id: string }) => { ids.push(req.request_id); return ++attempt < 3 ? bad('network') : receipt(1); }) as never }); r.edit('draft');
  await r.ctl.savePrompt(); assert.equal(promptSaveView(r.store.s), 'failed'); assert.equal(r.store.s.work.problem?.kind, 'unavailable'); assert.equal(r.store.s.fullPrompt, 'draft'); assert.equal(r.store.s.dirty, true); assert.equal(r.store.s.work.saved, null);
  await r.ctl.savePrompt(); assert.equal(ids[1], ids[0], 'retry of unchanged content: same request id');
  r.edit('draft, changed'); await r.ctl.savePrompt(); assert.notEqual(ids[2], ids[0], 'changed content: a new request id'); assert.equal(promptSaveView(r.store.s), 'saved');
});
test('failure kinds map to a calm problem and never alter the draft: sign-in, quota, rate limit, invalid, too large', async () => {
  for (const [f, kind] of [[bad('unauthenticated'), 'signin'], [bad('quota'), 'quota'], [bad('rate_limited', { retryAfterSec: 40 }), 'rate_limited'], [bad('invalid', { field: 'title' }), 'invalid'], [bad('too_large'), 'too_large'], [bad('unavailable'), 'unavailable'], [bad('setup_required'), 'setup']] as const) {
    const r = rig({ createPrompt: (async () => f) as never }); r.edit('keep me'); await r.ctl.savePrompt();
    assert.equal(r.store.s.work.problem?.kind, kind); assert.equal(r.store.s.fullPrompt, 'keep me'); assert.equal(r.store.s.dirty, true);
  }
  const r = rig({ createPrompt: (async () => bad('unauthenticated')) as never }); r.edit('x'); await r.ctl.savePrompt(); assert.equal(promptSaveView(r.store.s), 'signin');
});
test('incomplete drafts are refused before anything is sent (no title / no prompt / no outcome)', async () => {
  const r = rig(); r.dispatch({ type: 'editField', field: 'title', value: '   ' }); r.edit('text');
  assert.equal(await r.ctl.savePrompt(), 'refused'); assert.deepEqual(r.store.s.work.problem && { k: r.store.s.work.problem.kind, f: r.store.s.work.problem.field }, { k: 'incomplete', f: 'title' }); assert.equal(r.calls.length, 0);
  const r2 = rig(); r2.edit('   '); assert.equal(await r2.ctl.savePrompt(), 'refused'); assert.equal(r2.store.s.work.problem?.field, 'full_prompt');
  const r3 = rig(); r3.edit('ok'); assert.equal(await r3.ctl.saveResult(), 'refused'); assert.equal(r3.store.s.work.problem?.kind, 'outcome'); assert.equal(r3.calls.length, 0);
});
test('UPDATE with a lost response: the retry meets a version conflict; if the saved copy equals what was submitted the save counts as done at the saved version', async () => {
  const r2 = rig({ createPrompt: (async () => receipt(1)) as never, updatePrompt: (async () => bad('version_conflict')) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'v2 text' }))) as never });
  r2.edit('v1 text'); await r2.ctl.savePrompt(); r2.edit('v2 text'); await r2.ctl.savePrompt();
  assert.equal(r2.store.s.work.saved?.version, 2, 'adopts the version that is saved now'); assert.equal(r2.store.s.work.conflict, null); assert.equal(promptSaveView(r2.store.s), 'saved');
});
test('UPDATE conflict where the saved copy DIFFERS: nothing is marked saved; the member chooses; the draft is intact', async () => {
  const r = rig({ createPrompt: (async () => receipt(1)) as never, updatePrompt: (async () => bad('version_conflict')) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'edited in another tab' }))) as never });
  r.edit('v1'); await r.ctl.savePrompt(); r.edit('mine'); await r.ctl.savePrompt();
  assert.equal(promptSaveView(r.store.s), 'conflict'); assert.equal(r.store.s.work.conflict?.target, 'prompt'); assert.equal(r.store.s.fullPrompt, 'mine'); assert.equal(r.store.s.dirty, true); assert.equal(r.store.s.work.saved?.version, 1, 'still the old version');
});
test('CONFLICT CHOICES: load the saved version / save mine as a copy / overwrite (builds on the saved version)', async () => {
  const mk = () => rig({ createPrompt: (async () => receipt(1)) as never, updatePrompt: (async (_id: string, req: { expected_version: number }) => (req.expected_version === 1 ? bad('version_conflict') : receipt(3))) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'theirs' }))) as never });
  let r = mk(); r.edit('v1'); await r.ctl.savePrompt(); r.edit('mine'); await r.ctl.savePrompt();
  r.dispatch({ type: 'useServerPrompt', detail: detail({ version: 2, full_prompt: 'theirs' }), at: 5 });
  assert.equal(r.store.s.fullPrompt, 'theirs'); assert.equal(r.store.s.work.saved?.version, 2); assert.equal(r.store.s.dirty, false); assert.equal(r.store.s.work.conflict, null);
  r = mk(); r.edit('v1'); await r.ctl.savePrompt(); r.edit('mine'); await r.ctl.savePrompt();
  await r.ctl.overwrite(); assert.equal(r.calls.filter((c) => c.fn === 'updatePrompt').at(-1)?.args[1] && (r.calls.filter((c) => c.fn === 'updatePrompt').at(-1)!.args[1] as { expected_version: number }).expected_version, 2, 'overwrite builds on version 2');
  assert.equal(r.store.s.work.saved?.version, 3); assert.equal(r.store.s.fullPrompt, 'mine'); assert.equal(promptSaveView(r.store.s), 'saved');
  let created = 0; r = rig({ createPrompt: (async () => { created++; return created === 1 ? receipt(1) : ok({ id: 'p2', version: 1, updated_at: NOW }); }) as never, updatePrompt: (async () => bad('version_conflict')) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'theirs' }))) as never });
  r.edit('v1'); await r.ctl.savePrompt(); r.edit('mine'); await r.ctl.savePrompt(); await r.ctl.saveCopy();
  assert.equal(r.store.s.work.saved?.id, 'p2', 'linked to the copy'); assert.equal(r.store.s.fullPrompt, 'mine'); assert.equal(created, 2);
});
test('SUPERSEDED RECEIPT: a retried create answered with the original version-1 receipt is reconciled, never trusted as current', async () => {
  const r = rig({ createPrompt: (async () => receipt(1, { replay: true, superseded: true })) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'text B from another tab' }))) as never });
  r.edit('text A'); await r.ctl.savePrompt();
  assert.equal(r.store.s.work.saved, null, 'not marked saved at version 1'); assert.equal(promptSaveView(r.store.s), 'conflict'); assert.equal(r.store.s.work.conflict?.target === 'prompt' && r.store.s.work.conflict.server.version, 2); assert.equal(r.store.s.fullPrompt, 'text A');
  const same = rig({ createPrompt: (async () => receipt(1, { replay: true, superseded: true })) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'text A' }))) as never }); same.edit('text A'); await same.ctl.savePrompt();
  assert.equal(same.store.s.work.saved?.version, 2, 'same content: done, at the version that is saved now'); assert.equal(promptSaveView(same.store.s), 'saved');
  const plain = rig({ createPrompt: (async () => receipt(1, { replay: true, superseded: false })) as never }); plain.edit('x'); await plain.ctl.savePrompt(); assert.equal(plain.store.s.work.saved?.version, 1, 'a non-superseded replay is simply the answer');
});
test('RESULTS: prompt saved and unchanged → attach to it at the version tried; otherwise ONE combined operation', async () => {
  const r = rig({ createPrompt: (async () => receipt(1)) as never, saveResult: (async () => ok({ id: 'r1', version: 1, created_at: NOW, prompt_version: 1 })) as never, saveBoth: (async () => ok({ prompt: { id: 'p9', version: 1, updated_at: NOW }, result: { id: 'r9', version: 1, created_at: NOW } })) as never });
  r.edit('tried'); r.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' });
  await r.ctl.saveResult(); // prompt was never saved → combined
  assert.deepEqual(r.calls.map((c) => c.fn), ['saveBoth']); assert.equal(r.store.s.work.saved?.id, 'p9'); assert.equal(r.store.s.work.savedResult?.id, 'r9'); assert.equal(r.store.s.dirty, false); assert.equal(resultSaveView(r.store.s), 'saved');
  r.dispatch({ type: 'reflect', field: 'text', value: 'more words' }); assert.equal(resultSaveView(r.store.s), 'changed');
  const r2 = rig({ createPrompt: (async () => receipt(1)) as never, saveResult: (async () => ok({ id: 'r1', version: 1, created_at: NOW, prompt_version: 1 })) as never });
  r2.edit('tried'); await r2.ctl.savePrompt(); r2.dispatch({ type: 'reflect', field: 'outcome', value: 'partial' }); await r2.ctl.saveResult();
  assert.deepEqual(r2.calls.map((c) => c.fn), ['createPrompt', 'saveResult']); assert.equal((r2.calls[1].args[1] as { expected_prompt_version: number }).expected_prompt_version, 1, 'the version that was tried'); assert.equal(r2.store.s.work.savedResult?.id, 'r1');
});
test('a changed prompt is never attached to a result as if it were the saved one: unsaved edits → the combined operation updates the prompt at its version', async () => {
  const r = rig({ createPrompt: (async () => receipt(1)) as never, saveBoth: (async () => ok({ prompt: { id: 'p1', version: 2, updated_at: NOW }, result: { id: 'r2', version: 1, created_at: NOW } })) as never });
  r.edit('v1'); await r.ctl.savePrompt(); r.edit('v1 edited'); r.dispatch({ type: 'reflect', field: 'outcome', value: 'no' }); await r.ctl.saveResult();
  const call = r.calls.find((c) => c.fn === 'saveBoth')!.args[0] as { prompt_id: string; expected_prompt_version: number };
  assert.equal(call.prompt_id, 'p1'); assert.equal(call.expected_prompt_version, 1); assert.equal(r.store.s.work.saved?.version, 2); assert.equal(r.store.s.dirty, false);
});
test('RESULT conflicts: a stale prompt version with different saved content asks the member; same content adopts the version and retries once', async () => {
  const stale = rig({ createPrompt: (async () => receipt(1)) as never, saveResult: (async () => bad('version_conflict')) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'changed elsewhere' }))) as never });
  stale.edit('v1'); await stale.ctl.savePrompt(); stale.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); await stale.ctl.saveResult();
  assert.equal(resultSaveView(stale.store.s), 'conflict'); assert.equal(stale.store.s.work.savedResult, null);
  let n = 0; const same = rig({ createPrompt: (async () => receipt(1)) as never, saveResult: (async () => (++n === 1 ? bad('version_conflict') : ok({ id: 'r1', version: 1, created_at: NOW, prompt_version: 2 }))) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'v1' }))) as never });
  same.edit('v1'); await same.ctl.savePrompt(); same.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); await same.ctl.saveResult();
  assert.equal(same.store.s.work.savedResult?.id, 'r1'); assert.equal((same.calls.filter((c) => c.fn === 'saveResult')[1].args[1] as { expected_prompt_version: number }).expected_prompt_version, 2);
});
test('RESULT superseded replay: the stored result was edited since; saved words are fetched and compared, never reported as saved blindly', async () => {
  const r = rig({ createPrompt: (async () => receipt(1)) as never, saveResult: (async () => ok({ id: 'r1', version: 1, created_at: NOW, prompt_version: 1, replay: true, superseded: true })) as never, getResult: (async () => ok(rdetail({ version: 2, reflection: 'edited elsewhere' }))) as never });
  r.edit('v1'); await r.ctl.savePrompt(); r.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); r.dispatch({ type: 'reflect', field: 'text', value: 'my words' }); await r.ctl.saveResult();
  assert.equal(r.store.s.work.conflict?.target, 'result'); assert.equal(r.store.s.work.savedResult, null); assert.equal(r.store.s.reflection.text, 'my words');
  const same = rig({ createPrompt: (async () => receipt(1)) as never, saveResult: (async () => ok({ id: 'r1', version: 1, created_at: NOW, prompt_version: 1, replay: true, superseded: true })) as never, getResult: (async () => ok(rdetail({ version: 2, reflection: 'my words', next_change: '' }))) as never });
  same.edit('v1'); await same.ctl.savePrompt(); same.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); same.dispatch({ type: 'reflect', field: 'text', value: 'my words' }); await same.ctl.saveResult();
  assert.equal(same.store.s.work.savedResult?.version, 2); assert.equal(same.store.s.dirty, false);
});
test('updating a saved result sends its version; a conflict is reconciled; a deleted result is reported', async () => {
  const mk = (update: unknown) => rig({ createPrompt: (async () => receipt(1)) as never, saveResult: (async () => ok({ id: 'r1', version: 1, created_at: NOW, prompt_version: 1 })) as never, updateResult: update as never, getResult: (async () => ok(rdetail({ version: 2, reflection: 'theirs' }))) as never });
  const r = mk(async () => ok({ id: 'r1', version: 2, updated_at: NOW })); r.edit('v1'); await r.ctl.savePrompt(); r.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); await r.ctl.saveResult();
  r.dispatch({ type: 'reflect', field: 'text', value: 'more' }); await r.ctl.saveResult('update'); assert.equal(r.store.s.work.savedResult?.version, 2); assert.equal(resultSaveView(r.store.s), 'saved');
  const c = mk(async () => bad('version_conflict')); c.edit('v1'); await c.ctl.savePrompt(); c.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); await c.ctl.saveResult(); c.dispatch({ type: 'reflect', field: 'text', value: 'mine' }); await c.ctl.saveResult('update');
  assert.equal(c.store.s.work.conflict?.target, 'result');
  const g = mk(async () => bad('not_found')); g.edit('v1'); await g.ctl.savePrompt(); g.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); await g.ctl.saveResult(); g.dispatch({ type: 'reflect', field: 'text', value: 'mine' }); await g.ctl.saveResult('update');
  assert.equal(g.store.s.work.problem?.kind, 'result_gone');
});
test('deleting the saved item elsewhere: unlink leaves the draft intact and unsaved again; loading a saved prompt starts clean and linked', () => {
  let s = reduce(initialState, { type: 'startFromHack', hack }); s = reduce(s, { type: 'editPrompt', value: 'x' });
  s = reduce(s, { type: 'saveBegin', op: 'prompt_create', requestId: 'a', key: 'k', revision: s.work.revision, reflectionRevision: 0, epoch: s.work.epoch }); s = reduce(s, { type: 'saveDone', requestId: 'a', epoch: s.work.epoch, prompt: { id: 'p1', version: 1, at: 1 } });
  assert.equal(s.dirty, false); s = reduce(s, { type: 'unlink', target: 'prompt', id: 'p1' });
  assert.equal(s.work.saved, null); assert.equal(s.dirty, true); assert.equal(s.fullPrompt, 'x'); assert.equal(promptSaveView(s), 'not_saved');
  assert.equal(reduce(s, { type: 'unlink', target: 'prompt', id: 'other' }), s, 'another id changes nothing');
  const loaded = reduce(s, { type: 'loadSaved', detail: detail({ origin_kind: 'demo', origin_slug: null, origin_title: 'Pantry', starting_prompt: '' }), at: 3 });
  assert.equal(loaded.work.saved?.id, 'p1'); assert.equal(loaded.dirty, false); assert.equal(loaded.fields.title, 'T'); assert.equal(loaded.work.originRef.kind, 'demo'); assert.match(loaded.startingPrompt, /started from scratch/);
  assert.equal(promptSaveView(loaded), 'saved');
});
test('documents: origin is preserved (catalog slug / demo title / scratch), the scratch placeholder is not stored as a starting prompt, and a stored copy is compared field by field', () => {
  const s = reduce(reduce(initialState, { type: 'startFromHack', hack }), { type: 'editField', field: 'title', value: ' Plan ' });
  const b = buildPromptDoc({ ...s }); assert.ok(b.ok); assert.equal(b.doc.title, 'Plan'); assert.equal(b.doc.origin_kind, 'catalog'); assert.equal(b.doc.origin_slug, 'meal-plan'); assert.equal(b.doc.starting_prompt, 'starter');
  const blank = reduce(initialState, { type: 'startBlank' }); const bb = buildPromptDoc({ ...blank, fields: { ...blank.fields, title: 'x' }, fullPrompt: 'y' }); assert.ok(bb.ok); assert.equal(bb.doc.starting_prompt, ''); assert.equal(bb.doc.origin_kind, 'scratch'); assert.ok(!('origin_slug' in bb.doc));
  assert.equal(promptMatches(b.doc, detail({ title: 'Plan', full_prompt: s.fullPrompt, goal: s.fields.goal, context: s.fields.context, output_format: s.fields.format })), true);
  assert.equal(promptMatches(b.doc, detail({ title: 'Other' })), false);
  assert.equal(buildResultDoc({ outcome: '', text: '', next: '' }).ok, false); assert.ok(buildResultDoc({ outcome: 'yes', text: '', next: '' }).ok);
  assert.equal(buildPromptDoc({ ...s, fields: { ...s.fields, title: 't'.repeat(121) } }).ok, false);
});
test('resetting a saved draft keeps the link and makes it newer than the saved copy; starting from a hack or blank clears the saved link', () => {
  let s = reduce(initialState, { type: 'startFromHack', hack }); s = reduce(s, { type: 'editPrompt', value: 'x' });
  s = reduce(s, { type: 'saveBegin', op: 'prompt_create', requestId: 'a', key: 'k', revision: s.work.revision, reflectionRevision: 0, epoch: s.work.epoch }); s = reduce(s, { type: 'saveDone', requestId: 'a', epoch: s.work.epoch, prompt: { id: 'p1', version: 1, at: 1 } });
  const reset = reduce(s, { type: 'resetDraft' }); assert.equal(reset.work.saved?.id, 'p1'); assert.equal(promptSaveView(reset), 'changed'); assert.equal(reset.dirty, true);
  assert.equal(reduce(s, { type: 'startBlank' }).work.saved, null); assert.equal(reduce(s, { type: 'startFromHack', hack }).work.saved, null);
});

// ---- PX-3c correction pass ------------------------------------------------------------------------------------------------------------------------------
test('CORRECTION 2: RESET (or replacing the draft) during a save drops the pending acknowledgment; the answer for text A can never mark the starter text saved', async () => {
  const d = defer<ApiResult<never>>(); const r = rig({ createPrompt: (() => d.promise) as never });
  const starter = r.store.s.fullPrompt; r.edit('TEXT A'); const saving = r.ctl.savePrompt();
  assert.equal(r.store.s.work.inFlight?.epoch, r.store.s.work.epoch);
  r.dispatch({ type: 'resetDraft' }); assert.equal(r.store.s.fullPrompt, starter); assert.equal(r.store.s.work.inFlight, null, 'the save of the discarded draft is dropped');
  d.resolve(receipt(1) as never); await saving;
  assert.equal(r.store.s.work.saved, null, 'not linked to a prompt that holds other text'); assert.equal(promptSaveView(r.store.s), 'not_saved'); assert.equal(r.store.s.fullPrompt, starter);
  // with a saved link: the reset draft stays NEWER than the saved copy, whatever the late answer says
  const d2 = defer<ApiResult<never>>(); let calls = 0; const r2 = rig({ createPrompt: (async () => receipt(1)) as never, updatePrompt: (() => { calls++; return d2.promise; }) as never });
  r2.edit('v1'); await r2.ctl.savePrompt(); r2.edit('v2 = text A'); const upd = r2.ctl.savePrompt(); r2.dispatch({ type: 'resetDraft' });
  assert.equal(promptSaveView(r2.store.s), 'changed'); d2.resolve(receipt(2) as never); await upd;
  assert.equal(calls, 1); assert.equal(r2.store.s.work.saved?.version, 1, 'the late acknowledgment was not applied'); assert.equal(promptSaveView(r2.store.s), 'changed'); assert.equal(r2.store.s.dirty, true); assert.notEqual(r2.store.s.fullPrompt, 'v2 = text A');
  // every other way of replacing the draft behaves the same
  for (const replace of [{ type: 'startBlank' }, { type: 'startFromHack', hack }, { type: 'loadSaved', detail: detail({ id: 'p9', version: 7, full_prompt: 'other saved' }), at: 1 }, { type: 'accountChanged' }] as Action[]) {
    const dd = defer<ApiResult<never>>(); const r3 = rig({ createPrompt: (() => dd.promise) as never }); r3.edit('A'); const s3 = r3.ctl.savePrompt(); const before = r3.store.s.work.epoch;
    r3.dispatch(replace); assert.ok(r3.store.s.work.epoch > before, `${replace.type}: new generation`); dd.resolve(receipt(1, {}) as never); await s3;
    assert.notEqual(r3.store.s.work.saved?.id, 'p1', `${replace.type}: the old answer must not link the new draft`); assert.equal(r3.store.s.work.inFlight, null);
  }
  // a failure for the old generation is ignored too (no stale error on the new draft)
  const d4 = defer<ApiResult<never>>(); const r4 = rig({ createPrompt: (() => d4.promise) as never }); r4.edit('A'); const s4 = r4.ctl.savePrompt(); r4.dispatch({ type: 'startBlank' }); d4.resolve(bad('unavailable') as never); await s4; assert.equal(r4.store.s.work.problem, null);
});
test('CORRECTION 3a: a superseded COMBINED save checks BOTH halves: both equal → both saved at the saved versions; prompt differs → prompt conflict; only the result differs → prompt saved + a conflict on that result', async () => {
  const both = (extra: object = {}) => ok({ prompt: { id: 'p1', version: 1, updated_at: NOW }, result: { id: 'r1', version: 1, created_at: NOW }, replay: true, superseded: true, ...extra });
  const mk = (p: PromptDetail, rr: ResultDetail) => { const r = rig({ saveBoth: (async () => both()) as never, getPrompt: (async () => ok(p)) as never, getResult: (async () => ok(rr)) as never }); r.edit('tried text'); r.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); r.dispatch({ type: 'reflect', field: 'text', value: 'my words' }); return r; };
  const same = mk(detail({ version: 2, full_prompt: 'tried text' }), rdetail({ version: 3, reflection: 'my words', next_change: '' }));
  await same.ctl.saveResult(); assert.deepEqual(same.calls.map((c) => c.fn).sort(), ['getPrompt', 'getResult', 'saveBoth']);
  assert.equal(same.store.s.work.saved?.version, 2); assert.equal(same.store.s.work.savedResult?.version, 3, 'the result version that is saved NOW, not the receipt\'s'); assert.equal(same.store.s.dirty, false); assert.equal(same.store.s.work.conflict, null);
  const pDiff = mk(detail({ version: 2, full_prompt: 'changed elsewhere' }), rdetail({ version: 1, reflection: 'my words', next_change: '' }));
  await pDiff.ctl.saveResult(); assert.equal(pDiff.store.s.work.conflict?.target, 'prompt'); assert.equal(pDiff.store.s.work.saved, null); assert.equal(pDiff.store.s.work.savedResult, null, 'nothing is marked saved');
  const rDiff = mk(detail({ version: 2, full_prompt: 'tried text' }), rdetail({ version: 2, reflection: 'edited elsewhere', next_change: '' }));
  await rDiff.ctl.saveResult(); assert.equal(rDiff.store.s.work.saved?.version, 2, 'the prompt half is saved'); assert.equal(rDiff.store.s.work.savedResult, null, 'the result half is NOT marked saved'); assert.equal(rDiff.store.s.work.conflict?.target, 'result'); assert.equal(resultSaveView(rDiff.store.s), 'conflict'); assert.equal(rDiff.store.s.reflection.text, 'my words');
  const gone = rig({ saveBoth: (async () => both()) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'tried text' }))) as never, getResult: (async () => bad('not_found')) as never }); gone.edit('tried text'); gone.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); await gone.ctl.saveResult();
  assert.equal(gone.store.s.work.problem?.kind, 'result_gone'); assert.equal(gone.store.s.work.savedResult, null);
});
test('CORRECTION 3b: after a superseded FIRST create, "Overwrite" updates the conflicting prompt at its saved version (never another create) and ends saved', async () => {
  let creates = 0; const r = rig({ createPrompt: (async () => { creates++; return receipt(1, { replay: true, superseded: true }); }) as never,
    updatePrompt: (async (_id: string, req: { expected_version: number }) => (req.expected_version === 2 ? receipt(3) : bad('version_conflict'))) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'text B from another tab' }))) as never });
  r.edit('text A'); await r.ctl.savePrompt(); assert.equal(promptSaveView(r.store.s), 'conflict'); assert.equal(r.store.s.work.saved, null, 'no link yet');
  await r.ctl.overwrite();
  assert.equal(creates, 1, 'Overwrite must not issue another create'); const up = r.calls.find((c) => c.fn === 'updatePrompt')!; assert.equal(up.args[0], 'p1', 'the conflicting item\'s id'); assert.equal((up.args[1] as { expected_version: number }).expected_version, 2, 'its saved version');
  assert.equal(r.store.s.work.saved?.version, 3); assert.equal(promptSaveView(r.store.s), 'saved'); assert.equal(r.store.s.fullPrompt, 'text A'); assert.equal(r.store.s.dirty, false);
  // never-edited draft (revision 0): overwriting still marks it newer than the saved copy before it saves
  const r0 = rig({ createPrompt: (async () => receipt(1, { replay: true, superseded: true })) as never, updatePrompt: (async () => receipt(5)) as never, getPrompt: (async () => ok(detail({ version: 4, full_prompt: 'theirs' }))) as never });
  await r0.ctl.savePrompt(); await r0.ctl.overwrite(); assert.equal((r0.calls.find((c) => c.fn === 'updatePrompt')!.args[1] as { expected_version: number }).expected_version, 4);
  // results: a superseded first result create → Overwrite updates THAT result
  let rc = 0; const rr = rig({ createPrompt: (async () => receipt(1)) as never, saveResult: (async () => { rc++; return ok({ id: 'r1', version: 1, created_at: NOW, prompt_version: 1, replay: true, superseded: true }); }) as never,
    getResult: (async () => ok(rdetail({ version: 2, reflection: 'theirs' }))) as never, updateResult: (async () => ok({ id: 'r1', version: 3, updated_at: NOW })) as never });
  rr.edit('p'); await rr.ctl.savePrompt(); rr.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); rr.dispatch({ type: 'reflect', field: 'text', value: 'mine' }); await rr.ctl.saveResult();
  assert.equal(rr.store.s.work.conflict?.target, 'result'); await rr.ctl.overwrite();
  assert.equal(rc, 1, 'no second result create'); const ur = rr.calls.find((c) => c.fn === 'updateResult')!; assert.equal(ur.args[0], 'r1'); assert.equal((ur.args[1] as { expected_version: number }).expected_version, 2); assert.equal(rr.store.s.work.savedResult?.version, 3); assert.equal(resultSaveView(rr.store.s), 'saved');
});
test('CORRECTION 3c: "Save as copy" / "as a new result" always start a FRESH intent, so the original receipt is not replayed into the same conflict', async () => {
  const ids: string[] = [];
  const r = rig({ createPrompt: (async (req: { request_id: string }) => { ids.push(req.request_id); return ids.length === 1 ? receipt(1, { replay: true, superseded: true }) : ok({ id: 'p2', version: 1, updated_at: NOW }); }) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'theirs' }))) as never });
  r.edit('mine'); await r.ctl.savePrompt(); assert.equal(promptSaveView(r.store.s), 'conflict'); await r.ctl.saveCopy();
  assert.equal(ids.length, 2); assert.notEqual(ids[1], ids[0], 'a fresh request id'); assert.equal(r.store.s.work.saved?.id, 'p2'); assert.equal(promptSaveView(r.store.s), 'saved'); assert.equal(r.store.s.work.conflict, null);
  const resIds: string[] = []; const rr = rig({ createPrompt: (async () => receipt(1)) as never, saveResult: (async (_p: string, req: { request_id: string }) => { resIds.push(req.request_id); return resIds.length === 1 ? ok({ id: 'r1', version: 1, created_at: NOW, prompt_version: 1, replay: true, superseded: true }) : ok({ id: 'r2', version: 1, created_at: NOW, prompt_version: 1 }); }) as never, getResult: (async () => ok(rdetail({ version: 2, reflection: 'theirs' }))) as never });
  rr.edit('p'); await rr.ctl.savePrompt(); rr.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); rr.dispatch({ type: 'reflect', field: 'text', value: 'mine' }); await rr.ctl.saveResult(); await rr.ctl.saveCopy();
  assert.notEqual(resIds[1], resIds[0]); assert.equal(rr.store.s.work.savedResult?.id, 'r2'); assert.equal(resultSaveView(rr.store.s), 'saved');
});
test('CORRECTION 1 (draft side): an account change drops pending answers, conflict copies, messages and saved links; the draft text stays, unsaved', async () => {
  const d = defer<ApiResult<never>>(); const r = rig({ createPrompt: (async () => receipt(1)) as never, updatePrompt: (() => d.promise) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'A\'s private saved text' }))) as never });
  r.edit('v1'); await r.ctl.savePrompt(); r.edit('v2'); const upd = r.ctl.savePrompt();
  r.dispatch({ type: 'accountChanged' });
  const w = r.store.s.work; assert.equal(w.saved, null); assert.equal(w.inFlight, null); assert.equal(w.conflict, null); assert.equal(w.problem, null); assert.equal(r.store.s.fullPrompt, 'v2'); assert.equal(r.store.s.dirty, true); assert.equal(promptSaveView(r.store.s), 'not_saved');
  d.resolve(bad('version_conflict') as never); await upd; assert.equal(r.store.s.work.conflict, null, 'a late conflict from the old account never shows its saved copy');
  const c = rig({ createPrompt: (async () => receipt(1, { replay: true, superseded: true })) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'private server copy' }))) as never }); c.edit('mine'); await c.ctl.savePrompt(); assert.ok(c.store.s.work.conflict);
  c.dispatch({ type: 'accountChanged' }); assert.equal(c.store.s.work.conflict, null, 'the private saved copy is no longer held');
});

// ---- PX-3c second correction pass ------------------------------------------------------------------------------------------------------------------------
test('LATE RECONCILIATION (exact sequence): save a prompt, begin saving a result, hold the conflict-reconciliation read, RESET the draft, release the read → the starter text is NOT marked saved, no link changes, and no second save starts', async () => {
  const held = defer<ApiResult<never>>();
  const r = rig({ createPrompt: (async () => receipt(1)) as never, saveResult: (async () => bad('version_conflict')) as never, getPrompt: (() => held.promise) as never,
    saveBoth: (async () => ok({ prompt: { id: 'p1', version: 3, updated_at: NOW }, result: { id: 'r9', version: 1, created_at: NOW } })) as never });
  r.edit('tried text'); await r.ctl.savePrompt(); assert.equal(promptSaveView(r.store.s), 'saved');
  r.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' });
  const saving = r.ctl.saveResult();                                          // the result save meets a version conflict and starts reconciling: its read is held
  await Promise.resolve(); await Promise.resolve();
  assert.ok(r.calls.some((c) => c.fn === 'getPrompt'), 'the reconciliation read is pending');
  r.dispatch({ type: 'resetDraft' });                                         // the member resets the draft meanwhile
  const starter = r.store.s.fullPrompt; assert.notEqual(starter, 'tried text'); const link = r.store.s.work.saved, savedRev = r.store.s.work.savedRevision;
  held.resolve(ok(detail({ version: 2, full_prompt: 'tried text' })) as never);   // …the read finishes with content EQUAL to what the result save submitted (the case that used to adopt the version and "sync")
  await saving;
  const s = r.store.s;
  assert.equal(s.fullPrompt, starter, 'the starter text is untouched'); assert.equal(promptSaveView(s), 'changed', 'still newer than the saved copy: NOT Saved'); assert.equal(s.dirty, true);
  assert.deepEqual(s.work.saved, link, 'the saved link did not change (no adopted version)'); assert.equal(s.work.savedRevision, savedRev, 'the saved revision did not move'); assert.ok(s.work.revision > s.work.savedRevision);
  assert.equal(s.work.conflict, null, 'no conflict copy from the dropped save'); assert.equal(s.work.inFlight, null); assert.equal(s.work.savedResult, null);
  assert.deepEqual(r.calls.map((c) => c.fn), ['createPrompt', 'saveResult', 'getPrompt'], 'no second save (neither saveResult nor saveBoth) was started');
  // the same read finishing after an ACCOUNT change or a replaced draft behaves the same
  for (const replace of [{ type: 'accountChanged' }, { type: 'startBlank' }, { type: 'startFromHack', hack }, { type: 'loadSaved', detail: detail({ id: 'p9', version: 4, full_prompt: 'x' }), at: 1 }] as Action[]) {
    const h = defer<ApiResult<never>>(); const q = rig({ createPrompt: (async () => receipt(1)) as never, saveResult: (async () => bad('version_conflict')) as never, getPrompt: (() => h.promise) as never, saveBoth: (async () => { throw new Error('a stale reconciliation started another save'); }) as never });
    q.edit('tried text'); await q.ctl.savePrompt(); q.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); const sv = q.ctl.saveResult(); await Promise.resolve(); await Promise.resolve();
    q.dispatch(replace); const before = q.store.s; h.resolve(ok(detail({ version: 2, full_prompt: 'tried text' })) as never); await sv;
    assert.deepEqual(q.store.s.work.saved, before.work.saved, `${replace.type}: links unchanged`); assert.equal(q.store.s.work.inFlight, null); assert.equal(q.store.s.work.conflict, null); assert.equal(q.calls.filter((c) => c.fn === 'saveResult' || c.fn === 'saveBoth').length, 1, `${replace.type}: no follow-up save`);
    assert.equal(q.store.s.work.savedResult, null, `${replace.type}: no result marked saved`);
  }
  // sanity: when NOTHING changed meanwhile, the same-content case still adopts the version and retries once (the behaviour this guard must not break)
  let n = 0; const ok2 = rig({ createPrompt: (async () => receipt(1)) as never, saveResult: (async () => (++n === 1 ? bad('version_conflict') : ok({ id: 'r1', version: 1, created_at: NOW, prompt_version: 2 }))) as never, getPrompt: (async () => ok(detail({ version: 2, full_prompt: 'tried text' }))) as never });
  ok2.edit('tried text'); await ok2.ctl.savePrompt(); ok2.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); await ok2.ctl.saveResult(); assert.equal(ok2.store.s.work.savedResult?.id, 'r1'); assert.equal(ok2.store.s.work.saved?.version, 2);
});
test('adoptVersion from another draft generation changes nothing; reconciliation reads that fail or finish late never mark anything', async () => {
  let s = reduce(initialState, { type: 'startFromHack', hack }); s = reduce(s, { type: 'editPrompt', value: 'x' });
  const stale = reduce(s, { type: 'adoptVersion', target: 'prompt', id: 'p1', version: 5, inSync: true, epoch: s.work.epoch - 1 }); assert.equal(stale, s);
  const live = reduce(s, { type: 'adoptVersion', target: 'prompt', id: 'p1', version: 5, inSync: true, epoch: s.work.epoch }); assert.equal(live.work.saved?.version, 5);
  const gone = rig({ createPrompt: (async () => receipt(1)) as never, saveResult: (async () => bad('version_conflict')) as never, getPrompt: (async () => bad('unavailable')) as never });
  gone.edit('t'); await gone.ctl.savePrompt(); gone.dispatch({ type: 'reflect', field: 'outcome', value: 'yes' }); await gone.ctl.saveResult(); assert.equal(gone.store.s.work.problem?.kind, 'unavailable'); assert.equal(gone.store.s.work.savedResult, null);
});
