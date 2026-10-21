// The signed-in indicator's state, as a pure reducer. The rules that matter:
//  * An Auth outage NEVER signs anyone out: a member who cannot be re-checked stays shown as signed in ("degraded"), with a notice that the check failed.
//  * Only a definite "anonymous" after having been a member shows the "you have been signed out" notice.
//  * A STALE answer can never overwrite a newer action: every check carries the generation it started in; sign-in, sign-out and the start of any auth
//    action advance the generation, and a result from an older generation is discarded (both directions: an old "anonymous" cannot undo a sign-in,
//    an old "member" cannot undo a sign-out).
//  * Nothing here touches the member's unsaved prompt or reflection (those live in ExperienceProvider and are not read or written by this file).
export type SessionStatus = 'checking' | 'anonymous' | 'member' | 'degraded' | 'unavailable';
export type SessionNotice = null | 'signed_out' | 'cant_check';
export interface SessionState {
  readonly status: SessionStatus; readonly setupPending: boolean; readonly notice: SessionNotice; readonly lastCheckedAt: number | null; readonly generation: number;
  /** Advances whenever the signed-in account may have changed (sign-in, sign-out, or a check that finds the member signed out / signed in elsewhere). Private content fetched under an older value must not stay on screen. */
  readonly accountEpoch: number;
}
export const initialSession: SessionState = { status: 'checking', setupPending: false, notice: null, lastCheckedAt: null, generation: 0, accountEpoch: 0 };

export type SessionEvent =
  | { readonly type: 'result'; readonly gen: number; readonly result: 'member' | 'anonymous' | 'unavailable'; readonly setupPending?: boolean; readonly at: number }
  | { readonly type: 'action_begin' | 'action_end'; readonly gen: number }
  | { readonly type: 'signed_in'; readonly gen: number; readonly at: number }
  | { readonly type: 'signed_out'; readonly gen: number; readonly at: number }
  | { readonly type: 'notice_shown' };

const wasMember = (s: SessionStatus): boolean => s === 'member' || s === 'degraded';
const advance = (state: SessionState, gen: number): SessionState => (gen > state.generation ? { ...state, generation: gen } : state);

export function reduceSession(state: SessionState, e: SessionEvent): SessionState {
  switch (e.type) {
    case 'result': {
      if (e.gen < state.generation) return state; // obsolete: an auth action began after this check started
      if (e.result === 'member') return { ...state, status: 'member', setupPending: e.setupPending === true, notice: null, lastCheckedAt: e.at, accountEpoch: state.status === 'anonymous' ? state.accountEpoch + 1 : state.accountEpoch };
      if (e.result === 'anonymous') return { ...state, status: 'anonymous', setupPending: false, notice: wasMember(state.status) ? 'signed_out' : null, lastCheckedAt: e.at, accountEpoch: wasMember(state.status) ? state.accountEpoch + 1 : state.accountEpoch };
      // unavailable: never a sign-out, never a downgrade of what we last knew
      if (wasMember(state.status)) return { ...state, status: 'degraded', notice: 'cant_check', lastCheckedAt: e.at };
      if (state.status === 'anonymous') return { ...state, lastCheckedAt: e.at };
      return { ...state, status: 'unavailable', lastCheckedAt: e.at };
    }
    case 'action_begin': case 'action_end': return advance(state, e.gen);
    case 'signed_in': return { ...advance(state, e.gen), status: 'member', setupPending: false, notice: null, lastCheckedAt: e.at, accountEpoch: state.accountEpoch + 1 };
    case 'signed_out': return { ...advance(state, e.gen), status: 'anonymous', setupPending: false, notice: null, lastCheckedAt: e.at, accountEpoch: state.accountEpoch + 1 };
    case 'notice_shown': return state.notice === 'signed_out' ? { ...state, notice: null } : state; // 'cant_check' stays visible in the indicator itself
  }
}

/** Re-check when the page regains focus, but not more often than `minMs` (and never while a check is running: the coordinator guards that). */
export const shouldRecheck = (lastCheckedAt: number | null, now: number, minMs = 10_000): boolean => lastCheckedAt === null || now - lastCheckedAt >= minMs;

/** What the page may do with a response from GET /auth/session. Anything unexpected is "unavailable", never "anonymous". */
export function interpretSessionResponse(status: number, body: unknown): { result: 'member' | 'anonymous' | 'unavailable'; setupPending: boolean } {
  if (status === 200 && body && typeof body === 'object') {
    const b = body as { state?: unknown; setupPending?: unknown };
    if (b.state === 'member') return { result: 'member', setupPending: b.setupPending === true };
    if (b.state === 'anonymous') return { result: 'anonymous', setupPending: false };
  }
  return { result: 'unavailable', setupPending: false };
}
