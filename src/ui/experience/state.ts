// The experience's TEMPORARY state as a pure reducer plus the rules that guard it. Nothing in this file reads or writes any browser or
// server storage: the state lives in memory only and is discarded on reload. Overwrites of unsaved work always need confirmation.
import type { ExperienceHack, Mode, Outcome, OutputFormat, PromptFields, Reflection } from './types.ts';
import { OUTPUT_FORMATS } from './types.ts';
import { composePrompt } from './prompt.ts';
import { applyAnswer, CHAT_ANSWERED, CHAT_FRESH, followEdit, NO_PENDING, rebuildPrompt, type AnswerDraft, type ChatFlags, type EditMode, type EditorDraft, type Pending, type Slot, type StepId } from './guided.ts';
import type { PromptDetail, ResultDetail } from '../../modules/mywork/index.ts';

// ---- saved work (PX-3c) ----------------------------------------------------------------------------------------------------------------------------
// Every edit advances a monotonic draft REVISION. A save captures the revision (and the exact content) it submits; a successful response marks ONLY that
// revision as saved (savedRevision = max(savedRevision, submitted)). Typing while the request runs therefore leaves the draft newer than the saved copy:
// the state shows "Changed since last save" and the leave-page warning stays on. A failed save changes nothing. A response that does not belong to the
// save in flight (an older one, or one from a draft that has since been replaced) is ignored. Only one save is in flight at a time.
export type OriginRef = { readonly kind: 'scratch' } | { readonly kind: 'catalog'; readonly slug: string; readonly title: string } | { readonly kind: 'demo'; readonly title: string };
export interface SavedRef { readonly id: string; readonly version: number; readonly savedAt: number }
/** prompt_* touch the prompt; result_* touch the result; `both` is the single atomic prompt-and-result operation. */
export type SaveOp = 'prompt_create' | 'prompt_update' | 'result_new' | 'result_update' | 'both';
export interface InFlight { readonly op: SaveOp; readonly requestId: string; readonly revision: number; readonly reflectionRevision: number; /** the draft generation it was submitted from: a response for another generation is never applied */ readonly epoch: number }
export type ProblemKind = 'incomplete' | 'outcome' | 'signin' | 'setup' | 'forbidden' | 'quota' | 'rate_limited' | 'invalid' | 'too_large' | 'unavailable' | 'gone' | 'result_gone';
export interface Problem { readonly kind: ProblemKind; readonly field?: string; readonly retryAfterSec?: number; readonly during: SaveOp | 'resolve' }
export type Conflict = { readonly target: 'prompt'; readonly server: PromptDetail } | { readonly target: 'result'; readonly server: ResultDetail };
export interface WorkState {
  /** Bumped whenever the draft is replaced, reset or detached from its saved copy, or the account changes. An acknowledgment can only ever be applied to the generation it was submitted from. */
  readonly epoch: number;
  readonly revision: number; readonly savedRevision: number;                   // the prompt draft
  readonly reflectionRevision: number; readonly reflectionSavedRevision: number; // the reflection
  readonly originRef: OriginRef;
  readonly saved: SavedRef | null;           // the saved prompt this draft is linked to
  readonly savedResult: SavedRef | null;     // the saved result this reflection is linked to
  readonly inFlight: InFlight | null;
  readonly intent: { readonly key: string; readonly requestId: string } | null;  // a failed save is retried under the SAME request id while its content is unchanged
  readonly problem: Problem | null;
  readonly conflict: Conflict | null;
}
export const INITIAL_WORK: WorkState = { epoch: 0, revision: 0, savedRevision: 0, reflectionRevision: 0, reflectionSavedRevision: 0, originRef: { kind: 'scratch' }, saved: null, savedResult: null, inFlight: null, intent: null, problem: null, conflict: null };

export interface ExperienceState {
  /** The hack whose detail the member last opened (drives guarded Detail navigation). Null until one is opened and after "Create a Prompt". */
  readonly viewing: ExperienceHack | null;
  /** The hack the current draft was started from, or null for a draft started from scratch. */
  readonly origin: ExperienceHack | null;
  readonly started: boolean;               // a draft exists (from a hack or from scratch)
  readonly startingPrompt: string;         // what the comparison shows as "starting version"
  readonly fields: PromptFields;
  readonly fullPrompt: string;
  readonly mode: Mode;
  /** How the draft is being edited (S3). A view choice: it is never part of what is saved and changing it never touches the draft. */
  readonly editMode: EditMode;
  /** Bumped whenever the draft is REPLACED (a hack adapted, a new or reset draft, a saved prompt opened). Temporary editors are bound to it. */
  readonly draftGen: number;
  /** Unfinished input that belongs to the current draft generation: the guided answer not yet sent and the highlighted-part editors not yet applied. In memory only; shared by every screen
   *  (a mode switch or a page change keeps it); counted as unsaved work; cleared when the draft is replaced or reset; an action carrying an older generation changes nothing. */
  readonly pending: Pending;
  /** Which two guided questions have been answered that a field cannot show (limits skipped, format chosen). Set when a draft is created, changed only by the exchange: never inferred from the fields. */
  readonly chat: ChatFlags;
  readonly dirty: boolean;                 // unsaved prompt or reflection edits exist (derived: a revision newer than its saved revision)
  readonly reflection: Reflection;
  readonly work: WorkState;
}

export const BLANK_FIELDS: PromptFields = { title: '', goal: '', context: '', format: 'Clear step-by-step plan' };
export const BLANK_REFLECTION: Reflection = { outcome: '', text: '', next: '' };
export const NO_ORIGINAL = 'No original prompt — you started from scratch.';

export const initialState: ExperienceState = {
  viewing: null, origin: null, started: false, startingPrompt: '', fields: BLANK_FIELDS, fullPrompt: '', mode: 'try', editMode: 'guided', draftGen: 0, pending: NO_PENDING, chat: CHAT_FRESH, dirty: false, reflection: BLANK_REFLECTION, work: INITIAL_WORK,
};

export type Action =
  | { type: 'view'; hack: ExperienceHack }
  | { type: 'startFromHack'; hack: ExperienceHack; /** the Hack page's Apply: the first edit, applied to the new draft in the same step */ apply?: { readonly slot: Slot; readonly value: string }; /** the draft generation the member acted on: if the draft has been replaced since, nothing happens */ expectGen?: number }
  | { type: 'startBlank' }
  | { type: 'editField'; field: keyof PromptFields; value: string }
  /** S3: an answer or highlighted slot changes; a prompt that FOLLOWS its answers has its generated block rewritten in the same revision (the text after it is kept). */
  | { type: 'editSlot'; field: keyof PromptFields; value: string; /** the draft generation the caller was acting for: an older one changes nothing */ gen?: number }
  /** S3: rebuild the generated block from the answers and keep what follows it (or replace the whole prompt when no block can be identified: the caller confirms first). */
  | { type: 'rebuild' }
  | { type: 'setEditMode'; editMode: EditMode }
  /** The guided answer being typed, and the highlighted-part editors: unfinished input, kept in shared state for this draft generation. */
  | { type: 'setAnswer'; gen: number; answer: AnswerDraft | null }
  /** Send: the pending answer is applied to the question it belongs to (set when it was typed), then cleared. */
  | { type: 'sendAnswer'; gen: number }
  /** An answer given directly (a format chip, Skip): applied to `step`, which also settles that question's completion flag. */
  | { type: 'answerStep'; gen: number; step: StepId; text: string }
  | { type: 'setEditor'; gen: number; key: string; editor: EditorDraft | null }
  /** Apply the editor `key` to the draft (one revision) and close it. Nothing to apply, or an older generation: nothing happens. */
  | { type: 'applyEditor'; gen: number; key: string }
  | { type: 'editPrompt'; value: string }
  | { type: 'regenerate' }
  | { type: 'setMode'; mode: Mode }
  | { type: 'reflect'; field: keyof Reflection; value: string }
  | { type: 'resetDraft' }
  | { type: 'loadSaved'; detail: PromptDetail; at: number }
  | { type: 'saveBegin'; op: SaveOp; requestId: string; key: string; revision: number; reflectionRevision: number; epoch: number }
  | { type: 'saveDone'; requestId: string; epoch: number; prompt?: { id: string; version: number; at: number }; result?: { id: string; version: number; at: number }; /** applied together with the acknowledgment: one half saved, the other half in conflict */ conflict?: Conflict }
  | { type: 'saveFail'; requestId: string; epoch: number; problem: Omit<Problem, 'during'> }
  | { type: 'conflictFound'; requestId: string; epoch: number; conflict: Conflict }
  | { type: 'accountChanged' }
  | { type: 'useServerPrompt'; detail: PromptDetail; at: number }
  | { type: 'useServerResult'; detail: ResultDetail; at: number }
  | { type: 'adoptVersion'; target: 'prompt' | 'result'; id: string; version: number; /** the draft generation the caller is acting for: a stale caller changes nothing */ epoch: number; /** the saved copy has exactly the draft's content: only its version moved, so the draft is in sync with it (no new revision) */ inSync?: boolean }
  | { type: 'unlink'; target: 'prompt' | 'result'; id: string }
  | { type: 'problem'; problem: Omit<Problem, 'during'> & { during?: Problem['during'] } }
  | { type: 'dismissProblem' };

/** Which destructive replacement is about to happen; each needs confirmation when unsaved work would be lost. */
export type Replacement = 'adapt' | 'new' | 'reset' | 'regenerate' | 'rebuild' | 'load';

/**
 * Whether a replacement must be confirmed first. Adapting another hack, creating a new prompt and resetting need confirmation when ANY tracked
 * prompt or reflection edit is unsaved; regenerating from the fields needs confirmation whenever it would replace a non-empty prompt.
 */
export function requiresConfirmation(state: ExperienceState, what: Replacement, opts: { readonly exceptEditor?: string } = {}): boolean {
  if (what === 'regenerate' || what === 'rebuild') return state.fullPrompt.trim().length > 0;
  if (opts.exceptEditor === undefined) return state.dirty;
  // The editor being applied is the change that is about to start the draft: it is not "work that would be replaced".
  const others = { ...state.pending.editors }; delete others[opts.exceptEditor];
  return state.work.revision > state.work.savedRevision || state.work.reflectionRevision > state.work.reflectionSavedRevision || hasPending({ answer: state.pending.answer, editors: others });
}

/** Detail navigation is available only when a hack has been selected. */
export const canOpenDetail = (state: ExperienceState): boolean => state.viewing !== null;
export const detailHref = (state: ExperienceState): string | null => state.viewing?.href ?? null;

export const originRefOf = (hack: ExperienceHack | null): OriginRef => (hack === null ? { kind: 'scratch' } : hack.source === 'catalog' ? { kind: 'catalog', slug: hack.key, title: hack.title } : { kind: 'demo', title: hack.title });
/** The saved prompt a stored origin came from, for display ("From a catalog hack: …"). */
export const originLabel = (kind: string, title: string | null): string => (kind === 'catalog' ? `Catalog hack${title ? `: ${title}` : ''}` : kind === 'demo' ? `Demo example${title ? `: ${title}` : ''}` : 'Started from scratch');

const fromHack = (hack: ExperienceHack): Pick<ExperienceState, 'origin' | 'started' | 'startingPrompt' | 'fields' | 'fullPrompt' | 'dirty' | 'reflection' | 'mode' | 'editMode' | 'chat'> => ({
  origin: hack, started: true, startingPrompt: hack.starterPrompt,
  fields: { title: hack.title, goal: hack.goal, context: hack.context, format: hack.format }, fullPrompt: hack.starterPrompt, dirty: false, reflection: BLANK_REFLECTION, mode: 'try', editMode: 'adapt', chat: CHAT_ANSWERED,
});

/** One edit of a prompt part or of the whole prompt, as a single revision (the Hack page's Apply and the Lab's editor use this). */
function applyTo(state: ExperienceState, slot: Slot, value: string): ExperienceState {
  return slot === 'all' ? step(state, { type: 'editPrompt', value }) : step(state, { type: 'editSlot', field: slot, value });
}
/** One guided answer: set the field it belongs to (as a single revision, and only if it changes), settle its completion flag, and clear the pending answer when it was that one. */
function answerStep(state: ExperienceState, id: StepId, text: string): ExperienceState {
  const r = applyAnswer(id, text, state.fields);
  if (!r) return state; // the joined context would pass its length limit: nothing changes
  const changed = r.value !== (state.fields as unknown as Record<string, string>)[r.field];
  const next = changed ? step(state, { type: 'editSlot', field: r.field, value: r.value }) : state;
  const chat: ChatFlags = id === 'limits' ? { ...state.chat, limitsSkipped: text.trim() === '' } : id === 'format' ? { ...state.chat, formatDone: true } : state.chat;
  const cleared = state.pending.answer?.step === id ? { ...next.pending, answer: null } : next.pending;
  return { ...next, chat, pending: cleared };
}
/** Unfinished input counts as unsaved work: a typed guided answer, or an editor whose text differs from what it opened with. */
export const hasPending = (p: Pending): boolean => (p.answer !== null && p.answer.text.trim() !== '') || Object.values(p.editors).some((e) => e.value !== e.base);
const isFormat = (v: string): v is OutputFormat => (OUTPUT_FORMATS as readonly string[]).includes(v);
/** `dirty` is DERIVED: the draft or the reflection is newer than what was last saved (a draft that was never edited is not dirty, as before). */
const settle = (st: ExperienceState): ExperienceState => {
  const dirty = st.work.revision > st.work.savedRevision || st.work.reflectionRevision > st.work.reflectionSavedRevision || hasPending(st.pending);
  return dirty === st.dirty ? st : { ...st, dirty };
};
const fresh = (originRef: OriginRef, prev: WorkState): WorkState => ({ ...INITIAL_WORK, originRef, epoch: prev.epoch + 1 });
const bump = (w: WorkState): WorkState => ({ ...w, revision: w.revision + 1 });

export function reduce(state: ExperienceState, action: Action): ExperienceState {
  return settle(step(state, action));
}

function step(state: ExperienceState, action: Action): ExperienceState {
  const w = state.work;
  switch (action.type) {
    case 'view': return { ...state, viewing: action.hack };
    case 'startFromHack': {
      if (action.expectGen !== undefined && action.expectGen !== state.draftGen) return state;
      const started: ExperienceState = { ...state, viewing: action.hack, ...fromHack(action.hack), draftGen: state.draftGen + 1, pending: NO_PENDING, work: fresh(originRefOf(action.hack), w) };
      return action.apply ? applyTo(started, action.apply.slot, action.apply.value) : started;
    }
    case 'startBlank': return { ...state, draftGen: state.draftGen + 1, pending: NO_PENDING, chat: CHAT_FRESH, viewing: null, origin: null, started: true, startingPrompt: NO_ORIGINAL, fields: BLANK_FIELDS, fullPrompt: '', dirty: false, reflection: BLANK_REFLECTION, mode: 'try', editMode: 'guided', work: fresh({ kind: 'scratch' }, w) };
    case 'editField': return { ...state, fields: { ...state.fields, [action.field]: action.value as OutputFormat & string }, dirty: true, work: bump(w) };
    case 'editPrompt': return { ...state, fullPrompt: action.value, dirty: true, work: bump(w) };
    case 'regenerate': return { ...state, fullPrompt: composePrompt(state.fields), dirty: true, work: bump(w) };
    case 'editSlot': {
      if (action.gen !== undefined && action.gen !== state.draftGen) return state;
      const fields = { ...state.fields, [action.field]: action.value as OutputFormat & string };
      return { ...state, fields, fullPrompt: followEdit(state.fullPrompt, state.fields, fields) ?? state.fullPrompt, dirty: true, work: bump(w) };
    }
    case 'rebuild': {
      const r = rebuildPrompt(state.fullPrompt, state.fields);
      return r ? { ...state, fullPrompt: r.text, dirty: true, work: bump(w) } : state;
    }
    case 'setMode': return { ...state, mode: action.mode };
    case 'setAnswer': {
      if (action.gen !== state.draftGen) return state;
      return { ...state, pending: { ...state.pending, answer: action.answer && action.answer.text === '' && action.answer.step === null ? null : action.answer } };
    }
    case 'sendAnswer': {
      const a = state.pending.answer;
      if (action.gen !== state.draftGen || !a || a.text.trim() === '') return state;
      return answerStep(state, a.step, a.text);
    }
    case 'answerStep': return action.gen !== state.draftGen ? state : answerStep(state, action.step, action.text);
    case 'setEditor': {
      if (action.gen !== state.draftGen) return state;
      const editors = { ...state.pending.editors };
      if (action.editor) editors[action.key] = action.editor; else delete editors[action.key];
      return { ...state, pending: { ...state.pending, editors } };
    }
    case 'applyEditor': {
      const e = state.pending.editors[action.key];
      if (action.gen !== state.draftGen || !e) return state;
      const editors = { ...state.pending.editors }; delete editors[action.key];
      return applyTo({ ...state, pending: { ...state.pending, editors } }, e.slot, e.value);
    }
    case 'setEditMode': return action.editMode === state.editMode ? state : { ...state, editMode: action.editMode };
    case 'reflect': return { ...state, reflection: { ...state.reflection, [action.field]: action.value as Outcome & string }, dirty: true, work: { ...w, reflectionRevision: w.reflectionRevision + 1 } };
    case 'resetDraft': {
      const base = state.origin ? { ...state, ...fromHack(state.origin) } : { ...state, ...step(state, { type: 'startBlank' }), viewing: state.viewing };
      // the saved link survives a reset: the draft is simply newer than the saved copy again. A reset reflection is a fresh one.
      // A save that was in flight belongs to the draft that is being thrown away: it is dropped (new epoch), so its answer can never mark the reset draft saved.
      return { ...base, editMode: state.editMode, draftGen: state.draftGen + 1, pending: NO_PENDING, work: { ...w, epoch: w.epoch + 1, inFlight: null, revision: w.saved ? w.savedRevision + 1 : 0, savedRevision: w.saved ? w.savedRevision : 0, reflectionRevision: 0, reflectionSavedRevision: 0, savedResult: null, problem: null, conflict: null, intent: null } };
    }
    case 'loadSaved': {
      const d = action.detail;
      const originRef: OriginRef = d.origin_kind === 'catalog' && d.origin_slug ? { kind: 'catalog', slug: d.origin_slug, title: d.origin_title ?? d.origin_slug } : d.origin_kind === 'demo' ? { kind: 'demo', title: d.origin_title ?? 'Demo example' } : { kind: 'scratch' };
      return { ...state, viewing: null, origin: null, started: true, startingPrompt: d.starting_prompt || NO_ORIGINAL, fields: { title: d.title, goal: d.goal, context: d.context, format: isFormat(d.output_format) ? d.output_format : 'Clear step-by-step plan' },
        fullPrompt: d.full_prompt, mode: 'try', editMode: 'advanced', draftGen: state.draftGen + 1, pending: NO_PENDING, chat: CHAT_ANSWERED, reflection: BLANK_REFLECTION, dirty: false, work: { ...fresh(originRef, w), saved: { id: d.id, version: d.version, savedAt: Date.parse(d.updated_at) || action.at } } };
    }
    case 'saveBegin': {
      if (w.inFlight) return state; // one save at a time
      return { ...state, work: { ...w, inFlight: { op: action.op, requestId: action.requestId, revision: action.revision, reflectionRevision: action.reflectionRevision, epoch: action.epoch }, intent: { key: action.key, requestId: action.requestId }, problem: null } };
    }
    case 'saveDone': {
      const f = w.inFlight; if (!f || f.requestId !== action.requestId || f.epoch !== w.epoch || action.epoch !== w.epoch) return state; // not the save we are waiting for, or the draft it belonged to is gone: ignored
      const touchesPrompt = f.op === 'prompt_create' || f.op === 'prompt_update' || f.op === 'both';
      const touchesResult = f.op === 'result_new' || f.op === 'result_update' || f.op === 'both';
      return { ...state, work: {
        ...w, inFlight: null, intent: null, problem: null, conflict: null,
        ...(touchesPrompt && action.prompt ? { saved: { id: action.prompt.id, version: action.prompt.version, savedAt: action.prompt.at }, savedRevision: Math.max(w.savedRevision, f.revision) } : {}),
        ...(touchesResult && action.result ? { savedResult: { id: action.result.id, version: action.result.version, savedAt: action.result.at }, reflectionSavedRevision: Math.max(w.reflectionSavedRevision, f.reflectionRevision) } : {}),
        ...(action.conflict ? { conflict: action.conflict } : {}),
      } };
    }
    case 'saveFail': {
      const f = w.inFlight; if (!f || f.requestId !== action.requestId || f.epoch !== w.epoch || action.epoch !== w.epoch) return state;
      return { ...state, work: { ...w, inFlight: null, problem: { ...action.problem, during: f.op } } }; // nothing about the draft changes; the intent stays so a retry reuses its request id
    }
    case 'conflictFound': {
      const f = w.inFlight; if (!f || f.requestId !== action.requestId || f.epoch !== w.epoch || action.epoch !== w.epoch) return state;
      return { ...state, work: { ...w, inFlight: null, problem: null, conflict: action.conflict } };
    }
    case 'useServerPrompt': { // "load the saved version": the prompt draft becomes the saved copy; the member's reflection is NOT touched
      const loaded = step(state, { type: 'loadSaved', detail: action.detail, at: action.at });
      return { ...loaded, editMode: state.editMode, reflection: state.reflection, work: { ...loaded.work, reflectionRevision: w.reflectionRevision, reflectionSavedRevision: w.reflectionSavedRevision, savedResult: w.savedResult } };
    }
    case 'useServerResult': {
      const d = action.detail;
      return { ...state, reflection: { outcome: d.outcome, text: d.reflection, next: d.next_change }, work: { ...w, savedResult: { id: d.id, version: d.version, savedAt: Date.parse(d.updated_at) || action.at }, reflectionSavedRevision: w.reflectionRevision, conflict: null, problem: null, intent: null } };
    }
    case 'adoptVersion': // "overwrite": keep my text, but build on the item that is saved NOW (its own id and version: a first-create conflict has no link yet), then the caller saves
      if (action.epoch !== w.epoch) return state; // a follow-up from a draft that has since been replaced, reset or detached: changes nothing
      return action.target === 'prompt'
        ? { ...state, work: { ...w, saved: { id: action.id, version: action.version, savedAt: w.saved?.savedAt ?? 0 }, ...(action.inSync ? { savedRevision: w.revision } : { revision: Math.max(w.revision, w.savedRevision + 1) }), conflict: null, problem: null, intent: null } }
        : { ...state, work: { ...w, savedResult: { id: action.id, version: action.version, savedAt: w.savedResult?.savedAt ?? 0 }, reflectionRevision: Math.max(w.reflectionRevision, w.reflectionSavedRevision + 1), conflict: null, problem: null, intent: null } };
    case 'unlink': // the saved item no longer exists (deleted here or elsewhere): the draft stays, and is unsaved again
      return action.target === 'prompt' && w.saved?.id === action.id ? { ...state, work: { ...w, epoch: w.epoch + 1, inFlight: null, saved: null, savedRevision: 0, revision: Math.max(1, w.revision), savedResult: null, reflectionSavedRevision: 0, intent: null, conflict: null, problem: null } }
        : action.target === 'result' && w.savedResult?.id === action.id ? { ...state, work: { ...w, epoch: w.epoch + 1, inFlight: null, savedResult: null, reflectionSavedRevision: 0, reflectionRevision: Math.max(1, w.reflectionRevision), intent: null, conflict: null, problem: null } } : state;
    case 'accountChanged': // sign-out or another account: nothing private about the old account stays attached to the draft (the draft's own text is the member's and stays, unsaved)
      return state.started ? { ...state, work: { ...INITIAL_WORK, epoch: w.epoch + 1, originRef: w.originRef, revision: Math.max(1, w.revision), reflectionRevision: state.reflection.outcome || state.reflection.text || state.reflection.next ? Math.max(1, w.reflectionRevision) : 0 } }
        : { ...state, work: { ...INITIAL_WORK, epoch: w.epoch + 1 } };
    case 'problem': return { ...state, work: { ...w, problem: { during: 'resolve', ...action.problem } } };
    case 'dismissProblem': return w.problem || w.conflict ? { ...state, work: { ...w, problem: null, conflict: null } } : state;
  }
}

/** What the Save area shows for the prompt. Derived only; no field is stored for it. */
export type PromptSaveView = 'not_saved' | 'saving' | 'saved' | 'changed' | 'failed' | 'conflict' | 'signin';
export function promptSaveView(st: ExperienceState): PromptSaveView {
  const w = st.work;
  if (w.inFlight && (w.inFlight.op === 'prompt_create' || w.inFlight.op === 'prompt_update' || w.inFlight.op === 'both')) return 'saving';
  if (w.conflict?.target === 'prompt') return 'conflict';
  if (w.problem?.kind === 'signin') return 'signin';
  if (w.problem && w.problem.during !== 'result_new' && w.problem.during !== 'result_update') return 'failed';
  if (w.saved === null) return 'not_saved';
  return w.revision > w.savedRevision ? 'changed' : 'saved';
}
export type ResultSaveView = 'not_saved' | 'saving' | 'saved' | 'changed' | 'failed' | 'conflict' | 'signin';
export function resultSaveView(st: ExperienceState): ResultSaveView {
  const w = st.work;
  if (w.inFlight && w.inFlight.op !== 'prompt_create' && w.inFlight.op !== 'prompt_update') return 'saving';
  if (w.conflict) return 'conflict';
  if (w.problem?.kind === 'signin') return 'signin';
  if (w.problem && w.problem.during !== 'prompt_create' && w.problem.during !== 'prompt_update') return 'failed';
  if (w.savedResult === null) return 'not_saved';
  return w.reflectionRevision > w.reflectionSavedRevision ? 'changed' : 'saved';
}
