// Pure helpers that turn the draft into what is sent, and decide whether a stored copy equals what the member submitted.
import type { ExperienceState } from '../experience/state.ts';
import { NO_ORIGINAL } from '../experience/state.ts';
import type { Reflection } from '../experience/types.ts';
import { LIMITS } from '../../modules/mywork/index.ts';
import type { PromptDetail, ResultDetail } from '../../modules/mywork/index.ts';
import type { PromptDocBody, ResultDocBody } from './api.ts';

export type Built<T> = { readonly ok: true; readonly doc: T } | { readonly ok: false; readonly field: string };

/** The prompt as it would be saved. A scratch draft's placeholder sentence is not stored as a "starting prompt". */
export function buildPromptDoc(s: Pick<ExperienceState, 'fields' | 'fullPrompt' | 'startingPrompt' | 'work'>): Built<PromptDocBody> {
  const title = s.fields.title.trim();
  if (title.length === 0 || title.length > LIMITS.title) return { ok: false, field: 'title' };
  if (s.fullPrompt.trim().length === 0) return { ok: false, field: 'full_prompt' };
  const o = s.work.originRef;
  return { ok: true, doc: {
    title, goal: s.fields.goal, context: s.fields.context, output_format: s.fields.format, full_prompt: s.fullPrompt,
    starting_prompt: s.startingPrompt === NO_ORIGINAL ? '' : s.startingPrompt,
    origin_kind: o.kind, ...(o.kind === 'catalog' ? { origin_slug: o.slug, origin_title: o.title.slice(0, LIMITS.originTitle) } : o.kind === 'demo' ? { origin_title: o.title.slice(0, LIMITS.originTitle) } : {}),
  } };
}
export function buildResultDoc(r: Reflection): Built<ResultDocBody> {
  if (r.outcome === '') return { ok: false, field: 'outcome' };
  return { ok: true, doc: { outcome: r.outcome, reflection: r.text, next_change: r.next } };
}
/** Does the stored prompt equal what was submitted? (Used to decide whether a save that met a newer version actually already happened.) */
export const promptMatches = (doc: PromptDocBody, d: PromptDetail): boolean =>
  d.title === doc.title && d.goal === doc.goal && d.context === doc.context && d.output_format === doc.output_format && d.full_prompt === doc.full_prompt && d.starting_prompt === doc.starting_prompt
  && d.origin_kind === doc.origin_kind && (d.origin_slug ?? undefined) === doc.origin_slug && (d.origin_title ?? undefined) === doc.origin_title;
export const resultMatches = (doc: ResultDocBody, d: ResultDetail): boolean => d.outcome === doc.outcome && d.reflection === doc.reflection && d.next_change === doc.next_change;
