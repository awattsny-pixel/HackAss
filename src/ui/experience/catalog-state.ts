// The catalog list's client state as a pure reducer. The server result is the source of truth: whenever it changes (a different category, a refresh,
// a retry) the list, the cursor and every pagination error are reset to it, and a "Load more" answer that belongs to an OLDER server result is ignored.
import type { CardItem, CatalogView, Cursor } from './SparkCatalog.tsx';

export interface ListState { readonly renderId: string; readonly items: readonly CardItem[]; readonly cursor: Cursor | null; readonly busy: boolean; readonly moreError: boolean }
export type ListAction =
  | { type: 'sync'; view: CatalogView }
  | { type: 'start' }
  | { type: 'done'; renderId: string; items: readonly CardItem[]; cursor: Cursor | null }
  | { type: 'fail'; renderId: string };

export const initList = (view: CatalogView): ListState => ({ renderId: view.renderId, items: view.items, cursor: view.nextCursor, busy: false, moreError: false });

export function reduceList(state: ListState, a: ListAction): ListState {
  switch (a.type) {
    case 'sync': return a.view.renderId === state.renderId ? state : initList(a.view);
    case 'start': return { ...state, busy: true, moreError: false };
    case 'done':
      if (a.renderId !== state.renderId) return state; // answer for an older category/result: discard
      return { ...state, items: [...state.items, ...a.items.filter((n) => !state.items.some((c) => c.slug === n.slug))], cursor: a.cursor, busy: false, moreError: false };
    case 'fail': return a.renderId !== state.renderId ? state : { ...state, busy: false, moreError: true };
  }
}
