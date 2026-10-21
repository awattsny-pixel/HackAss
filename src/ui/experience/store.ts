// A tiny synchronous store: `dispatch` applies the reducer to the LATEST state immediately, so anything that reads `get()` (the save controller) sees exactly what is on
// screen at that moment, with no render in between. React subscribes with useSyncExternalStore. No browser storage: the state lives in memory only.
export interface Store<S, A> { get(): S; dispatch(a: A): void; subscribe(listener: () => void): () => void }
export function createStore<S, A>(initial: S, reduce: (s: S, a: A) => S): Store<S, A> {
  let state = initial; const listeners = new Set<() => void>();
  return {
    get: () => state,
    dispatch(a) { const next = reduce(state, a); if (next !== state) { state = next; for (const l of [...listeners]) l(); } },
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}
