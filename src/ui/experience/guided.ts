// S3: the fixed rules behind Guided, Adapt and the prompt-follows-answers link. Pure functions: no model, no network, no storage, no clock.
// Nothing here judges a prompt. The completeness list only reports whether a part is empty or over its length limit.
import { composePrompt, PROMPT_TAIL } from './prompt.ts';
import { OUTPUT_FORMATS, type PromptFields } from './types.ts';
import { LIMITS } from '../../modules/mywork/index.ts';

/** The parts of the prompt the highlighted editor can change ('all' = the whole prompt, for free text). */
export type Slot = 'goal' | 'context' | 'format' | 'all';
/** The highlighted-part editor's unapplied text. It lives in the shared state, scoped to the draft generation (see state.ts). */
export interface EditorDraft { readonly slot: Slot; readonly value: string; /** What the part held when the editor opened: the editor is an unsaved change only while `value` differs. */ readonly base: string }
/** The guided answer being typed and not yet sent, and WHICH question it belongs to: the open question, or an earlier one being answered again (Change). The question is part of the
 *  draft, so it survives leaving and returning, and Send always applies the text to that question. */
export interface AnswerDraft { readonly text: string; readonly step: StepId }
export interface Pending { readonly answer: AnswerDraft | null; readonly editors: Readonly<Record<string, EditorDraft>> }
export const NO_PENDING: Pending = { answer: null, editors: {} };

/** How the member is editing the one draft. A view choice only: switching never changes, saves or discards the draft. */
export type EditMode = 'guided' | 'adapt' | 'advanced';
export const EDIT_MODES: readonly EditMode[] = ['guided', 'adapt', 'advanced'];
export const EDIT_MODE_LABELS: Record<EditMode, string> = { guided: 'Guided', adapt: 'Adapt', advanced: 'Advanced' };

/** The one explanation the exchange needs: what it is not, and what the progress chips do and do not say. */
export const SCRIPTED_NOTE = 'Scripted, not live AI: Hack\u2019s questions and your prompt come from fixed rules on this page. The chips show what is filled in and its length, not how well the prompt will work.';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BLOCK = new RegExp(`^Objective: [\\s\\S]*\\n\\nContext and constraints: [\\s\\S]*\\n\\nReturn: (?:${OUTPUT_FORMATS.map(escapeRe).join('|')})\\.\\n\\n${escapeRe(PROMPT_TAIL)}$`);

/** Where the generated block ends, only when exactly ONE reading of the text fits its fixed shape; otherwise null (never a guess). */
export function findBlockEnd(full: string): number | null {
  const ends: number[] = [];
  for (let i = full.indexOf(PROMPT_TAIL); i !== -1; i = full.indexOf(PROMPT_TAIL, i + 1)) {
    const end = i + PROMPT_TAIL.length;
    if (BLOCK.test(full.slice(0, end))) ends.push(end);
  }
  return ends.length === 1 ? ends[0]! : null;
}

/**
 * How the prompt text relates to the answers:
 *  follows: it begins with exactly what the answers compose (or it is still empty); `rest` is everything after (method steps, the member's own text);
 *  stale:   the generated block is identifiable but differs from the answers (an answer or the block was edited on its own); `rest` is what follows it;
 *  free:    no generated block can be identified reliably (free text, a demo starter, a block edited past recognition, or more than one possible reading).
 */
export type PromptLink = { readonly kind: 'follows' | 'stale'; readonly rest: string } | { readonly kind: 'free' };
export function analyzePrompt(full: string, fields: Pick<PromptFields, 'goal' | 'context' | 'format'>): PromptLink {
  if (full.trim() === '') return { kind: 'follows', rest: '' };
  const block = composePrompt(fields);
  if (full.startsWith(block)) return { kind: 'follows', rest: full.slice(block.length) };
  const end = findBlockEnd(full);
  return end === null ? { kind: 'free' } : { kind: 'stale', rest: full.slice(end) };
}

/** The prompt text after an answer changes: only a prompt that FOLLOWS its answers is rewritten, and only the generated block (the rest is kept). Null: leave the text alone. */
export function followEdit(full: string, before: PromptFields, after: PromptFields): string | null {
  const link = analyzePrompt(full, before);
  if (link.kind !== 'follows') return null;
  if (full.trim() === '' && after.goal.trim() === '' && after.context.trim() === '') return full; // an empty draft stays empty until there is something to say
  const next = composePrompt(after) + link.rest;
  return next.length <= LIMITS.prompt ? next : null;
}

/** "Rebuild from the answers": replaces the identified block and keeps what follows it. `keeps` is false when no block can be identified: then the WHOLE prompt would be replaced (the caller says so and asks first). Null: too long. */
export function rebuildPrompt(full: string, fields: PromptFields): { readonly text: string; readonly keeps: boolean } | null {
  const link = analyzePrompt(full, fields);
  const rest = link.kind === 'free' ? '' : link.rest;
  const text = composePrompt(fields) + rest;
  return text.length <= LIMITS.prompt ? { text, keeps: link.kind !== 'free' } : null;
}

// ---- the guided exchange (Build with Hack) ---------------------------------------------------------------------------------------------------------------
// Hack's questions are SCRIPTED: a fixed list in a fixed order, with fixed suggestion chips. The draft is the only state of the answers (each answer is one of the
// existing fields), so the exchange can be rebuilt from the draft at any time. Limits are text in the context field, after a fixed marker (decision D1: no new field).
export type StepId = 'goal' | 'context' | 'limits' | 'format' | 'title';
export const LIMITS_MARK = '\n\nLimits: ';
export function splitContext(context: string): { readonly context: string; readonly limits: string } {
  const i = context.lastIndexOf(LIMITS_MARK);
  if (i !== -1) return { context: context.slice(0, i), limits: context.slice(i + LIMITS_MARK.length) };
  return context.startsWith('Limits: ') ? { context: '', limits: context.slice('Limits: '.length) } : { context, limits: '' };
}
export function joinContext(context: string, limits: string): string {
  const c = context.trim(), l = limits.trim();
  return l === '' ? c : c === '' ? `Limits: ${l}` : `${c}${LIMITS_MARK}${l}`;
}

export interface Chip { readonly label: string; /** Text added to the answer box; null = skip this question. */ readonly insert: string | null }
export interface ChatStep { readonly id: StepId; readonly ask: string; readonly control: 'text' | 'format'; readonly chips: readonly Chip[]; readonly max: number }
export const CHAT_STEPS: readonly ChatStep[] = [
  { id: 'goal', ask: 'Hi, I’m Hack. What do you want an AI to do for you?', control: 'text', max: LIMITS.goal, chips: [{ label: 'Plan something', insert: 'Plan ' }, { label: 'Write something', insert: 'Write ' }, { label: 'Compare options', insert: 'Compare ' }, { label: 'Explain something', insert: 'Explain ' }] },
  { id: 'context', ask: 'Got it. What should the AI know? Think who, what and how much.', control: 'text', max: LIMITS.context, chips: [{ label: 'It’s for me', insert: 'It’s for me.' }, { label: 'It’s for my team', insert: 'It’s for my team.' }, { label: 'I have a budget', insert: 'I have a budget of ' }, { label: 'I’m short on time', insert: 'I’m short on time.' }] },
  { id: 'limits', ask: 'Any rules it should follow?', control: 'text', max: LIMITS.context, chips: [{ label: 'Keep it short', insert: 'Keep it short.' }, { label: 'Friendly tone', insert: 'Friendly tone.' }, { label: 'No jargon', insert: 'No jargon.' }, { label: 'Skip', insert: null }] },
  { id: 'format', ask: 'How should the answer look?', control: 'format', max: 0, chips: OUTPUT_FORMATS.map((f) => ({ label: f, insert: f })) },
  { id: 'title', ask: 'Last one: what will you call it?', control: 'text', max: LIMITS.title, chips: [] },
];
export const stepOf = (id: StepId): ChatStep => CHAT_STEPS.find((s) => s.id === id)!;

/** What the member has answered so far, read from the draft. `limitsSkipped` and `formatDone` are the two answers a field cannot show (an empty limits answer, a default format). */
export interface ChatFlags { readonly limitsSkipped: boolean; readonly formatDone: boolean }
export const answerOf = (id: StepId, f: PromptFields): string => id === 'goal' ? f.goal : id === 'context' ? splitContext(f.context).context : id === 'limits' ? splitContext(f.context).limits : id === 'format' ? f.format : f.title;
/** The draft field and value an answer to `id` sets. Null: the joined context would pass the field limit (the caller says so; nothing is changed). */
export function applyAnswer(id: StepId, text: string, f: PromptFields): { readonly field: keyof PromptFields; readonly value: string } | null {
  if (id === 'goal' || id === 'title') return { field: id, value: text.trim() };
  if (id === 'format') return { field: 'format', value: text };
  const s = splitContext(f.context);
  const value = id === 'context' ? joinContext(text, s.limits) : joinContext(s.context, text);
  return value.length <= LIMITS.context ? { field: 'context', value } : null;
}
/** The first question still open, or null when every question has an answer. */
export function nextStep(f: PromptFields, flags: ChatFlags): StepId | null {
  if (f.goal.trim() === '') return 'goal';
  if (answerOf('context', f).trim() === '') return 'context';
  if (answerOf('limits', f).trim() === '' && !flags.limitsSkipped) return 'limits';
  if (!flags.formatDone) return 'format';
  return f.title.trim() === '' ? 'title' : null;
}
/** A flat, deterministic suggestion for the title: the first words of the goal. */
export function titleSuggestion(goal: string): string {
  const words = goal.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean).slice(0, 6).join(' ');
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 60).replace(/[.,;:!?]+$/, '');
}
/** The exchange's completion flags are set by the event that creates a draft, never inferred later from what the fields happen to contain:
 *  a blank draft has asked nothing; a draft from a hack or a saved prompt arrives with every question already answered. */
export const CHAT_FRESH: ChatFlags = { limitsSkipped: false, formatDone: false };
export const CHAT_ANSWERED: ChatFlags = { limitsSkipped: true, formatDone: true };
export type StepStatus = 'filled' | 'empty' | 'skipped' | 'too_long';
export interface Progress { readonly id: StepId; readonly label: string; readonly status: StepStatus; readonly detail: string }
/** The "Getting there" chips: which questions have an answer, and whether an answer is past its length limit. Nothing about quality. */
export function gettingThere(f: PromptFields, flags: ChatFlags): { readonly items: readonly Progress[]; readonly allAnswered: boolean; readonly summary: string } {
  const mk = (id: StepId, label: string, value: string, max: number, optional: boolean, done: boolean): Progress => {
    const filled = id === 'format' ? done : value.trim() !== ''; // the format always holds a value; it counts once the member has chosen it
    if (filled && value.length > max) return { id, label, status: 'too_long', detail: `Over the limit (${value.length} of ${max})` };
    if (filled) return { id, label, status: 'filled', detail: 'Filled in' };
    if (optional && done) return { id, label, status: 'skipped', detail: 'Skipped' };
    return { id, label, status: 'empty', detail: 'Not yet' };
  };
  const ctx = splitContext(f.context);
  const items = [mk('goal', 'Goal', f.goal, LIMITS.goal, false, false), mk('context', 'Context', ctx.context, LIMITS.context, false, false), mk('limits', 'Limits', ctx.limits, LIMITS.context, true, flags.limitsSkipped), mk('format', 'Format', f.format, Number.POSITIVE_INFINITY, false, flags.formatDone), mk('title', 'Title', f.title, LIMITS.title, false, false)];
  const open = items.filter((i) => i.status === 'empty' || i.status === 'too_long').length;
  return { items, allAnswered: open === 0, summary: open === 0 ? 'Every question has an answer, and each is within its length limit.' : open === 1 ? '1 question still needs an answer.' : `${open} questions still need an answer.` };
}
