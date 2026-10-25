// First complete journey on the approved HackAss One visual system (Discover, Hack Detail, Adapt/Create, Copy, Reflect, Save, Reopen).
// Focused regressions for the review findings: every draft replacement is guarded, clearing saved content counts as an unsaved change, "copied" is only ever
// reported after the clipboard write succeeds, canonical outcomes and the existing field limits are used, and no paid, unlimited or priced wording is shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { initialState, promptSaveView, reduce, requiresConfirmation, type Action, type ExperienceState } from '../src/ui/experience/state.ts';
import { DEMO_HACKS } from '../src/ui/experience/demo-hacks.ts';
import { OUTCOME_HINTS, OUTCOME_LABELS, OUTCOME_ORDER } from '../src/ui/experience/prompt.ts';
import { toneFor, visualFor } from '../src/ui/experience/format.ts';
import { copyText, createCopyFlow, type CopyResult } from '../src/ui/experience/copy.ts';
import { LIMITS, OUTCOMES } from '../src/modules/mywork/index.ts';

const src = (f: string) => readFileSync(f, 'utf8');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(n) ? [p] : []; });
const run = (...as: Action[]): ExperienceState => as.reduce(reduce, initialState);
const demo = DEMO_HACKS[0];
const UI_FILES = [...walk('src/ui'), ...walk('app/(experience)')];

// ---- draft replacement is guarded everywhere, including reopening the same hack -----------------------------------------------------------------------------
test('re-adapting the SAME hack while the draft has unsaved edits needs confirmation; declining changes nothing', () => {
  const edited = run({ type: 'startFromHack', hack: demo }, { type: 'editPrompt', value: 'my careful rewrite' });
  assert.equal(requiresConfirmation(edited, 'adapt'), true, 'same hack, unsaved edits');
  assert.equal(requiresConfirmation(edited, 'new'), true); assert.equal(requiresConfirmation(edited, 'reset'), true); assert.equal(requiresConfirmation(edited, 'load'), true);
  // "Cancel": the confirmation never ran its action, so no action reached the reducer and the draft is byte-for-byte the same
  assert.equal(edited.fullPrompt, 'my careful rewrite'); assert.equal(edited.dirty, true);
});
test('every call that replaces the draft (start from a hack, start blank, load a saved prompt) sits inside confirmThen, and Cancel only closes the dialog', () => {
  let sites = 0;
  for (const f of UI_FILES.filter((x) => x.endsWith('.tsx'))) {
    const code = src(f);
    for (const m of code.matchAll(/dispatch\(\{ type: '(startFromHack|startBlank|loadSaved)'/g)) {
      sites++;
      const before = code.slice(Math.max(0, (m.index ?? 0) - 220), m.index);
      assert.match(before, /confirmThen\(/, `${f}: ${m[1]} must run inside confirmThen`);
    }
  }
  assert.ok(sites >= 3, `expected the known replacement sites, saw ${sites}`);
  const provider = src('src/ui/experience/ExperienceProvider.tsx');
  assert.match(provider, /onCancel=\{\(\) => setPending\(null\)\}/, 'Cancel only clears the pending confirmation');
  assert.match(src('src/ui/experience/ConfirmDialog.tsx'), /autoFocus onClick=\{onCancel\}/, 'Cancel (keep my draft) is the focused default');
});

// ---- clearing saved content is an unsaved change --------------------------------------------------------------------------------------------------------------
test('emptying a saved prompt (or one of its fields) makes the draft changed, never silently "saved"', () => {
  const saved = { id: 'p1', version: 3, title: 'Saved title', goal: 'Saved goal', context: 'Saved context', output_format: 'Clear step-by-step plan', full_prompt: 'Saved prompt text', starting_prompt: '', origin_kind: 'scratch', origin_slug: null, origin_title: null, updated_at: '2026-10-22T10:00:00Z', created_at: '2026-10-22T09:00:00Z', result_count: 0 };
  const loaded = run({ type: 'loadSaved', detail: saved as never, at: 1 });
  assert.equal(loaded.dirty, false); assert.equal(promptSaveView(loaded), 'saved');
  for (const a of [{ type: 'editPrompt', value: '' }, { type: 'editField', field: 'goal', value: '' }, { type: 'editField', field: 'title', value: '' }, { type: 'editField', field: 'context', value: '' }] as Action[]) {
    const cleared = reduce(loaded, a);
    assert.equal(cleared.dirty, true, JSON.stringify(a)); assert.equal(promptSaveView(cleared), 'changed', JSON.stringify(a)); assert.equal(requiresConfirmation(cleared, 'adapt'), true);
  }
  const clearedReflection = reduce(run({ type: 'startFromHack', hack: demo }, { type: 'reflect', field: 'text', value: 'x' }), { type: 'reflect', field: 'text', value: '' });
  assert.equal(clearedReflection.dirty, true, 'a reflection that was typed and then cleared is still an edit until saved');
});

// ---- clipboard: success only after the write succeeds ----------------------------------------------------------------------------------------------------------
function withBrowser(clipboard: unknown, exec: () => boolean, body: () => Promise<void>) {
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); const doc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const el = { value: '', style: {} as Record<string, string>, setAttribute() {}, select() {}, remove() {} };
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: { createElement: () => el, body: { append() {} }, execCommand: exec }, configurable: true, writable: true });
  return body().finally(() => { if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete (globalThis as Record<string, unknown>).navigator; if (doc) Object.defineProperty(globalThis, 'document', doc); else delete (globalThis as Record<string, unknown>).document; });
}
test('copyText reports "copied" only when the write succeeded, and "blocked" when neither the clipboard API nor the fallback worked', async () => {
  await withBrowser({ writeText: async () => undefined }, () => false, async () => assert.equal(await copyText('hello'), 'copied'));
  await withBrowser({ writeText: async () => { throw new Error('denied'); } }, () => true, async () => assert.equal(await copyText('hello'), 'copied'));   // the fallback confirmed it
  await withBrowser({ writeText: async () => { throw new Error('denied'); } }, () => false, async () => assert.equal(await copyText('hello'), 'blocked'));
  await withBrowser({ writeText: async () => { throw new Error('denied'); } }, () => { throw new Error('no'); }, async () => assert.equal(await copyText('hello'), 'blocked'));
});
test('the provider announces success only in the success branch; a failure opens the selectable manual-copy dialog with instructions', () => {
  const p = src('src/ui/experience/ExperienceProvider.tsx');
  assert.match(src('src/ui/experience/copy.ts'), /if \(result === 'copied'\) deps\.onCopied\(text, stamp\); else deps\.onManual\(text\);/);
  assert.match(p, /onCopied: \(text, stamp\) => \{ toast\(COPIED\);.*onManual: setManualCopy/);
  assert.match(p, /<ManualCopyDialog text=\{manualCopy\}/);
  const d = src('src/ui/experience/ManualCopyDialog.tsx'); assert.match(d, /readOnly/); assert.match(d, /\.select\(\)/);
  const c = src('src/ui/experience/copy.ts'); assert.match(c, /nothing has been copied yet/); assert.match(c, /Ctrl\+C/);
  for (const f of UI_FILES) if (f !== 'src/ui/experience/copy.ts') assert.doesNotMatch(src(f), /COPY_BLOCKED/, f);
});

// ---- canonical outcomes and the existing limits --------------------------------------------------------------------------------------------------------------
test('the four canonical outcomes are the only ones offered, in the stored vocabulary, with the approved labels', () => {
  assert.deepEqual([...OUTCOME_ORDER], ['yes', 'partial', 'no', 'notyet']); assert.deepEqual([...OUTCOMES], [...OUTCOME_ORDER]);
  assert.deepEqual([OUTCOME_LABELS.yes, OUTCOME_LABELS.partial, OUTCOME_LABELS.no, OUTCOME_LABELS.notyet], ['It worked', 'Partly worked', 'Didn’t work', 'Didn’t try it yet']);
  for (const k of OUTCOME_ORDER) assert.ok(OUTCOME_HINTS[k].length > 0);
  const reveal = src('src/ui/experience/RevealScreen.tsx'); assert.match(reveal, /OUTCOME_ORDER\.map/); assert.doesNotMatch(reveal, /not-yet|'worked'|'didnt'|'skipped'/);
});
test('the editors use the existing application limits, not prototype placeholders', () => {
  assert.deepEqual([LIMITS.title, LIMITS.goal, LIMITS.context, LIMITS.prompt, LIMITS.reflection, LIMITS.nextChange], [120, 2000, 4000, 20000, 4000, 500]);
  const lab = src('src/ui/experience/LabScreen.tsx'); for (const k of ['title', 'goal', 'context', 'prompt']) assert.match(lab, new RegExp(`maxLength=\\{LIMITS\\.${k}\\}`), k);
  const reveal = src('src/ui/experience/RevealScreen.tsx'); for (const k of ['reflection', 'nextChange']) assert.match(reveal, new RegExp(`maxLength=\\{LIMITS\\.${k}\\}`), k);
});

// ---- bounded scope: no paid, unlimited or priced wording; no simulated community or sharing; no browser storage ------------------------------------------------
test('no paid plan, price, "unlimited" or credits wording appears anywhere in the screens', () => {
  for (const f of UI_FILES.filter((x) => x.endsWith('.tsx') || x.endsWith('.ts'))) {
    const code = src(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /\bPlus\b|paywall|subscription|\bunlimited\b|\b(buy|purchase|top up|spend|earn) (more )?credits\b|\bcredits? (left|remaining|balance)\b|\$\s?\d|per (month|year)|free trial/i, f);
  }
});
test('copy-out is described as the current capability and embedded AI as the approved future vision; prompt creation stays always free', () => {
  const lab = src('src/ui/experience/LabScreen.tsx'); assert.match(lab, /Copy-out is how this version works today/); assert.match(lab, /approved vision and is not available yet/);
  assert.match(src('src/ui/experience/SparkHeader.tsx'), /Always free/);
});
test('sharing, recipient views, profiles, social and media controls are absent (or shown as unavailable), never simulated as working', () => {
  for (const f of UI_FILES.filter((x) => x.endsWith('.tsx'))) assert.doesNotMatch(src(f), /Share link|Shared by link|recipient view|Follow creator|<input[^>]*type="file"|capture=|getUserMedia/i, f);
  assert.match(src('src/ui/experience/RevealScreen.tsx'), /Submit to community \(unavailable\)/);
});

// ---- the approved visual system ----------------------------------------------------------------------------------------------------------------------------
test('the stylesheet uses the approved light tokens, loads nothing external, keeps a visible 2.5px focus ring and 44px controls', () => {
  const css = src('src/ui/experience/experience.css');
  for (const t of ['#f6f5f2', '#141414', '#c2452c', '#ffc145', '#716f68', '2.5px solid var(--coral-deep)', 'min-height:44px', 'prefers-reduced-motion']) assert.ok(css.includes(t), t);
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:|fonts\.googleapis|http:\/\//); assert.doesNotMatch(css, /#11151c|#1a2029|#f36b51/, 'no leftover dark-theme tokens');
  assert.match(css, /\.hx \.tone-a\{/); assert.match(css, /max-width:989px/); assert.match(css, /max-width:1199px/);
});
test('card colours follow the six approved categories, and any other category gets a stable colour', () => {
  assert.deepEqual(['Everyday', 'Work', 'Creative', 'Money', 'Life', 'Visual'].map(toneFor), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(toneFor('  EVERYDAY '), 'a'); assert.equal(toneFor('Gardening'), toneFor('Gardening')); assert.equal(toneFor('Gardening'), visualFor('gardening'));
});
test('navigation: accessible names, icons, and a bottom bar on phones (destinations are covered in ui-s2.test.ts)', () => {
  const shell = src('src/ui/experience/Shell.tsx');
  assert.match(shell, /aria-label="Mobile navigation"/); assert.match(shell, /aria-label="Primary"/); assert.match(shell, /aria-hidden="true" focusable="false"/);
});

// ---- the manual-copy dialog and clipboard requests respect the account boundary ----------------------------------------------------------------------------------
function flowHarness(write: (t: string) => Promise<CopyResult>) {
  const seen = { manual: null as string | null, toasts: [] as string[], clears: 0 };
  const flow = createCopyFlow({ write, onCopied: () => { seen.toasts.push('copied'); }, onManual: (t) => { seen.manual = t; }, onClear: () => { seen.manual = null; seen.toasts.length = 0; seen.clears++; } });
  return { seen, flow };
}
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
test('copy flow, same account: success announces once; a failure opens the manual-copy text; a throwing write counts as a failure', async () => {
  const ok = flowHarness(async () => 'copied'); await ok.flow.copy('a'); assert.deepEqual(ok.seen.toasts, ['copied']); assert.equal(ok.seen.manual, null);
  const bad = flowHarness(async () => 'blocked'); await bad.flow.copy('private text'); assert.equal(bad.seen.manual, 'private text'); assert.deepEqual(bad.seen.toasts, []);
  const boom = flowHarness(async () => { throw new Error('x'); }); await boom.flow.copy('t'); assert.equal(boom.seen.manual, 't');
});
test('an ALREADY-OPEN manual-copy dialog is closed and cleared when the account changes (sign-out or another account)', async () => {
  const h = flowHarness(async () => 'blocked'); await h.flow.copy('PRIVATE SAVED CONTENT');
  assert.equal(h.seen.manual, 'PRIVATE SAVED CONTENT', 'the dialog is open');
  h.flow.invalidate();
  assert.equal(h.seen.manual, null, 'the old text is gone'); assert.equal(h.seen.clears, 1);
});
test('a DELAYED clipboard failure that finishes after the account changed cannot reopen the dialog with the old text', async () => {
  const d = deferred<CopyResult>(); const h = flowHarness(() => d.promise);
  const running = h.flow.copy('OLD ACCOUNT TEXT');
  h.flow.invalidate();                      // sign-out / account change while the request is still running
  d.resolve('blocked'); await running;
  assert.equal(h.seen.manual, null, 'no dialog'); assert.deepEqual(h.seen.toasts, []);
});
test('a DELAYED clipboard success that finishes after the account changed announces nothing under the new account', async () => {
  const d = deferred<CopyResult>(); const h = flowHarness(() => d.promise);
  const running = h.flow.copy('OLD ACCOUNT TEXT'); h.flow.invalidate(); d.resolve('copied'); await running;
  assert.deepEqual(h.seen.toasts, [], 'no "Copied" announcement'); assert.equal(h.seen.manual, null);
  // a copy started AFTER the boundary behaves normally again
  const fresh = flowHarness(async () => 'copied'); fresh.flow.invalidate(); await fresh.flow.copy('new'); assert.deepEqual(fresh.seen.toasts, ['copied']);
});
test('a late rejection (not only a late "blocked") across the boundary is also dropped', async () => {
  const d = deferred<CopyResult>(); const h = flowHarness(() => d.promise);
  const running = h.flow.copy('x'); h.flow.invalidate(); d.reject(new Error('late')); await running;
  assert.equal(h.seen.manual, null); assert.deepEqual(h.seen.toasts, []);
});
test('the provider routes copying through the flow, clears dialog and toast on invalidate, and AccountBoundary invalidates on every account change', () => {
  const p = src('src/ui/experience/ExperienceProvider.tsx');
  assert.match(p, /createCopyFlow\(\{ write: copyText/); assert.match(p, /const clearCopyUi = useCallback\(\(\) => \{ setManualCopy\(null\); setToastText\(''\);/); assert.match(p, /copyFlow\.current\?\.invalidate\(\)/);
  assert.doesNotMatch(p, /await copyText\(text\)/, 'no copy path bypasses the flow');
  const b = src('src/ui/work/AccountBoundary.tsx');
  assert.match(b, /dispatch\(\{ type: 'accountChanged' \}\);[\s\S]*invalidateCopies\(\);/, 'invalidated in the same effect as the draft and edit protections');
  // the working draft is untouched by this: accountChanged keeps the member's own text, unsaved
  const kept = run({ type: 'startFromHack', hack: demo }, { type: 'editPrompt', value: 'my draft' }, { type: 'accountChanged' });
  assert.equal(kept.fullPrompt, 'my draft'); assert.equal(kept.dirty, true);
});
