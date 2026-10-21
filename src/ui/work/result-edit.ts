// The result-detail editor as a pure reducer, with the same protection the Lab has: every edit advances a form revision; a save submits a captured revision and its
// exact words; success marks ONLY that revision saved, so words typed while the request ran stay in the open form as unsaved edits; only a form that has not
// changed since the submission is closed. A failure changes nothing. Answers that do not belong to the save in flight (or to another account epoch) are ignored.
import type { ResultDetail } from '../../modules/mywork/index.ts';

export interface Words { readonly outcome: string; readonly reflection: string; readonly next: string }
export interface Base extends Words { readonly id: string; readonly version: number }
export interface EditState {
  readonly base: Base | null;                  // the saved words and version as last known
  readonly form: Words | null;                 // non-null while the editor is open
  readonly rev: number;                        // form revision: advances with every edit
  readonly inFlight: { readonly token: string; readonly rev: number; readonly words: Words } | null;
  readonly conflict: ResultDetail | null;      // the saved copy that differs from mine (changed elsewhere)
  readonly problem: string | null;
}
export const initialEdit: EditState = { base: null, form: null, rev: 0, inFlight: null, conflict: null, problem: null };

export type EditAction =
  | { type: 'loaded'; detail: ResultDetail }           // the saved copy was (re)fetched; with an open editor it can only raise a conflict, never move the base version
  | { type: 'open' } | { type: 'cancel' }
  | { type: 'edit'; field: keyof Words; value: string }
  | { type: 'saveBegin'; token: string }
  | { type: 'saveDone'; token: string; version: number }
  | { type: 'saveFail'; token: string; problem: string }
  | { type: 'conflict'; token: string; server: ResultDetail }
  | { type: 'loadServer'; server: ResultDetail }       // the member confirmed: the saved version replaces the form
  | { type: 'adoptVersion'; version: number }          // the member confirmed an overwrite: build on the version that is saved now
  | { type: 'reset' };                                 // another account / a reload: nothing private stays

const baseOf = (d: ResultDetail): Base => ({ id: d.id, version: d.version, outcome: d.outcome, reflection: d.reflection, next: d.next_change });
export const sameWords = (a: Words, b: Words): boolean => a.outcome === b.outcome && a.reflection === b.reflection && a.next === b.next;
/** Unsaved edits exist: the editor is open and differs from the saved words. Drives the leave-page and in-app navigation guards. */
export const editDirty = (s: EditState): boolean => s.form !== null && s.base !== null && !sameWords(s.form, s.base);

export function reduceEdit(s: EditState, a: EditAction): EditState {
  switch (a.type) {
    case 'loaded': {
      if (s.form === null || s.base?.id !== a.detail.id) return { ...initialEdit, base: baseOf(a.detail) };   // no open editor: the saved copy simply replaces what we knew
      // An editor is open, so there are (possibly unsaved) edits that were made against s.base.version. A refresh must NEVER move that concurrency version forward:
      // adopting it silently would let the next Save overwrite whoever saved in between. While a save is in flight its own answer updates the base; otherwise a
      // newer saved version is reported as an explicit conflict (words intact), and only the member's choice (load / overwrite) adopts it.
      if (s.inFlight) return s;
      if (a.detail.version === s.base.version) return { ...s, base: baseOf(a.detail) };
      return a.detail.version > s.base.version ? { ...s, conflict: a.detail } : s;
    }
    case 'open': return s.base ? { ...s, form: { outcome: s.base.outcome, reflection: s.base.reflection, next: s.base.next }, rev: 0, inFlight: null, conflict: null, problem: null } : s;
    case 'cancel': return { ...s, form: null, inFlight: null, conflict: null, problem: null };
    case 'edit': return s.form ? { ...s, form: { ...s.form, [a.field]: a.value }, rev: s.rev + 1 } : s;
    case 'saveBegin': return s.form && !s.inFlight ? { ...s, inFlight: { token: a.token, rev: s.rev, words: s.form }, problem: null } : s;
    case 'saveDone': {
      const f = s.inFlight; if (!f || f.token !== a.token || !s.base) return s;
      const base: Base = { ...s.base, ...f.words, version: a.version };      // the saved copy is exactly what was submitted
      return { ...s, base, inFlight: null, conflict: null, problem: null, form: s.rev === f.rev ? null : s.form }; // newer typing keeps the form open and unsaved
    }
    case 'saveFail': return s.inFlight?.token === a.token ? { ...s, inFlight: null, problem: a.problem } : s;
    case 'conflict': return s.inFlight?.token === a.token ? { ...s, inFlight: null, conflict: a.server, problem: null } : s;
    case 'loadServer': return { ...s, base: baseOf(a.server), form: { outcome: a.server.outcome, reflection: a.server.reflection, next: a.server.next_change }, rev: 0, inFlight: null, conflict: null, problem: null };
    case 'adoptVersion': return s.base ? { ...s, base: { ...s.base, version: a.version }, conflict: null } : s;
    case 'reset': return initialEdit;
  }
}
