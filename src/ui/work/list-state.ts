// The state of a paged private list as a pure reducer. Every load (first page, filter change, retry, account change) starts a new GENERATION and records the
// ACCOUNT EPOCH it was requested under; every answer carries the generation it was requested in, and an answer for another generation is dropped whole: its rows
// and its cursor never enter a different view. A list loaded under an older account epoch is not shown at all (the screen treats it as loading).
export type ListState<I, C> =
  | { readonly gen: number; readonly epoch: number; readonly s: 'loading' }
  | { readonly gen: number; readonly epoch: number; readonly s: 'error'; readonly kind: string }
  | { readonly gen: number; readonly epoch: number; readonly s: 'ready'; readonly items: readonly I[]; readonly next: C | null; readonly more: 'idle' | 'loading' | 'error' };
export type ListAction<I, C> =
  | { readonly type: 'load'; readonly gen: number; readonly epoch: number }                                                      // a new view: first page requested
  | { readonly type: 'loaded'; readonly gen: number; readonly items: readonly I[]; readonly next: C | null }
  | { readonly type: 'failed'; readonly gen: number; readonly kind: string }
  | { readonly type: 'more'; readonly gen: number }
  | { readonly type: 'moreLoaded'; readonly gen: number; readonly items: readonly I[]; readonly next: C | null }
  | { readonly type: 'moreFailed'; readonly gen: number };

export const initialList = <I, C>(): ListState<I, C> => ({ gen: 0, epoch: 0, s: 'loading' });
/** What the screen may show: nothing from another account epoch. */
export const visibleList = <I, C>(st: ListState<I, C>, epoch: number): ListState<I, C> => (st.epoch === epoch ? st : { gen: st.gen, epoch, s: 'loading' });

export function reduceList<I extends { readonly id: string }, C>(st: ListState<I, C>, a: ListAction<I, C>): ListState<I, C> {
  if (a.type === 'load') return a.gen > st.gen ? { gen: a.gen, epoch: a.epoch, s: 'loading' } : st;   // whatever was on screen is gone at once
  if (a.gen !== st.gen) return st;                                                                      // an answer for another view: ignored
  switch (a.type) {
    case 'loaded': return st.s === 'loading' ? { gen: st.gen, epoch: st.epoch, s: 'ready', items: a.items, next: a.next, more: 'idle' } : st;
    case 'failed': return st.s === 'loading' ? { gen: st.gen, epoch: st.epoch, s: 'error', kind: a.kind } : st;
    case 'more': return st.s === 'ready' && st.next && st.more !== 'loading' ? { ...st, more: 'loading' } : st;
    case 'moreLoaded': return st.s === 'ready' && st.more === 'loading' ? { ...st, items: [...st.items, ...a.items.filter((i) => !st.items.some((j) => j.id === i.id))], next: a.next, more: 'idle' } : st;
    case 'moreFailed': return st.s === 'ready' && st.more === 'loading' ? { ...st, more: 'error' } : st;
  }
}
