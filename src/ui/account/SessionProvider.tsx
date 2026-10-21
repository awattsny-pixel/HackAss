'use client';
// The session indicator's client logic. Calls only this application's own endpoints (GET /auth/session, POST /auth/sign-out); never an Auth provider,
// never a token. A failed or slow check is "can't check right now", never a sign-out, and it never touches the unsaved prompt (that state is not read here).
// Checks and auth actions are COORDINATED (session-coordinator.ts): an older answer cannot overwrite a newer sign-in or sign-out.
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { useExperience } from '../experience/ExperienceProvider.tsx';
import { createSessionCoordinator, type CheckOutcome, type SessionCoordinator } from './session-coordinator.ts';
import { initialSession, interpretSessionResponse, reduceSession, shouldRecheck, type SessionState } from './session-state.ts';

interface Ctx {
  readonly session: SessionState;
  readonly recheck: () => Promise<void>;
  /** Call before a sign-in request; call the returned function when that request has finished (success or not). */
  readonly beginAuthAction: () => Promise<() => void>;
  readonly markSignedIn: () => void;
  readonly signOut: () => Promise<boolean>;
}
const SessionContext = createContext<Ctx | null>(null);
export function useSession(): Ctx { const c = useContext(SessionContext); if (!c) throw new Error('useSession must be used inside SessionProvider'); return c; }

const CHECK_TIMEOUT_MS = 6000;
async function fetchSession(signal: AbortSignal): Promise<CheckOutcome> {
  const res = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]) });
  let body: unknown = null; try { body = await res.json(); } catch { body = null; }
  return interpretSessionResponse(res.status, body);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, dispatch] = useReducer(reduceSession, initialSession);
  const { toast } = useExperience();
  const coord = useRef<SessionCoordinator | null>(null);
  if (coord.current === null) coord.current = createSessionCoordinator((e) => dispatch(e));
  const lastAt = useRef<number | null>(null);

  const recheck = useCallback(async () => { await coord.current!.check(fetchSession); lastAt.current = Date.now(); }, []);

  // first check, then re-check whenever the page regains focus / becomes visible / comes back online / is restored from the back-forward cache
  useEffect(() => {
    void recheck();
    const maybe = () => { if (document.visibilityState === 'visible' && shouldRecheck(lastAt.current, Date.now())) void recheck(); };
    const online = () => { void recheck(); };
    window.addEventListener('focus', maybe); document.addEventListener('visibilitychange', maybe); window.addEventListener('online', online); window.addEventListener('pageshow', maybe);
    return () => { window.removeEventListener('focus', maybe); document.removeEventListener('visibilitychange', maybe); window.removeEventListener('online', online); window.removeEventListener('pageshow', maybe); };
  }, [recheck]);

  useEffect(() => {
    if (session.notice === 'signed_out') { toast('You have been signed out. Your unsaved work on this page is still here.'); dispatch({ type: 'notice_shown' }); }
  }, [session.notice, toast]);

  const beginAuthAction = useCallback(() => coord.current!.beginAction(), []);
  const markSignedIn = useCallback(() => { lastAt.current = Date.now(); coord.current!.signedIn(); }, []);
  const signOut = useCallback(async () => {
    const end = await coord.current!.beginAction();
    try {
      const res = await fetch('/auth/sign-out', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (!res.ok) throw new Error('sign-out failed');
      lastAt.current = Date.now(); coord.current!.signedOut(); toast('Signed out. Your unsaved work on this page is still here.'); return true;
    } catch { toast('Could not sign out right now. Please try again.'); return false; }
    finally { end(); }
  }, [toast]);

  const value = useMemo<Ctx>(() => ({ session, recheck, beginAuthAction, markSignedIn, signOut }), [session, recheck, beginAuthAction, markSignedIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
