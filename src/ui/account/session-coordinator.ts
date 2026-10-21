// Coordinates session checks with sign-in and sign-out so an older answer can never overwrite a newer action, and an older refresh response can never
// replace newer session cookies. Pure (no React, no fetch): the provider supplies the network functions, the tests supply delayed ones.
//   * at most ONE check runs at a time, and none starts while an auth action is running;
//   * an auth action first ADVANCES the generation (so the result of any check already running is obsolete), CANCELS that check and WAITS until it has
//     settled, and only then sends its own request: the two requests never overlap, so their Set-Cookie headers cannot interleave;
//   * a check carries the generation it started in; the reducer discards a result from an older generation.
import type { SessionEvent } from './session-state.ts';

export type CheckOutcome = { result: 'member' | 'anonymous' | 'unavailable'; setupPending: boolean };

export function createSessionCoordinator(emit: (e: SessionEvent) => void, now: () => number = Date.now) {
  let gen = 0; let actions = 0;
  let current: { promise: Promise<void>; abort: () => void } | null = null;

  /** `run` receives an AbortSignal that is aborted when an auth action begins. Resolves when the check has settled (its result may have been discarded). */
  function check(run: (signal: AbortSignal) => Promise<CheckOutcome>): Promise<void> {
    if (actions > 0) return Promise.resolve();      // never during an auth action
    if (current) return current.promise;            // never two at once
    const my = gen; const ctl = new AbortController();
    const promise = (async () => {
      let out: CheckOutcome = { result: 'unavailable', setupPending: false };
      try { out = await run(ctl.signal); } catch { /* network error, abort or timeout: unavailable */ }
      emit({ type: 'result', gen: my, result: out.result, setupPending: out.setupPending, at: now() }); // the reducer drops it if gen is obsolete
    })().finally(() => { if (current?.promise === promise) current = null; });
    current = { promise, abort: () => ctl.abort() };
    return promise;
  }

  /** Call before sending a sign-in or sign-out request; call the returned function when that request is finished (whatever its outcome). */
  async function beginAction(): Promise<() => void> {
    gen += 1; actions += 1; emit({ type: 'action_begin', gen });
    const running = current; if (running) { running.abort(); await running.promise; }
    let ended = false;
    return () => { if (ended) return; ended = true; actions -= 1; gen += 1; emit({ type: 'action_end', gen }); };
  }
  function signedIn() { gen += 1; emit({ type: 'signed_in', gen, at: now() }); }
  function signedOut() { gen += 1; emit({ type: 'signed_out', gen, at: now() }); }
  return { check, beginAction, signedIn, signedOut, get generation() { return gen; }, get busy() { return actions > 0; } };
}
export type SessionCoordinator = ReturnType<typeof createSessionCoordinator>;
