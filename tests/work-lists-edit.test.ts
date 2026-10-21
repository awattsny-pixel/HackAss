// PX-3c correction pass: stale list answers, account invalidation, and the result-detail editor's revision protection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialList, reduceList, visibleList, type ListState } from '../src/ui/work/list-state.ts';
import { editDirty, initialEdit, reduceEdit, sameWords, type EditAction, type EditState } from '../src/ui/work/result-edit.ts';
import { initialSession, reduceSession } from '../src/ui/account/session-state.ts';
import type { ResultDetail } from '../src/modules/mywork/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const code = (f: string) => readFileSync(join(root, f), 'utf8').replace(/\/\/.*$/gm, '');
type Row = { id: string; t: string }; type Cur = { id: string };
const reduce = (s: ListState<Row, Cur>, a: Parameters<typeof reduceList<Row, Cur>>[1]) => reduceList<Row, Cur>(s, a);
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, t: id }));

test('CORRECTION 1: a held "Load more" answer from the OLD filter never enters the new view (rows and cursor are dropped whole)', () => {
  let s = initialList<Row, Cur>();
  s = reduce(s, { type: 'load', gen: 1, epoch: 0 }); s = reduce(s, { type: 'loaded', gen: 1, items: rows('a1', 'a2'), next: { id: 'a2' } });
  s = reduce(s, { type: 'more', gen: 1 });                                                // "Load more" under filter A is in flight…
  s = reduce(s, { type: 'load', gen: 2, epoch: 0 });                                      // …the member changes the filter: a new view
  assert.equal(s.s, 'loading'); s = reduce(s, { type: 'loaded', gen: 2, items: rows('b1'), next: null });
  const released = reduce(s, { type: 'moreLoaded', gen: 1, items: rows('a3', 'a4'), next: { id: 'a4' } });   // …now the old answer is released
  assert.equal(released, s, 'ignored entirely'); assert.deepEqual((released as { items: Row[] }).items.map((i) => i.id), ['b1']); assert.equal((released as { next: Cur | null }).next, null, 'the old cursor did not arrive either');
  assert.equal(reduce(s, { type: 'moreFailed', gen: 1 }), s); assert.equal(reduce(s, { type: 'loaded', gen: 1, items: rows('zz'), next: null }), s); assert.equal(reduce(s, { type: 'failed', gen: 1, kind: 'x' }), s);
  // a load that is older than the current one cannot go back in time
  assert.equal(reduce(s, { type: 'load', gen: 1, epoch: 0 }), s);
});
test('list: normal paging appends without duplicates; a failed "more" is retryable; one "more" at a time', () => {
  let s = initialList<Row, Cur>(); s = reduce(s, { type: 'load', gen: 1, epoch: 0 }); s = reduce(s, { type: 'loaded', gen: 1, items: rows('1', '2'), next: { id: '2' } });
  s = reduce(s, { type: 'more', gen: 1 }); const again = reduce(s, { type: 'more', gen: 1 }); assert.equal(again, s, 'a second "more" while loading is ignored');
  s = reduce(s, { type: 'moreFailed', gen: 1 }); assert.equal((s as { more: string }).more, 'error'); s = reduce(s, { type: 'more', gen: 1 }); s = reduce(s, { type: 'moreLoaded', gen: 1, items: rows('2', '3'), next: null });
  assert.deepEqual((s as { items: Row[] }).items.map((i) => i.id), ['1', '2', '3']); assert.equal((s as { next: Cur | null }).next, null);
  assert.equal(reduce(s, { type: 'more', gen: 1 }), s, 'no cursor, nothing to load');
});
test('CORRECTION 1: nothing loaded under another account epoch is ever shown; sign-out, sign-in and a signed-out check advance the epoch', () => {
  const s = reduce(reduce(initialList<Row, Cur>(), { type: 'load', gen: 1, epoch: 0 }), { type: 'loaded', gen: 1, items: rows('private-1'), next: null });
  assert.equal(visibleList(s, 0).s, 'ready'); const shown = visibleList(s, 1); assert.equal(shown.s, 'loading', 'under the next epoch the old rows are hidden at once'); assert.ok(!JSON.stringify(shown).includes('private-1'));
  let ss = reduceSession(initialSession, { type: 'result', gen: 0, result: 'member', at: 1 }); assert.equal(ss.accountEpoch, 0, 'the first check does not count as a change');
  ss = reduceSession(ss, { type: 'result', gen: 0, result: 'member', at: 2 }); assert.equal(ss.accountEpoch, 0, 'member → member');
  ss = reduceSession(ss, { type: 'result', gen: 0, result: 'unavailable', at: 3 }); assert.equal(ss.accountEpoch, 0, 'an outage is not a sign-out');
  ss = reduceSession(ss, { type: 'signed_out', gen: 1, at: 4 }); assert.equal(ss.accountEpoch, 1, 'sign-out');
  ss = reduceSession(ss, { type: 'signed_in', gen: 2, at: 5 }); assert.equal(ss.accountEpoch, 2, 'sign-in (possibly another account)');
  let m = reduceSession(reduceSession(initialSession, { type: 'result', gen: 0, result: 'member', at: 1 }), { type: 'result', gen: 0, result: 'anonymous', at: 2 }); assert.equal(m.accountEpoch, 1, 'a check that finds the member signed out');
  m = reduceSession(m, { type: 'result', gen: 0, result: 'member', at: 3 }); assert.equal(m.accountEpoch, 2, 'signed in again elsewhere');
  const anon = reduceSession(reduceSession(initialSession, { type: 'result', gen: 0, result: 'anonymous', at: 1 }), { type: 'result', gen: 0, result: 'anonymous', at: 2 }); assert.equal(anon.accountEpoch, 0, 'anonymous → anonymous');
});

// ---- result-detail editor ------------------------------------------------------------------------------------------------------------------------------
const detail = (o: Partial<ResultDetail> = {}): ResultDetail => ({ id: 'r1', version: 1, outcome: 'yes', reflection: 'saved words', next_change: 'next', attempted_prompt: 'p', starting_prompt: 's', title: 'T', prompt_version: 1, prompt_id: 'p1', origin_kind: 'scratch', origin_slug: null, origin_title: null, created_at: 'x', updated_at: 'x', ...o });
const run = (s: EditState, ...as: EditAction[]) => as.reduce(reduceEdit, s);
const opened = () => run(initialEdit, { type: 'loaded', detail: detail() }, { type: 'open' });

test('CORRECTION 4: TYPING DURING A SAVE keeps the form open with the newer words, unsaved; the saved copy is exactly what was submitted', () => {
  let s = run(opened(), { type: 'edit', field: 'reflection', value: 'submitted words' }, { type: 'saveBegin', token: 't1' });
  s = run(s, { type: 'edit', field: 'reflection', value: 'submitted words + typed during the save' });
  s = run(s, { type: 'saveDone', token: 't1', version: 2 });
  assert.ok(s.form, 'the form must NOT close: there is newer typing'); assert.equal(s.form!.reflection, 'submitted words + typed during the save'); assert.equal(s.base?.reflection, 'submitted words'); assert.equal(s.base?.version, 2);
  assert.equal(editDirty(s), true, 'the leave guard stays on'); assert.equal(s.inFlight, null);
  // no typing in between → the form closes and nothing is dirty
  const c = run(opened(), { type: 'edit', field: 'reflection', value: 'x' }, { type: 'saveBegin', token: 't' }, { type: 'saveDone', token: 't', version: 2 }); assert.equal(c.form, null); assert.equal(editDirty(c), false); assert.equal(c.base?.reflection, 'x');
});
test('editor: failures keep everything; foreign or stale answers are ignored; only one save at a time; conflicts need an explicit choice', () => {
  const s = run(opened(), { type: 'edit', field: 'reflection', value: 'mine' }, { type: 'saveBegin', token: 'a' });
  assert.equal(run(s, { type: 'saveBegin', token: 'b' }), s, 'one save at a time'); assert.equal(run(s, { type: 'saveDone', token: 'zzz', version: 9 }), s, 'a foreign answer is ignored'); assert.equal(run(s, { type: 'saveFail', token: 'zzz', problem: 'x' }), s);
  const failed = run(s, { type: 'saveFail', token: 'a', problem: 'Saving is unavailable. Your edits are still in the form.' }); assert.equal(failed.form?.reflection, 'mine'); assert.equal(failed.inFlight, null); assert.equal(editDirty(failed), true); assert.equal(failed.base?.version, 1);
  const server = detail({ version: 3, reflection: 'changed elsewhere' }); const conflicted = run(s, { type: 'conflict', token: 'a', server }); assert.equal(conflicted.conflict?.version, 3); assert.equal(conflicted.form?.reflection, 'mine', 'my words are untouched'); assert.equal(conflicted.base?.version, 1, 'the saved copy is not silently adopted');
  const loaded = run(conflicted, { type: 'loadServer', server }); assert.equal(loaded.form?.reflection, 'changed elsewhere'); assert.equal(loaded.base?.version, 3); assert.equal(loaded.conflict, null); assert.equal(editDirty(loaded), false);
  const adopted = run(conflicted, { type: 'adoptVersion', version: 3 }); assert.equal(adopted.base?.version, 3); assert.equal(adopted.form?.reflection, 'mine'); assert.equal(adopted.conflict, null);
});
test('editor: cancel and reset discard; a reload of the same result keeps an open editor\'s edits; another account clears everything', () => {
  const edited = run(opened(), { type: 'edit', field: 'next', value: 'new next' });
  assert.equal(run(edited, { type: 'cancel' }).form, null); assert.equal(editDirty(run(edited, { type: 'cancel' })), false);
  const reloaded = run(edited, { type: 'loaded', detail: detail({ version: 1, reflection: 'saved words' }) }); assert.equal(reloaded.form?.next, 'new next', 'edits survive a refresh of the saved copy'); assert.equal(reloaded.base?.version, 1);
  assert.deepEqual(run(edited, { type: 'reset' }), initialEdit); assert.equal(sameWords({ outcome: 'a', reflection: 'b', next: 'c' }, { outcome: 'a', reflection: 'b', next: 'c' }), true);
  assert.equal(editDirty(opened()), false, 'an opened but untouched editor is not dirty'); assert.equal(run(initialEdit, { type: 'edit', field: 'next', value: 'x' }), initialEdit, 'no form, no edit');
});

// ---- source guarantees --------------------------------------------------------------------------------------------------------------------------------
test('source: lists, details and export are scoped to the account epoch; stale list answers are dropped by generation; the editor is guarded', () => {
  for (const f of ['MyPromptsScreen', 'MyResultsScreen']) { const c = code(`src/ui/work/${f}.tsx`); assert.match(c, /visibleList\(raw, epoch\)/, f); assert.match(c, /accountEpoch/, f); assert.match(c, /dispatch\(\{ type: 'load', gen: g, epoch \}\)/, f); assert.match(c, /if \(signal\?\.aborted\) return;/, `${f}: an aborted "more" is dropped`); assert.doesNotMatch(c, /setView\(\(v\)/, `${f}: no functional append to whatever view is current`); }
  for (const f of ['PromptDetailScreen', 'ResultDetailScreen']) assert.match(code(`src/ui/work/${f}.tsx`), /raw\.epoch === epoch \? raw : \{ s: 'loading', epoch \}/, f);
  assert.match(code('src/ui/work/ExportPanel.tsx'), /accountEpoch/);
  const rd = code('src/ui/work/ResultDetailScreen.tsx'); assert.match(rd, /useUnsavedGuard\(editDirty\(ed\)/); assert.match(rd, /confirm\(\{ title: 'Load the saved version\?'/); assert.match(rd, /confirm\(\{ title: 'Discard your edits\?'/); assert.doesNotMatch(rd, /setForm\(/, 'the editor state lives in the reducer only');
  const g = code('src/ui/work/unsaved-guard.ts'); assert.match(g, /beforeunload/); assert.match(g, /closest\?\.\('a\[href\]'\)/); assert.match(g, /cancelLabel: 'Stay and keep editing'/);
  assert.match(code('app/(experience)/layout.tsx'), /<SessionProvider><AccountBoundary \/>/); assert.match(code('src/ui/work/AccountBoundary.tsx'), /type: 'accountChanged'/);
  const ctl = code('src/ui/work/controller.ts'); assert.match(ctl, /fresh: true/); assert.match(ctl, /reconcileBoth\(c, promptDoc\.doc, rdoc\.doc, r\.data\.prompt\.id, r\.data\.result\.id\)/); assert.match(ctl, /type: 'adoptVersion', target: c\.target, id: c\.server\.id, version: c\.server\.version/);
});

// ---- shared in-memory editor state (Back → Forward) -------------------------------------------------------------------------------------------------------
import { editFor, editKey, emptyEdits, reduceEditMap, type EditMap, type EditMapAction } from '../src/ui/work/edit-store.ts';
import { createStore } from '../src/ui/experience/store.ts';
const apply = (m: EditMap, key: string, action: EditAction) => reduceEditMap(m, { type: 'apply', key, action });

test('BACK → FORWARD: unsaved result edits live in shared memory keyed by account epoch and result id, so a re-mounted screen finds them; other results and other epochs are separate', () => {
  const k = editKey(0, 'r1'); let m: EditMap = emptyEdits;
  m = apply(m, k, { type: 'loaded', detail: detail() }); m = apply(m, k, { type: 'open' }); m = apply(m, k, { type: 'edit', field: 'reflection', value: 'unsaved words typed before Back' });
  // the screen unmounts (Back) and mounts again (Forward): it simply reads the same key
  const restored = editFor(m, k); assert.equal(restored.form?.reflection, 'unsaved words typed before Back'); assert.equal(editDirty(restored), true);
  // a reload of the saved copy on return keeps the open editor
  m = apply(m, k, { type: 'loaded', detail: detail({ version: 1 }) }); assert.equal(editFor(m, k).form?.reflection, 'unsaved words typed before Back'); assert.equal(editFor(m, k).base?.version, 1, 'a refresh of the SAME version keeps the editor');
  assert.equal(editFor(m, editKey(0, 'r2')), initialEdit, 'another result is independent'); assert.equal(editFor(m, editKey(1, 'r1')), initialEdit, 'another account epoch cannot reach it');
  // an in-flight save survives the screen being gone, and its answer lands in the same shared state
  m = apply(m, k, { type: 'saveBegin', token: 't' }); m = apply(m, k, { type: 'saveDone', token: 't', version: 3 }); assert.equal(editFor(m, k).base?.reflection, 'unsaved words typed before Back'); assert.equal(editFor(m, k).form, null);
});
test('the shared editor state is CLEARED on sign-out / account change and on an explicit discard; unchanged actions keep identity', () => {
  const k = editKey(2, 'r1'); const m: EditMap = apply(apply(apply(emptyEdits, k, { type: 'loaded', detail: detail() }), k, { type: 'open' }), k, { type: 'edit', field: 'next', value: 'secret next step' });
  assert.ok(JSON.stringify(m).includes('secret next step'));
  const cleared = reduceEditMap(m, { type: 'clearAll' }); assert.deepEqual(cleared, {}); assert.ok(!JSON.stringify(cleared).includes('secret next step')); assert.equal(reduceEditMap(cleared, { type: 'clearAll' }), cleared, 'clearing nothing changes nothing');
  const discarded = apply(m, k, { type: 'reset' }); assert.equal(editFor(discarded, k), initialEdit); assert.deepEqual(Object.keys(discarded), []);
  assert.equal(apply(m, k, { type: 'saveDone', token: 'nope', version: 9 }), m, 'a foreign answer returns the same map');
  // through a real store, as the provider holds it
  const store = createStore<EditMap, EditMapAction>(emptyEdits, reduceEditMap); let notified = 0; const off = store.subscribe(() => { notified++; });
  store.dispatch({ type: 'apply', key: k, action: { type: 'loaded', detail: detail() } }); store.dispatch({ type: 'apply', key: k, action: { type: 'open' } }); store.dispatch({ type: 'apply', key: k, action: { type: 'edit', field: 'reflection', value: 'kept' } });
  assert.equal(editFor(store.get(), k).form?.reflection, 'kept'); store.dispatch({ type: 'clearAll' }); assert.deepEqual(store.get(), {}); assert.ok(notified >= 4); off();
});
test('source: the result editor uses the shared store (no component-local editor state), is cleared by the account boundary, and nothing touches browser storage', () => {
  const rd = code('src/ui/work/ResultDetailScreen.tsx');
  assert.match(rd, /editKey\(epoch, id\)/); assert.match(rd, /useSyncExternalStore\(edits\.subscribe, edits\.get, edits\.get\)/); assert.doesNotMatch(rd, /useReducer|useState<EditState|reduceEdit\(/, 'no component-local editor state');
  assert.doesNotMatch(rd, /edit\(\{ type: 'reset' \}\);\s*const t = setTimeout/, 'a screen mount must not wipe restored edits');
  assert.match(code('src/ui/work/AccountBoundary.tsx'), /edits\.dispatch\(\{ type: 'clearAll' \}\)/); assert.match(code('src/ui/experience/ExperienceProvider.tsx'), /createStore<EditMap, EditMapAction>\(emptyEdits, reduceEditMap\)/);
  assert.match(code('src/ui/work/unsaved-guard.ts'), /onDiscard\?\.\(\);\s*router\.push/, 'only an explicit "Leave and discard" removes the edits');
  for (const f of ['edit-store.ts', 'result-edit.ts', 'unsaved-guard.ts']) assert.doesNotMatch(code(`src/ui/work/${f}`), /localStorage|sessionStorage|indexedDB|document\.cookie/, f);
});

test('CONCURRENCY ON RETURN: unsaved edits made against version 1 keep version 1 when the saved result has moved to version 2; Save is therefore a conflict until the member chooses', () => {
  const k = editKey(0, 'r1'); let m: EditMap = emptyEdits;
  m = apply(m, k, { type: 'loaded', detail: detail({ version: 1 }) }); m = apply(m, k, { type: 'open' }); m = apply(m, k, { type: 'edit', field: 'reflection', value: 'MY UNSAVED WORDS (based on v1)' });
  // another tab saves version 2; the member returns with Forward and the screen refreshes the saved copy
  const theirs = detail({ version: 2, reflection: 'THE OTHER TAB\'S WORDS' });
  m = apply(m, k, { type: 'loaded', detail: theirs });
  const s = editFor(m, k);
  assert.equal(s.base?.version, 1, 'the concurrency version of the edits is NOT moved forward'); assert.equal(s.base?.reflection, 'saved words', 'nor is the base content replaced');
  assert.equal(s.form?.reflection, 'MY UNSAVED WORDS (based on v1)', 'the restored words are intact'); assert.equal(s.conflict?.version, 2, 'the newer saved version is shown as an explicit conflict'); assert.equal(s.conflict?.reflection, 'THE OTHER TAB\'S WORDS'); assert.equal(editDirty(s), true);
  // what a Save would send is still version 1 (the server then answers 409 and the conflict stays); nothing adopted the newer version
  const sent = { expected_version: s.base!.version }; assert.equal(sent.expected_version, 1);
  // refreshing again, or a save answered with a conflict, does not clear it
  m = apply(m, k, { type: 'loaded', detail: theirs }); assert.equal(editFor(m, k).conflict?.version, 2); assert.equal(editFor(m, k).base?.version, 1);
  const begun = apply(m, k, { type: 'saveBegin', token: 't' }); const conflicted = apply(begun, k, { type: 'conflict', token: 't', server: theirs }); assert.equal(editFor(conflicted, k).base?.version, 1); assert.equal(editFor(conflicted, k).conflict?.version, 2);
  // only an explicit choice adopts the newer version: overwrite builds on it (words kept); load replaces the words
  const overwrite = apply(m, k, { type: 'adoptVersion', version: 2 }); assert.equal(editFor(overwrite, k).base?.version, 2); assert.equal(editFor(overwrite, k).form?.reflection, 'MY UNSAVED WORDS (based on v1)'); assert.equal(editFor(overwrite, k).conflict, null);
  const load = apply(m, k, { type: 'loadServer', server: theirs }); assert.equal(editFor(load, k).form?.reflection, 'THE OTHER TAB\'S WORDS'); assert.equal(editFor(load, k).base?.version, 2);
  // while a save of the member's OWN is in flight, a refresh does not raise a false conflict (its answer updates the base)
  let own = apply(apply(apply(apply(emptyEdits, k, { type: 'loaded', detail: detail() }), k, { type: 'open' }), k, { type: 'edit', field: 'reflection', value: 'x' }), k, { type: 'saveBegin', token: 'own' });
  own = apply(own, k, { type: 'loaded', detail: detail({ version: 2, reflection: 'x' }) }); assert.equal(editFor(own, k).conflict, null); own = apply(own, k, { type: 'saveDone', token: 'own', version: 2 }); assert.equal(editFor(own, k).base?.version, 2);
  // a closed editor simply takes the saved copy
  assert.equal(editFor(apply(apply(emptyEdits, k, { type: 'loaded', detail: detail({ version: 1 }) }), k, { type: 'loaded', detail: detail({ version: 5 }) }), k).base?.version, 5);
});
