'use client';
// When the signed-in account may have changed (sign-out, sign-in, a check that finds the member signed out), nothing private about the old account stays attached to the
// draft: pending acknowledgments are dropped, saved links, conflict copies and messages are cleared, unsaved result edits are discarded, and the manual-copy dialog and pending clipboard requests are invalidated. The draft's own text is the member's and stays, unsaved.
import { useEffect, useRef } from 'react';
import { useExperience } from '../experience/ExperienceProvider.tsx';
import { useSession } from '../account/SessionProvider.tsx';

export function AccountBoundary() {
  const { session } = useSession();
  const { dispatch, edits, invalidateCopies } = useExperience();
  const seen = useRef(session.accountEpoch);
  useEffect(() => {
    if (seen.current === session.accountEpoch) return;
    seen.current = session.accountEpoch;
    dispatch({ type: 'accountChanged' });
    edits.dispatch({ type: 'clearAll' });   // unsaved result edits of the old account are dropped too
    invalidateCopies();                      // an open manual-copy dialog is closed and cleared; a clipboard request still running can no longer reopen it or announce success
  }, [session.accountEpoch, dispatch, edits, invalidateCopies]);
  return null;
}
