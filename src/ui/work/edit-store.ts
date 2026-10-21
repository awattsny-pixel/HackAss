// Unsaved result-detail edits live in SHARED, in-memory state (the experience provider outlives route changes), keyed by account epoch AND result id. Leaving the
// page by the browser's Back button and coming back with Forward finds the editor as it was; explicitly choosing "Leave and discard" (or Cancel with a confirmation)
// removes it. Nothing is written to browser storage. When the account changes (sign-out, sign-in) the whole map is cleared, and the epoch in the key means state of an
// older account can never be reached again.
import { initialEdit, reduceEdit, type EditAction, type EditState } from './result-edit.ts';

export type EditMap = Readonly<Record<string, EditState>>;
export type EditMapAction = { readonly type: 'apply'; readonly key: string; readonly action: EditAction } | { readonly type: 'clearAll' };
export const emptyEdits: EditMap = Object.freeze({});
export const editKey = (epoch: number, resultId: string): string => `${epoch}|${resultId}`;
export const editFor = (m: EditMap, key: string): EditState => m[key] ?? initialEdit;

export function reduceEditMap(m: EditMap, a: EditMapAction): EditMap {
  if (a.type === 'clearAll') return Object.keys(m).length === 0 ? m : emptyEdits;
  const prev = editFor(m, a.key), next = reduceEdit(prev, a.action);
  if (next === prev) return m;
  if (a.action.type === 'reset') { const rest = { ...m }; delete rest[a.key]; return rest; }   // an explicit discard leaves nothing behind
  return { ...m, [a.key]: next };
}
