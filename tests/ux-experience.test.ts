// The experience's temporary state: overwrite confirmations, guarded Detail navigation, demo/catalog separation, deterministic prompt rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenDetail, detailHref, initialState, NO_ORIGINAL, reduce, requiresConfirmation, type Action, type ExperienceState } from '../src/ui/experience/state.ts';
import { DEMO_HACKS, findDemoHack } from '../src/ui/experience/demo-hacks.ts';
import { composePrompt, hackFromCatalog, reflectionText } from '../src/ui/experience/prompt.ts';
import { safeHref } from '../src/ui/experience/safe-href.ts';

const run = (...as: Action[]): ExperienceState => as.reduce(reduce, initialState);
const demo = DEMO_HACKS[0];

test('Detail navigation is disabled until a hack is selected, and after Create a Prompt', () => {
  assert.equal(canOpenDetail(initialState), false); assert.equal(detailHref(initialState), null);
  const s = run({ type: 'view', hack: demo }); assert.equal(canOpenDetail(s), true); assert.equal(detailHref(s), demo.href);
  assert.equal(canOpenDetail(reduce(s, { type: 'startBlank' })), false);
});
test('adapting a hack seeds the draft; no confirmation while it is untouched, confirmation once edited', () => {
  const s = run({ type: 'startFromHack', hack: demo });
  assert.equal(s.fullPrompt, demo.starterPrompt); assert.equal(s.startingPrompt, demo.starterPrompt); assert.equal(requiresConfirmation(s, 'adapt'), false);
  const e = reduce(s, { type: 'editPrompt', value: 'mine' });
  for (const w of ['adapt', 'new', 'reset'] as const) assert.equal(requiresConfirmation(e, w), true, w);
});
test('regenerate confirms whenever it would replace a non-empty prompt, and composes deterministically', () => {
  const s = run({ type: 'startBlank' }); assert.equal(requiresConfirmation(s, 'regenerate'), false);
  const f = reduce(reduce(s, { type: 'editField', field: 'goal', value: 'Plan a trip' }), { type: 'regenerate' });
  assert.equal(f.fullPrompt, composePrompt(f.fields)); assert.equal(composePrompt(f.fields), composePrompt({ ...f.fields }));
  assert.equal(requiresConfirmation(f, 'regenerate'), true);
});
test('reset returns to the origin hack, or to blank for a scratch draft', () => {
  const a = run({ type: 'startFromHack', hack: demo }, { type: 'editPrompt', value: 'x' }, { type: 'resetDraft' });
  assert.equal(a.fullPrompt, demo.starterPrompt); assert.equal(a.dirty, false);
  const b = run({ type: 'startBlank' }, { type: 'editPrompt', value: 'x' }, { type: 'resetDraft' });
  assert.equal(b.fullPrompt, ''); assert.equal(b.startingPrompt, NO_ORIGINAL);
});
test('reflection edits are tracked as unsaved work and reset on a new draft', () => {
  const s = run({ type: 'startFromHack', hack: demo }, { type: 'reflect', field: 'text', value: 'it worked' });
  assert.equal(s.dirty, true); assert.equal(reduce(s, { type: 'startBlank' }).reflection.text, '');
});
test('demo hacks are labelled, local and distinct from catalog hacks', () => {
  assert.equal(DEMO_HACKS.length, 3);
  for (const h of DEMO_HACKS) { assert.equal(h.source, 'demo'); assert.match(h.href, /^\/spark\/demo\//); assert.equal(findDemoHack(h.key), h); }
  assert.equal(findDemoHack('nope'), undefined);
  const c = hackFromCatalog({ slug: 'x-y', title: 'X', summary: 'S', category: { slug: 'home', name: 'Home' }, outcome: 'O', limitations: 'L', requirements: [], materials: [], steps: [{ position: 1, body: 'Do it' }] } as never);
  assert.equal(c.source, 'catalog'); assert.equal(c.href, '/spark/catalog/x-y'); assert.match(c.starterPrompt, /Do it/);
});
test('reflection text and safeHref', () => {
  assert.match(reflectionText('T', 'yes', 'good', 'more'), /good/);
  assert.equal(safeHref('https://example.com/a'), 'https://example.com/a');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'https://u:p@example.com', '//x', 'notaurl', null, '']) assert.equal(safeHref(bad as never), null);
});

// ---- catalog list state: the server result is the source of truth; stale "Load more" answers never enter a newer result
import { initList, reduceList } from '../src/ui/experience/catalog-state.ts';
const card = (slug: string, cat = 'home') => ({ slug, title: slug, summary: '', category: { slug: cat, name: cat }, difficulty: null, time_minutes: { min: null, max: null }, cost: { min_cents: null, max_cents: null, currency: null }, ai_requirement: null });
const cur = (slug: string) => ({ published_at: '2026-01-01T00:00:00+00:00', slug });
const view = (renderId: string, cat: string | null, slugs: string[], next: string | null = null) => ({ renderId, status: 'ok' as const, items: slugs.map((s) => card(s, cat ?? 'all')), nextCursor: next ? cur(next) : null, categories: [], activeCategory: cat });

test('a new server result resets items, cursor, busy and pagination error; the same result changes nothing', () => {
  let s = initList(view('r1', null, ['a', 'b'], 'b'));
  s = reduceList(s, { type: 'start' }); s = reduceList(s, { type: 'fail', renderId: 'r1' });
  assert.equal(s.moreError, true);
  assert.equal(reduceList(s, { type: 'sync', view: view('r1', null, ['a', 'b'], 'b') }), s);
  const t = reduceList(s, { type: 'sync', view: view('r2', 'money', ['m1'], null) });
  assert.deepEqual(t.items.map((i) => i.slug), ['m1']); assert.equal(t.cursor, null); assert.equal(t.moreError, false); assert.equal(t.busy, false);
});
test('a Load more answer for an older result is discarded (no cards or cursor from the previous category)', () => {
  let s = initList(view('r1', null, ['a'], 'a'));
  s = reduceList(s, { type: 'start' });                                 // request issued under r1
  s = reduceList(s, { type: 'sync', view: view('r2', 'money', ['m1'], 'm1') }); // category changed meanwhile
  const after = reduceList(s, { type: 'done', renderId: 'r1', items: [card('x')], cursor: cur('x') });
  assert.deepEqual(after.items.map((i) => i.slug), ['m1']); assert.equal(after.cursor?.slug, 'm1');
  assert.equal(reduceList(s, { type: 'fail', renderId: 'r1' }).moreError, false);
  assert.equal(s.busy, false, 'the new result is not stuck in a loading state');
});
test('a current Load more answer appends without duplicates and clears busy', () => {
  let s = initList(view('r1', null, ['a', 'b'], 'b')); s = reduceList(s, { type: 'start' });
  s = reduceList(s, { type: 'done', renderId: 'r1', items: [card('b'), card('c')], cursor: null });
  assert.deepEqual(s.items.map((i) => i.slug), ['a', 'b', 'c']); assert.equal(s.cursor, null); assert.equal(s.busy, false);
});
