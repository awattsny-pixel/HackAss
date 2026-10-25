// UI slice S3: guided questions with a fixed-rule preview, highlighted adaptation (Hack page and Lab), advanced editing, and the copy-then-open row.
// All three modes edit the one draft and save through the one controller. Nothing here judges a prompt; nothing calls a model or a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzePrompt, answerOf, applyAnswer, CHAT_ANSWERED, CHAT_FRESH, CHAT_STEPS, EDIT_MODES, findBlockEnd, followEdit, gettingThere, joinContext, nextStep, rebuildPrompt, SCRIPTED_NOTE, splitContext, titleSuggestion } from '../src/ui/experience/guided.ts';
import { composePrompt, hackFromCatalog, PROMPT_TAIL } from '../src/ui/experience/prompt.ts';
import { PROVIDERS } from '../src/ui/experience/providers.ts';
import { copyStillValid, createCopyFlow } from '../src/ui/experience/copy.ts';
import { DEMO_HACKS } from '../src/ui/experience/demo-hacks.ts';
import { hasPending, initialState, reduce, requiresConfirmation, type Action, type ExperienceState } from '../src/ui/experience/state.ts';
import { keyboardInset, keyboardOpen } from '../src/ui/experience/viewport.ts';
import { LIMITS } from '../src/modules/mywork/index.ts';
import type { PromptDetail } from '../src/modules/mywork/index.ts';
import { buildPromptDoc } from '../src/ui/work/doc.ts';
import { createWorkController } from '../src/ui/work/controller.ts';
import type { ApiResult, WorkApi } from '../src/ui/work/api.ts';
import type { ExperienceHack } from '../src/ui/experience/types.ts';

const src = (f: string) => readFileSync(f, 'utf8');
const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const run = (...as: Action[]): ExperienceState => as.reduce(reduce, initialState);
const NEW_FILES = ['guided.ts', 'GuidedPanel.tsx', 'HighlightedPrompt.tsx', 'HackActions.tsx', 'ProviderLinks.tsx', 'providers.ts', 'useRebuild.ts', 'viewport.ts', 'useKeyboardInset.ts'].map((f) => `src/ui/experience/${f}`);

const catalog: ExperienceHack = hackFromCatalog({
  slug: 'meal-plan', title: 'Weekly meal plan', summary: 'Plan dinners', category: { name: 'Everyday' }, outcome: 'Five dinners planned', limitations: 'Not medical advice',
  steps: [{ position: 2, body: 'Review the list' }, { position: 1, body: 'List what you have' }], materials: [{ position: 1, name: 'Pantry list', detail: null }], requirements: [{ kind: 'tool', name: 'An AI tool', detail: null }],
});
const METHOD = '\n\nMethod from the published hack:\n1. List what you have\n2. Review the list';

test('a catalog starter follows its own fields and keeps the method steps after the generated block', () => {
  assert.ok(catalog.starterPrompt.endsWith(METHOD));
  const link = analyzePrompt(catalog.starterPrompt, catalog);
  assert.equal(link.kind, 'follows'); assert.equal(link.kind === 'follows' && link.rest, METHOD);
});

test('editing an answer rewrites only the generated block, in ONE revision, and keeps the method and the member\'s own text', () => {
  const s0 = run({ type: 'startFromHack', hack: catalog });
  const withNotes = reduce(s0, { type: 'editPrompt', value: s0.fullPrompt + '\n\nMy note: keep it under 30 minutes.' });
  const s1 = reduce(withNotes, { type: 'editSlot', field: 'goal', value: 'Plan six dinners' });
  assert.equal(s1.fullPrompt, composePrompt({ ...s1.fields }) + METHOD + '\n\nMy note: keep it under 30 minutes.');
  assert.equal(s1.work.revision, withNotes.work.revision + 1);
  assert.equal(s1.dirty, true);
  assert.equal(s1.work.epoch, withNotes.work.epoch); assert.equal(s1.work.saved, withNotes.work.saved); assert.equal(s1.work.inFlight, null);
});

test('a prompt rewritten by hand is never overwritten by an answer: the answer changes, the text does not, and the link reads as stale or free', () => {
  const s0 = run({ type: 'startFromHack', hack: catalog });
  // the Objective line edited inside the prompt text: the block is still identifiable, but it no longer matches the answers
  const handEdited = reduce(s0, { type: 'editPrompt', value: s0.fullPrompt.replace('Objective: Five dinners planned', 'Objective: Whatever I typed') });
  const link = analyzePrompt(handEdited.fullPrompt, handEdited.fields);
  assert.equal(link.kind, 'stale'); assert.equal(link.kind === 'stale' && link.rest, METHOD);
  const after = reduce(handEdited, { type: 'editSlot', field: 'goal', value: 'Something else' });
  assert.equal(after.fullPrompt, handEdited.fullPrompt, 'text untouched'); assert.equal(after.fields.goal, 'Something else');
  // the fixed closing sentence edited: no block can be identified, so nothing is guessed
  const broken = reduce(s0, { type: 'editPrompt', value: s0.fullPrompt.replace(PROMPT_TAIL, 'Be brief.') });
  assert.equal(analyzePrompt(broken.fullPrompt, broken.fields).kind, 'free');
  assert.equal(reduce(broken, { type: 'editSlot', field: 'goal', value: 'x' }).fullPrompt, broken.fullPrompt);
});

test('rebuild: keeps what follows an identified block; asks to replace everything when no block is identifiable; never guesses between two readings', () => {
  const s0 = run({ type: 'startFromHack', hack: catalog });
  const stale = reduce(s0, { type: 'editPrompt', value: s0.fullPrompt.replace('Objective: Five dinners planned', 'Objective: Changed in text') });
  const r1 = rebuildPrompt(stale.fullPrompt, stale.fields)!;
  assert.equal(r1.keeps, true); assert.equal(r1.text, composePrompt(stale.fields) + METHOD);
  assert.equal(reduce(stale, { type: 'rebuild' }).fullPrompt, r1.text);
  const free = run({ type: 'startFromHack', hack: DEMO_HACKS[0]! });
  const r2 = rebuildPrompt(free.fullPrompt, free.fields)!;
  assert.equal(r2.keeps, false); assert.equal(r2.text, composePrompt(free.fields));
  // a second copy of the closing sentence makes two readings possible: not identifiable
  const twice = s0.fullPrompt + '\n\n' + s0.fullPrompt;
  assert.equal(findBlockEnd(twice), null); assert.equal(analyzePrompt(twice, { goal: 'zzz', context: 'zzz', format: 'Concise summary' }).kind, 'free');
  assert.equal(requiresConfirmation(s0, 'rebuild'), true); assert.equal(requiresConfirmation(run({ type: 'startBlank' }), 'rebuild'), false);
});

test('cleared answers: the block stays with an empty slot, text after it is kept, and an empty draft stays empty until there is something to say', () => {
  const s0 = run({ type: 'startFromHack', hack: catalog });
  const cleared = reduce(reduce(s0, { type: 'editSlot', field: 'goal', value: '' }), { type: 'editSlot', field: 'context', value: '' });
  assert.equal(cleared.fullPrompt, composePrompt({ goal: '', context: '', format: s0.fields.format }) + METHOD);
  assert.equal(analyzePrompt(cleared.fullPrompt, cleared.fields).kind, 'follows');
  const blank = run({ type: 'startBlank' });
  assert.equal(reduce(blank, { type: 'editSlot', field: 'title', value: 'Only a title' }).fullPrompt, '');
  assert.equal(reduce(blank, { type: 'editSlot', field: 'format', value: 'Comparison table' }).fullPrompt, '');
  const typed = reduce(blank, { type: 'editSlot', field: 'goal', value: 'Plan a trip' });
  assert.equal(typed.fullPrompt, composePrompt(typed.fields)); assert.match(typed.fullPrompt, /^Objective: Plan a trip\n\n/);
});

test('an answer that would push the prompt over its length limit leaves the prompt alone instead of truncating', () => {
  const s0 = run({ type: 'startBlank' }, { type: 'editSlot', field: 'goal', value: 'x' });
  const long = reduce(s0, { type: 'editPrompt', value: s0.fullPrompt + 'y'.repeat(LIMITS.prompt - s0.fullPrompt.length) });
  assert.equal(long.fullPrompt.length, LIMITS.prompt);
  const after = reduce(long, { type: 'editSlot', field: 'goal', value: 'a much longer goal than before' });
  assert.equal(after.fullPrompt, long.fullPrompt);
  assert.equal(followEdit(long.fullPrompt, long.fields, after.fields), null);
  assert.equal(reduce(after, { type: 'rebuild' }).fullPrompt, after.fullPrompt, 'rebuild over the limit changes nothing');
});

test('demo starters are free text: shown and edited as one piece, never split by guesswork', () => {
  for (const d of DEMO_HACKS) assert.equal(analyzePrompt(d.starterPrompt, d).kind, 'free', d.key);
});

test('mode switching preserves the draft exactly; defaults are Adapt (from a hack), Guided (from scratch), Advanced (a reopened saved prompt); Reset keeps the view', () => {
  assert.deepEqual([...EDIT_MODES], ['guided', 'adapt', 'advanced']);
  assert.equal(run({ type: 'startFromHack', hack: catalog }).editMode, 'adapt');
  assert.equal(run({ type: 'startBlank' }).editMode, 'guided');
  const detail = { id: 'p1', version: 1, title: 'T', goal: 'g', context: 'c', output_format: 'Concise summary', full_prompt: 'hand written', starting_prompt: '', origin_kind: 'scratch', origin_slug: null, origin_title: null, updated_at: '2026-10-20T12:00:00+00:00' } as unknown as PromptDetail;
  const reopened = run({ type: 'loadSaved', detail, at: 1 });
  assert.equal(reopened.editMode, 'advanced');
  const s = run({ type: 'startFromHack', hack: catalog }, { type: 'editSlot', field: 'goal', value: 'Edited' });
  let cur = s;
  for (const m of ['guided', 'advanced', 'adapt', 'guided'] as const) {
    cur = reduce(cur, { type: 'setEditMode', editMode: m });
    assert.deepEqual({ ...cur, editMode: s.editMode }, s, `switching to ${m} changes only the view`);
  }
  assert.equal(reduce(cur, { type: 'resetDraft' }).editMode, 'guided');
  assert.equal(reduce(cur, { type: 'useServerPrompt', detail, at: 1 }).editMode, 'guided', 'loading a saved version does not jump the view');
});

test('Original / Your version is a view choice: no component that shows it dispatches, and the screens keep it in local state', () => {
  const hp = code('src/ui/experience/HighlightedPrompt.tsx'), ha = code('src/ui/experience/HackActions.tsx');
  assert.doesNotMatch(hp, /useExperience|dispatch\(/);
  assert.match(ha, /onClick=\{\(\) => p\.onVersion\('mine'\)\}/); assert.match(ha, /onClick=\{\(\) => p\.onVersion\('original'\)\}/);
  for (const f of ['LabScreen', 'DetailScreen']) assert.match(code(`src/ui/experience/${f}.tsx`), /useState<Version>\('mine'\)/);
  assert.doesNotMatch(ha, /dispatch|work\.save|startFromHack|editSlot/);
});

test('Hack page: the prompt comes first with the highlights INSIDE the sentence; the editor applies in one step; Apply starts the SAME draft through the replace-draft guard (Cancel never runs it)', () => {
  const d = code('src/ui/experience/DetailScreen.tsx');
  assert.match(d, /confirmThen\('adapt', \(\) => dispatch\(\{ type: 'startFromHack', hack, apply: \{ slot: e\.slot, value: e\.value \}, expectGen: gen \}\), \{ exceptEditor: editorKey \}\);/);
  assert.match(d, /if \(bound\) \{ dispatch\(\{ type: 'applyEditor', gen, key: editorKey \}\); return; \}/);
  assert.equal((d.match(/type: 'startFromHack'/g) ?? []).length, 2, 'only "Make it yours" and the guarded Apply start a draft');
  assert.ok(d.indexOf('prompt-card') < d.indexOf('col-details') && d.indexOf('prompt-card') < d.indexOf('<HackActions'), 'prompt first, then the actions and the details');
  const hp = code('src/ui/experience/HighlightedPrompt.tsx');
  assert.match(hp, /<p><span className="hl-label">Objective:<\/span> \{hl\('goal', fields\.goal\)\}<\/p>/, 'highlights sit inside the prompt sentence');
  assert.doesNotMatch(hp, /<(textarea|input)[^>]*value=\{fields\./, 'no separate labelled field blocks in the prompt');
  assert.match(hp, /onCancel=\{\(e\) => \{ e\.preventDefault\(\); close\(\); \}\}/); assert.match(hp, /e\.key === 'Escape'/);
  assert.match(hp, /\(max-width: 767px\)/); assert.match(hp, /showModal\(\)/);
  // functional: a dirty draft from another hack needs confirmation; with Cancel nothing is dispatched, so the state is the very same object
  const other = run({ type: 'startFromHack', hack: DEMO_HACKS[0]! }, { type: 'editSlot', field: 'title', value: 'Mine' });
  assert.equal(requiresConfirmation(other, 'adapt'), true);
  const cancelled: ExperienceState = other; assert.equal(cancelled, other);
  const confirmed = [{ type: 'startFromHack', hack: catalog }, { type: 'editSlot', field: 'goal', value: 'Applied' }].reduce((st, a) => reduce(st, a as Action), other);
  assert.equal(confirmed.origin?.key, 'meal-plan'); assert.equal(confirmed.fields.goal, 'Applied'); assert.equal(confirmed.work.revision, 1);
});

test('the Hack page action panel: Copy, copy-then-open, Original / Your version, Save my version (the shared controller), How did it go; Share and Remix are shown unavailable', () => {
  const ha = code('src/ui/experience/HackActions.tsx');
  assert.match(ha, /<button type="button" className="btn" disabled aria-disabled="true" aria-describedby="hack-unavail">Share<\/button>/);
  assert.match(ha, /<button type="button" className="btn" disabled aria-disabled="true" aria-describedby="hack-unavail">Remix<\/button>/);
  assert.match(ha, /<SavePanel compact \/>/); assert.match(ha, /href="\/reveal">How did it go\?/); assert.match(ha, /Copy first, then open your AI tool from here/);
  const sp = code('src/ui/work/SavePanel.tsx'); assert.match(sp, /compact \? 'Save my version' : 'Save prompt'/); assert.match(sp, /work\.savePrompt\('save'\)/);
  assert.doesNotMatch(ha, /navigator\.share|fetch\(|window\.open/);
});

test('Hack page and Lab edit one draft: an in-place edit is the revision the Lab (and the save controller) sees', () => {
  const s = run({ type: 'startFromHack', hack: catalog }, { type: 'editSlot', field: 'context', value: 'Two adults, no nuts' }, { type: 'editSlot', field: 'title', value: 'My plan' });
  assert.equal(s.work.revision, 2); assert.equal(s.dirty, true);
  const built = buildPromptDoc(s);
  assert.ok(built.ok && built.doc.context === 'Two adults, no nuts' && built.doc.full_prompt.includes('Context and constraints: Two adults, no nuts') && built.doc.full_prompt.endsWith(METHOD));
});

test('save / reopen: a guided draft saves exactly the existing document, and reopening it gives the same answers and the same prompt', async () => {
  let n = 0; const bodies: unknown[] = [];
  const store = { s: run({ type: 'startBlank' }) };
  const dispatch = (a: Action) => { store.s = reduce(store.s, a); };
  for (const [field, value] of [['title', 'Trip plan'], ['goal', 'Plan a 3-day trip'], ['context', 'Two adults. Budget 900. Limits: no flights.'], ['format', 'Comparison table']] as const) dispatch({ type: 'editSlot', field, value });
  const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data, status: 200 });
  const api = { createPrompt: async (b: unknown) => { bodies.push(b); return ok({ id: 'p1', version: 1, updated_at: '2026-10-20T12:00:00+00:00' }); } } as unknown as WorkApi;
  const ctl = createWorkController({ api, getState: () => store.s, dispatch, newId: () => `req-${++n}`, now: () => 1 });
  await ctl.savePrompt();
  assert.equal(bodies.length, 1);
  const doc = (bodies[0] as { prompt: Record<string, unknown> }).prompt;
  assert.deepEqual(Object.keys(doc).sort(), ['context', 'full_prompt', 'goal', 'origin_kind', 'output_format', 'starting_prompt', 'title']);
  assert.equal(store.s.dirty, false);
  assert.equal(doc.full_prompt, composePrompt({ goal: 'Plan a 3-day trip', context: 'Two adults. Budget 900. Limits: no flights.', format: 'Comparison table' }));
  const reopened = reduce(initialState, { type: 'loadSaved', at: 1, detail: { id: 'p1', version: 1, updated_at: '2026-10-20T12:00:00+00:00', ...doc, origin_slug: null, origin_title: null } as unknown as PromptDetail });
  assert.deepEqual(reopened.fields, store.s.fields); assert.equal(reopened.fullPrompt, store.s.fullPrompt); assert.equal(reopened.editMode, 'advanced');
  assert.equal(analyzePrompt(reopened.fullPrompt, reopened.fields).kind, 'follows', 'switching a reopened prompt to Guided shows its answers, linked');
});

test('a save in flight is unaffected by the next in-place edit: only the submitted revision is marked saved', async () => {
  let resolve!: (v: ApiResult<unknown>) => void; let n = 0;
  const store = { s: run({ type: 'startBlank' }, { type: 'editSlot', field: 'title', value: 'T' }, { type: 'editSlot', field: 'goal', value: 'First' }) };
  const dispatch = (a: Action) => { store.s = reduce(store.s, a); };
  const api = { createPrompt: () => new Promise((r) => { resolve = r as never; }) } as unknown as WorkApi;
  const ctl = createWorkController({ api, getState: () => store.s, dispatch, newId: () => `req-${++n}`, now: () => 1 });
  const saving = ctl.savePrompt(); const submitted = store.s.work.revision;
  dispatch({ type: 'editSlot', field: 'goal', value: 'Second' });
  resolve({ ok: true, status: 200, data: { id: 'p1', version: 1, updated_at: '2026-10-20T12:00:00+00:00' } }); await saving;
  assert.equal(store.s.work.savedRevision, submitted); assert.equal(store.s.dirty, true); assert.match(store.s.fullPrompt, /Objective: Second/);
});

test('the exchange is scripted: five fixed questions in a fixed order with fixed chips, each answer is one of the existing draft fields', () => {
  assert.deepEqual(CHAT_STEPS.map((q) => q.id), ['goal', 'context', 'limits', 'format', 'title']);
  assert.deepEqual(CHAT_STEPS.find((q) => q.id === 'limits')!.chips.map((c) => c.label), ['Keep it short', 'Friendly tone', 'No jargon', 'Skip']);
  assert.equal(CHAT_STEPS.find((q) => q.id === 'limits')!.chips.find((c) => c.label === 'Skip')!.insert, null);
  assert.deepEqual(CHAT_STEPS.find((q) => q.id === 'format')!.chips.map((c) => c.label), ['Clear step-by-step plan', 'Comparison table', 'Creative draft', 'Concise summary']);
  assert.match(CHAT_STEPS[0]!.ask, /What do you want an AI to do for you\?/);
  const f = { title: '', goal: '', context: '', format: 'Clear step-by-step plan' as const };
  assert.deepEqual(applyAnswer('goal', ' Plan a trip ', f), { field: 'goal', value: 'Plan a trip' });
  assert.deepEqual(applyAnswer('title', 'Trip', f), { field: 'title', value: 'Trip' });
  assert.deepEqual(applyAnswer('format', 'Comparison table', f), { field: 'format', value: 'Comparison table' });
  assert.equal(titleSuggestion('  plan a three day trip to Lisbon with my family.  '), 'Plan a three day trip to');
  const doc = buildPromptDoc(run({ type: 'startFromHack', hack: catalog }));
  assert.ok(doc.ok); assert.deepEqual(Object.keys(doc.ok ? doc.doc : {}).sort(), ['context', 'full_prompt', 'goal', 'origin_kind', 'origin_slug', 'origin_title', 'output_format', 'starting_prompt', 'title']);
});

test('limits live inside the context field after a fixed marker (no new field): split, join and apply round-trip, and over-long joins are refused', () => {
  assert.deepEqual(splitContext('Two adults.\n\nLimits: no flights'), { context: 'Two adults.', limits: 'no flights' });
  assert.deepEqual(splitContext('Only context'), { context: 'Only context', limits: '' });
  assert.deepEqual(splitContext('Limits: only limits'), { context: '', limits: 'only limits' });
  assert.equal(joinContext(' Two adults. ', ' no flights '), 'Two adults.\n\nLimits: no flights'); assert.equal(joinContext('Two adults.', ''), 'Two adults.'); assert.equal(joinContext('', 'x'), 'Limits: x');
  const f = { title: 'T', goal: 'g', context: 'Who and how much\n\nLimits: short', format: 'Concise summary' as const };
  assert.equal(answerOf('context', f), 'Who and how much'); assert.equal(answerOf('limits', f), 'short');
  assert.deepEqual(applyAnswer('limits', 'friendly', f), { field: 'context', value: 'Who and how much\n\nLimits: friendly' });
  assert.deepEqual(applyAnswer('limits', '', f), { field: 'context', value: 'Who and how much' });
  assert.deepEqual(applyAnswer('context', 'New context', f), { field: 'context', value: 'New context\n\nLimits: short' });
  assert.equal(applyAnswer('context', 'c'.repeat(LIMITS.context - 5), f), null, 'context plus limits would pass the field limit');
  const saved = reduce(run({ type: 'startBlank' }), { type: 'editSlot', field: 'context', value: applyAnswer('limits', 'x', { ...f, context: 'ctx' })!.value });
  assert.equal(buildPromptDoc({ ...saved, fields: { ...saved.fields, title: 'T' } }).ok, true, 'it saves like any other draft');
});

test('the exchange asks the first open question: nothing is asked twice, Skip is remembered, and completion is set by the event that creates a draft, never inferred from field contents', () => {
  const blank = { title: '', goal: '', context: '', format: 'Clear step-by-step plan' as const };
  assert.equal(nextStep(blank, CHAT_FRESH), 'goal');
  assert.equal(nextStep({ ...blank, goal: 'g' }, CHAT_FRESH), 'context');
  assert.equal(nextStep({ ...blank, goal: 'g', context: 'c' }, CHAT_FRESH), 'limits');
  assert.equal(nextStep({ ...blank, goal: 'g', context: 'c\n\nLimits: l' }, CHAT_FRESH), 'format');
  assert.equal(nextStep({ ...blank, goal: 'g', context: 'c' }, { limitsSkipped: true, formatDone: false }), 'format');
  assert.equal(nextStep({ ...blank, goal: 'g', context: 'c' }, { limitsSkipped: true, formatDone: true }), 'title');
  assert.equal(nextStep({ ...blank, title: 't', goal: 'g', context: 'c' }, { limitsSkipped: true, formatDone: true }), null);
  assert.deepEqual(run({ type: 'startBlank' }).chat, CHAT_FRESH); assert.deepEqual(run({ type: 'startFromHack', hack: catalog }).chat, CHAT_ANSWERED);
  const saved = run({ type: 'loadSaved', at: 1, detail: { id: 'p', version: 1, title: 'T', goal: 'g', context: 'c', output_format: 'Concise summary', full_prompt: 'x', starting_prompt: '', origin_kind: 'scratch', origin_slug: null, origin_title: null, updated_at: '2026-10-20T12:00:00+00:00' } as unknown as PromptDetail });
  assert.deepEqual(saved.chat, CHAT_ANSWERED);
  const full = run({ type: 'startFromHack', hack: catalog }); assert.equal(nextStep(full.fields, full.chat), null);
  // text that appears in other fields (typed in Advanced, say) does not close the questions it happens to sit beside
  const typedElsewhere = ['goal', 'context'].reduce((st, f) => reduce(st, { type: 'editField', field: f as 'goal', value: 'filled elsewhere' }), run({ type: 'startBlank' }));
  assert.equal(nextStep(typedElsewhere.fields, typedElsewhere.chat), 'limits', 'limits is still open');
  assert.deepEqual(reduce(typedElsewhere, { type: 'accountChanged' }).chat, typedElsewhere.chat, 'an account change leaves the exchange where it was');
});

test('REGRESSION: a limits answer typed but not sent stays with the limits question after leaving and returning; Send puts it in the limits, never in the title', () => {
  let s = run({ type: 'startBlank' }); const g = gen(s);
  // Answer Goal and Context through the exchange
  s = reduce(s, { type: 'setAnswer', gen: g, answer: { text: 'Plan a dinner', step: 'goal' } }); s = reduce(s, { type: 'sendAnswer', gen: g });
  s = reduce(s, { type: 'setAnswer', gen: g, answer: { text: 'Eight people', step: 'context' } }); s = reduce(s, { type: 'sendAnswer', gen: g });
  assert.equal(nextStep(s.fields, s.chat), 'limits'); assert.equal(s.fields.goal, 'Plan a dinner'); assert.equal(s.fields.context, 'Eight people');
  // At Limits, type "Avoid peanuts" without sending
  s = reduce(s, { type: 'setAnswer', gen: g, answer: { text: 'Avoid peanuts', step: 'limits' } });
  assert.equal(s.dirty, true);
  // Visit Home and return to the Lab: nothing in the shared state changes (the screens are views of it); a mode switch and an account change in between do not either
  for (const a of [{ type: 'setEditMode', editMode: 'advanced' }, { type: 'setEditMode', editMode: 'guided' }, { type: 'accountChanged' }] as Action[]) s = reduce(s, a);
  assert.deepEqual(s.pending.answer, { text: 'Avoid peanuts', step: 'limits' }, 'the answer is still bound to the limits question');
  assert.equal(nextStep(s.fields, s.chat), 'limits', 'limits is still the open question (it was not inferred as answered)');
  assert.equal(s.chat.limitsSkipped, false); assert.equal(s.chat.formatDone, false);
  // Send
  const sent = reduce(s, { type: 'sendAnswer', gen: g });
  assert.equal(sent.fields.title, '', 'nothing went into the title'); assert.equal(sent.fields.goal, 'Plan a dinner');
  assert.equal(sent.fields.context, 'Eight people\n\nLimits: Avoid peanuts', 'the answer is in the limits, after the marker');
  assert.equal(sent.pending.answer, null); assert.equal(nextStep(sent.fields, sent.chat), 'format', 'the next question is the format, not the title');
  assert.match(sent.fullPrompt, /Context and constraints: Eight people\n\nLimits: Avoid peanuts/);
  // the same sequence, but the member re-opens the question with Change on an earlier one first: the identity still travels with the text
  const change = reduce(sent, { type: 'setAnswer', gen: g, answer: { text: 'Plan a lunch', step: 'goal' } });
  const changed = reduce(change, { type: 'sendAnswer', gen: g }); assert.equal(changed.fields.goal, 'Plan a lunch'); assert.equal(changed.fields.title, ''); assert.equal(changed.fields.context, sent.fields.context);
});

test('Skip, a format chip and an over-long join are applied to the question they belong to; a stale Send or chip changes nothing', () => {
  let s = run({ type: 'startBlank' }); const g = gen(s);
  s = reduce(s, { type: 'answerStep', gen: g, step: 'goal', text: 'G' }); s = reduce(s, { type: 'answerStep', gen: g, step: 'context', text: 'C' });
  const skipped = reduce(s, { type: 'answerStep', gen: g, step: 'limits', text: '' });
  assert.equal(skipped.chat.limitsSkipped, true); assert.equal(skipped.fields.context, 'C'); assert.equal(skipped.work.revision, s.work.revision, 'skipping changes no text and adds no revision');
  assert.equal(nextStep(skipped.fields, skipped.chat), 'format');
  const fmt = reduce(skipped, { type: 'answerStep', gen: g, step: 'format', text: 'Comparison table' }); assert.equal(fmt.fields.format, 'Comparison table'); assert.equal(fmt.chat.formatDone, true); assert.equal(nextStep(fmt.fields, fmt.chat), 'title');
  const tooLong = reduce(s, { type: 'answerStep', gen: g, step: 'limits', text: 'x'.repeat(LIMITS.context) }); assert.equal(tooLong, s, 'an answer that would pass the field limit changes nothing');
  const pending = reduce(s, { type: 'setAnswer', gen: g, answer: { text: 'late', step: 'limits' } });
  const replaced = reduce(pending, { type: 'startBlank' });
  assert.equal(reduce(replaced, { type: 'sendAnswer', gen: g }), replaced, 'a Send meant for the old draft does nothing'); assert.equal(reduce(replaced, { type: 'answerStep', gen: g, step: 'goal', text: 'STALE' }), replaced);
  assert.deepEqual(replaced.chat, CHAT_FRESH, 'a new draft starts the exchange again');
});

test('"Getting there" reports which questions have an answer and length limits only, with a fixed note that it does not measure how well a prompt will work', () => {
  const blank = run({ type: 'startBlank' });
  const g0 = gettingThere(blank.fields, { limitsSkipped: false, formatDone: false });
  assert.deepEqual(g0.items.map((i) => [i.id, i.status]), [['goal', 'empty'], ['context', 'empty'], ['limits', 'empty'], ['format', 'empty'], ['title', 'empty']]); assert.equal(g0.allAnswered, false);
  const full = run({ type: 'startFromHack', hack: catalog });
  const g1 = gettingThere(full.fields, { limitsSkipped: true, formatDone: true });
  assert.deepEqual(g1.items.map((i) => i.status), ['filled', 'filled', 'skipped', 'filled', 'filled']); assert.equal(g1.allAnswered, true);
  const over = gettingThere({ ...full.fields, title: 'x'.repeat(LIMITS.title + 1) }, { limitsSkipped: true, formatDone: true });
  assert.equal(over.items[4]!.status, 'too_long'); assert.equal(over.allAnswered, false);
  assert.match(SCRIPTED_NOTE, /not live AI/); assert.match(SCRIPTED_NOTE, /not how well the prompt will work/);
  assert.doesNotMatch(JSON.stringify([g0, g1, over]), /quality|effective|success|score|strong|good|best|ready|verified/i);
});

test('Build with Hack: the panel has a conversation log, suggestion chips and an answer control, the prompt beside it, and says the questions are scripted', () => {
  const g = code('src/ui/experience/GuidedPanel.tsx');
  assert.match(g, /role="log" aria-live="polite" aria-label="Conversation with Hack"/); assert.match(g, /<label htmlFor="g-answer" className="sr-only">/);
  assert.match(g, /aria-label="Send answer"/); assert.match(g, /e\.key === 'Enter' && !e\.shiftKey/);
  assert.match(g, /SCRIPTED_NOTE\.split\(': '\)\[0\]/, 'the note is always shown; its long form is hidden on phones'); 
  assert.doesNotMatch(g, /useState\(/, 'the answer being typed is not component-local state');
  assert.match(g, /build-preview[\s\S]*build-chat[\s\S]*build-actions/, 'preview, chat and actions are all present');
  const css = src('src/ui/experience/experience.css');
  assert.match(css, /\.hx \.build\{display:grid;grid-template-columns:minmax\(0,1\.05fr\) minmax\(0,1fr\);grid-template-areas:"chat preview" "chat actions"/, 'desktop: the prompt beside the chat');
  assert.match(css, /grid-template-areas:"preview" "chat" "actions"/, 'narrow screens: the prompt above the chat');
});

test('providers: four fixed HTTPS home pages, nothing else in the URL', () => {
  assert.deepEqual(PROVIDERS.map((p) => p.name), ['ChatGPT', 'Claude', 'Gemini', 'Copilot']);
  assert.deepEqual(PROVIDERS.map((p) => p.href), ['https://chatgpt.com/', 'https://claude.ai/', 'https://gemini.google.com/', 'https://copilot.microsoft.com/']);
  for (const p of PROVIDERS) {
    const u = new URL(p.href);
    assert.equal(u.protocol, 'https:'); assert.equal(u.pathname, '/'); assert.equal(u.search, ''); assert.equal(u.hash, ''); assert.equal(u.username + u.password, ''); assert.equal(u.port, '');
  }
  assert.throws(() => { (PROVIDERS as unknown as { href: string }[])[0]!.href = 'x'; });
});

test('provider links: plain anchors with fixed hrefs, a new tab with noopener noreferrer, shown only after a confirmed copy of this exact prompt, never opened by script', () => {
  const pl = code('src/ui/experience/ProviderLinks.tsx');
  assert.match(pl, /href=\{p\.href\} target="_blank" rel="noopener noreferrer"/);
  assert.match(pl, /if \(text === '' \|\| !copiedExactly\(text\)\) return null;/);
  assert.doesNotMatch(pl, /onClick|window\.open|location|router|useEffect|fetch|setTimeout|encodeURI|\?\w+=|\$\{/);
  assert.match(code('src/ui/experience/LabScreen.tsx'), /<ProviderLinks text=\{state\.fullPrompt\.trim\(\)\} \/>/);
  assert.match(code('src/ui/experience/GuidedPanel.tsx'), /<ProviderLinks text=\{fullPrompt\.trim\(\)\} \/>/);
  assert.match(code('src/ui/experience/HackActions.tsx'), /copied \? <ProviderLinks text=\{p\.shown\} \/>/);
});

test('a copy confirmation is for exactly that text, revision and draft generation: an edit, a new draft or an account change ends it', () => {
  const s = run({ type: 'startFromHack', hack: catalog });
  const rec = { text: 'abc', revision: s.work.revision, epoch: s.work.epoch };
  assert.equal(copyStillValid(rec, 'abc', s.work.revision, s.work.epoch), true);
  assert.equal(copyStillValid(rec, 'abc ', s.work.revision, s.work.epoch), false, 'different text');
  const edited = reduce(s, { type: 'editSlot', field: 'goal', value: 'new' });
  assert.equal(copyStillValid(rec, 'abc', edited.work.revision, edited.work.epoch), false, 'an edit');
  const reverted = reduce(edited, { type: 'editSlot', field: 'goal', value: s.fields.goal });
  assert.equal(copyStillValid(rec, 'abc', reverted.work.revision, reverted.work.epoch), false, 'editing back does not restore the confirmation');
  assert.equal(copyStillValid(rec, 'abc', s.work.revision, reduce(s, { type: 'accountChanged' }).work.epoch), false, 'account change');
  assert.equal(copyStillValid(rec, 'abc', reduce(s, { type: 'startBlank' }).work.revision, reduce(s, { type: 'startBlank' }).work.epoch), false, 'a new draft');
  assert.equal(copyStillValid(null, 'abc', 0, 0), false);
  const p = code('src/ui/experience/ExperienceProvider.tsx');
  assert.match(p, /const clearCopyUi = useCallback\(\(\) => \{ setManualCopy\(null\); setToastText\(''\); setCopied\(null\); \}/);
});

test('clipboard completion: only a confirmed write records a copy (with its stamp); a blocked write does not; a late answer after an account change is dropped', async () => {
  const seen: { copied: unknown[]; manual: string | null } = { copied: [], manual: null };
  let release!: () => void;
  const flow = createCopyFlow({ write: (t) => (t === 'late' ? new Promise((r) => { release = () => r('copied'); }) : Promise.resolve(t === 'blocked' ? 'blocked' : 'copied')), onCopied: (t, st) => seen.copied.push([t, st]), onManual: (t) => { seen.manual = t; }, onClear: () => {} });
  await flow.copy('ok', { revision: 3, epoch: 1 }); assert.deepEqual(seen.copied, [['ok', { revision: 3, epoch: 1 }]]);
  await flow.copy('blocked', { revision: 3, epoch: 1 }); assert.equal(seen.copied.length, 1); assert.equal(seen.manual, 'blocked');
  const pending = flow.copy('late', { revision: 3, epoch: 1 }); flow.invalidate(); release(); await pending;
  assert.equal(seen.copied.length, 1, 'no confirmation is recorded for a copy that finished after the account changed');
});

test('the new files call no network, storage, window opener or model, and make no claim that AI wrote, checked, scored or approved anything', () => {
  for (const f of NEW_FILES) {
    const c = code(f);
    assert.doesNotMatch(c, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|window\.open|localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.clipboard|setTimeout|setInterval|Math\.random|Date\.now|new Date/, f);
    assert.doesNotMatch(c, /\b(AI|Hack|we) (wrote|checked|reviewed|scored|rated|graded|approved|verified|improved)\b|\boptimi[sz]ed\b|\bAI-generated\b|\bhigh[- ]quality\b/i, f);
  }
  assert.doesNotMatch(src('src/ui/experience/guided.ts') + src('src/ui/experience/GuidedPanel.tsx'), /\bready\b|\bperfect\b|\bexcellent\b|\bstrong prompt\b/i);
});

test('S3 touches no save path, schema, route, gate or font: the controller, document builder, API, modules, migrations and CSP are as accepted', () => {
  const ui = src('src/ui/experience/experience.css');
  assert.doesNotMatch(ui, /@import|@font-face|url\(\s*['"]?https?:/);
  assert.match(code('src/ui/experience/GuidedPanel.tsx'), /dispatch\(\{ type: 'sendAnswer', gen \}\)/);
  assert.doesNotMatch(code('src/ui/experience/GuidedPanel.tsx') + code('src/ui/experience/HighlightedPrompt.tsx'), /workApi|createWorkController|savePrompt|saveResult/);
});

// ---- round 2: unfinished input is protected, and bound to its draft generation -------------------------------------------------------------------------
const gen = (st: ExperienceState) => st.draftGen;
test('an unfinished guided answer survives a mode switch and a page change, counts as unsaved work, and asks before a replacement', () => {
  let s = run({ type: 'startBlank' });
  assert.equal(s.dirty, false);
  s = reduce(s, { type: 'setAnswer', gen: gen(s), answer: { text: 'Plan a trip to Lis', step: 'goal' } });
  assert.equal(s.pending.answer?.text, 'Plan a trip to Lis'); assert.equal(s.dirty, true, 'counts as unsaved work (the leave-page warning)'); assert.equal(hasPending(s.pending), true);
  for (const m of ['adapt', 'advanced', 'guided'] as const) s = reduce(s, { type: 'setEditMode', editMode: m });
  assert.equal(s.pending.answer?.text, 'Plan a trip to Lis', 'switching modes keeps it');
  assert.equal(requiresConfirmation(s, 'new'), true, 'starting a new prompt asks first'); assert.equal(requiresConfirmation(s, 'adapt'), true); assert.equal(requiresConfirmation(s, 'reset'), true);
  assert.equal(reduce(s, { type: 'accountChanged' }).pending.answer?.text, 'Plan a trip to Lis', 'an account change leaves the member\u2019s own typing alone');
  assert.equal(reduce(s, { type: 'setAnswer', gen: gen(s), answer: null }).dirty, false, 'sent or cleared: no longer unsaved');
  assert.equal(reduce(s, { type: 'setAnswer', gen: gen(s), answer: { text: '   ', step: 'goal' } }).dirty, false, 'blank space is not work');
  assert.equal(reduce(s, { type: 'setAnswer', gen: gen(s), answer: { text: 'x', step: 'goal' } }).pending.answer?.step, 'goal', 'a Change in progress is kept with its question');
});

test('replacing or resetting the draft clears every temporary editor; an Apply or Send that was meant for the old draft changes nothing', () => {
  const base = run({ type: 'startFromHack', hack: catalog }, { type: 'editSlot', field: 'goal', value: 'Mine' });
  const g0 = gen(base);
  let open = reduce(base, { type: 'setEditor', gen: g0, key: 'adapt', editor: { slot: 'goal', value: 'OLD EDITOR TEXT', base: 'Mine' } });
  open = reduce(open, { type: 'setAnswer', gen: g0, answer: { text: 'OLD ANSWER', step: 'goal' } });
  assert.equal(open.dirty, true);
  for (const [name, act] of [['reset', { type: 'resetDraft' }], ['new draft', { type: 'startBlank' }], ['another hack', { type: 'startFromHack', hack: DEMO_HACKS[0]! }]] as const) {
    const after = reduce(open, act as Action);
    assert.notEqual(gen(after), g0, name); assert.deepEqual(after.pending.editors, {}, `${name}: editors cleared`); assert.equal(after.pending.answer, null, `${name}: answer cleared`);
    // the stale callbacks of the old editors
    const stale = [{ type: 'applyEditor', gen: g0, key: 'adapt' }, { type: 'editSlot', field: 'goal', value: 'STALE', gen: g0 }, { type: 'setAnswer', gen: g0, answer: { text: 'STALE', step: 'goal' } }, { type: 'setEditor', gen: g0, key: 'adapt', editor: { slot: 'goal', value: 'STALE', base: '' } }] as Action[];
    const kept = stale.reduce(reduce, after); assert.equal(kept, after, `${name}: a stale Apply, Send or keystroke changes nothing`);
  }
  assert.notEqual(reduce(open, { type: 'loadSaved', at: 1, detail: { id: 'p', version: 1, title: 'T', goal: 'g', context: 'c', output_format: 'Concise summary', full_prompt: 'x', starting_prompt: '', origin_kind: 'scratch', origin_slug: null, origin_title: null, updated_at: '2026-10-20T12:00:00+00:00' } as unknown as PromptDetail }).draftGen, g0);
  // a save or an edit does not replace the draft: the editor stays
  assert.equal(reduce(open, { type: 'editSlot', field: 'title', value: 'T' }).pending.editors.adapt?.value, 'OLD EDITOR TEXT');
});

test('Apply uses the editor text held in the shared state, once, as one revision; an editor that is not open, or was opened for another generation, applies nothing', () => {
  const base = run({ type: 'startFromHack', hack: catalog });
  const opened = reduce(base, { type: 'setEditor', gen: gen(base), key: 'adapt', editor: { slot: 'goal', value: 'Applied once', base: base.fields.goal } });
  const done = reduce(opened, { type: 'applyEditor', gen: gen(opened), key: 'adapt' });
  assert.equal(done.fields.goal, 'Applied once'); assert.equal(done.work.revision, 1); assert.deepEqual(done.pending.editors, {}); assert.match(done.fullPrompt, /Objective: Applied once/); assert.ok(done.fullPrompt.endsWith(METHOD), 'method kept');
  assert.equal(reduce(done, { type: 'applyEditor', gen: gen(done), key: 'adapt' }), done, 'a second Apply has nothing to apply');
  const whole = reduce(opened, { type: 'setEditor', gen: gen(opened), key: 'adapt', editor: { slot: 'all', value: 'WHOLE', base: base.fullPrompt } });
  assert.equal(reduce(whole, { type: 'applyEditor', gen: gen(whole), key: 'adapt' }).fullPrompt, 'WHOLE');
  assert.equal(reduce(base, { type: 'applyEditor', gen: gen(base), key: 'adapt' }), base);
});

test('the Hack page: the first Apply starts the draft only if the draft it was opened against is still the current one; the editor being applied is not "unsaved work that would be replaced"', () => {
  const clean = run({ type: 'startBlank' });
  const key = 'hack:catalog:meal-plan';
  const withEditor = reduce(clean, { type: 'setEditor', gen: gen(clean), key, editor: { slot: 'goal', value: 'New objective', base: catalog.goal } });
  assert.equal(withEditor.dirty, true);
  assert.equal(requiresConfirmation(withEditor, 'adapt'), true);
  assert.equal(requiresConfirmation(withEditor, 'adapt', { exceptEditor: key }), false, 'only this editor is pending: nothing would be lost');
  const dirtyOther = reduce(withEditor, { type: 'editSlot', field: 'title', value: 'Other draft' });
  assert.equal(requiresConfirmation(dirtyOther, 'adapt', { exceptEditor: key }), true, 'an unsaved draft still needs the guard');
  const g = gen(withEditor);
  const started = reduce(withEditor, { type: 'startFromHack', hack: catalog, apply: { slot: 'goal', value: 'New objective' }, expectGen: g });
  assert.equal(started.fields.goal, 'New objective'); assert.equal(started.work.revision, 1); assert.deepEqual(started.pending.editors, {}); assert.equal(started.origin?.key, 'meal-plan');
  const replacedMeanwhile = reduce(withEditor, { type: 'startBlank' });
  assert.equal(reduce(replacedMeanwhile, { type: 'startFromHack', hack: catalog, apply: { slot: 'goal', value: 'STALE' }, expectGen: g }), replacedMeanwhile, 'the draft was replaced while the guard was open: nothing happens');
});

test('the temporary editors hold no local text: the Lab and Hack page pass them through the shared state, and Apply carries the draft generation', () => {
  const hp = code('src/ui/experience/HighlightedPrompt.tsx');
  assert.doesNotMatch(hp, /useState<string>|setValue|const \[value/); assert.match(hp, /const \{ editor \} = p;/);
  assert.match(code('src/ui/experience/LabScreen.tsx'), /dispatch\(\{ type: 'applyEditor', gen: state\.draftGen, key: 'adapt' \}\)/);
  assert.match(code('src/ui/experience/LabScreen.tsx'), /dispatch\(\{ type: 'setEditor', gen: state\.draftGen, key: 'adapt', editor \}\)/);
  assert.match(code('src/ui/experience/DetailScreen.tsx'), /dispatch\(\{ type: 'setEditor', gen, key: editorKey, editor \}\)/);
  const gp = code('src/ui/experience/GuidedPanel.tsx');
  assert.match(gp, /dispatch\(\{ type: 'setAnswer', gen, answer: \{ text: t, step: id \} \}\)/); assert.match(gp, /dispatch\(\{ type: 'sendAnswer', gen \}\)/); assert.match(gp, /dispatch\(\{ type: 'answerStep', gen, step: 'format', text: label \}\)/); assert.doesNotMatch(gp, /defaultFlags|useState|onFlags|StoredFlags/, 'no component-local or inferred completion state');
});

test('phone layout rules: Copy stays above the bottom navigation, the safe area and the keyboard; the exchange is one screen (prompt on top, conversation scrolling, answer box at the bottom); progress is compact', () => {
  const css = src('src/ui/experience/experience.css');
  assert.match(css, /\.hx\{--bnav:calc\(64px \+ env\(safe-area-inset-bottom,0px\)\);--below:var\(--bnav\)\}/);
  assert.match(css, /:root\.kb-open \.hx\{--below:var\(--kb\)\}/); assert.match(css, /:root\.kb-open \.hx dialog\.hl-editor\[open\]\{bottom:var\(--kb,0px\);padding-bottom:calc\(24px \+ 64px\)\}/, 'the highlight sheet clears the keyboard and its accessory bar'); assert.match(css, /:root\.kb-open \.hx \.mobile-nav\{display:none\}/);
  assert.match(css, /\.hx \.copy-bar\{display:grid;grid-template-columns:minmax\(0,1fr\);gap:6px;position:fixed;left:0;right:0;bottom:var\(--below\);z-index:25;/);
  assert.match(css, /\.hx \.build-main\{display:flex;flex-direction:column;gap:8px;height:calc\(100vh - var\(--below\) - 28px\);height:calc\(100dvh - var\(--below\) - 28px\);/);
  assert.match(css, /\.hx \.build-chat\{flex:1;min-height:0;display:flex;flex-direction:column\}/); assert.match(css, /\.hx \.bubbles\{flex:1;min-height:0;max-height:none;/);
  assert.match(css, /\.hx \.build-preview \.parts\{flex-wrap:nowrap;overflow-x:auto;/); assert.match(css, /\.hx \.hl-preview\{max-height:84px;/);
  const ha = code('src/ui/experience/HackActions.tsx'); assert.match(ha, /<div className="copy-bar">/); assert.match(ha, /id="hack-copy-bar"/); assert.match(ha, /useKeyboardInset\(\)/);
  const gp = code('src/ui/experience/GuidedPanel.tsx');
  assert.match(gp, /Question \$\{Math\.min\(count, CHAT_STEPS\.length\)\} of \$\{CHAT_STEPS\.length\}/, 'the real five-question count');
  assert.match(gp, /scrollIntoView\(\{ block: 'start' \}\)/, 'the exchange is brought into view on a phone'); assert.match(gp, /const toBottom = \(\) => \{ const l = log\.current; if \(l\) l\.scrollTop = l\.scrollHeight; \};/, 'the latest message stays in view when the keyboard opens');
  // Keyboard open on a phone: the exchange fits the visible area, the preview steps aside, and the exchange is a panel pinned to the visible area (so the current question and the answer box show together).
  assert.match(css, /:root\.kb-open \.hx \.build-main\{position:fixed;left:0;right:0;top:var\(--vvt,0px\);height:var\(--vvh\);/); assert.match(css, /:root\.kb-open \.hx \.build-preview\{display:none\}/);
  assert.match(code('src/ui/experience/useKeyboardInset.ts'), /setProperty\('--vvh'/); assert.match(code('src/ui/experience/useKeyboardInset.ts'), /setProperty\('--vvt'/); assert.match(gp, /useKeyboardInset\(\(\) => \{ toBottom\(\); requestAnimationFrame\(\(\) => \{ toBottom\(\); requestAnimationFrame\(toBottom\); \}\); \}\)/, 'scrolled again on the frames after the keyboard changes the layout (WebKit resets the scroller)'); assert.match(gp, /new ResizeObserver\(\(\) => \{ l\.scrollTop = l\.scrollHeight; requestAnimationFrame\(/, 'the newest message stays in view through every height change'); assert.doesNotMatch(gp, /m\.scrollIntoView/, 'no reliance on the browser keeping a scroll position');
  assert.equal(CHAT_STEPS.length, 5);
});

test('the keyboard inset: only a large difference between the layout and the visual viewport counts as a keyboard', () => {
  assert.equal(keyboardInset(800, 800, 0), 0); assert.equal(keyboardInset(800, 740, 0), 0, 'a browser bar is not a keyboard');
  assert.equal(keyboardInset(800, 480, 0), 320); assert.equal(keyboardInset(800, 450, 30), 320, 'scrolled visual viewport');
  // Real iOS Safari (iPhone 17 simulator, iOS 26.3): the visual viewport is panned by the keyboard's height, so nothing is covered at the layout bottom, but the keyboard IS open.
  assert.equal(keyboardInset(800, 480, 320), 0); assert.equal(keyboardOpen(800, 480), true, 'open although panned'); assert.equal(keyboardOpen(800, 740), false, 'a browser bar is not a keyboard'); assert.equal(keyboardOpen(800, 800), false);
  assert.match(code('src/ui/experience/useKeyboardInset.ts'), /root\.classList\.toggle\('kb-open', keyboardOpen\(window\.innerHeight, vv\.height\)\)/);
});
