'use client';
// The Lab's Save area: explicit Save (no autosave), Save as new copy, the status the plan defines, calm failure messages with the draft untouched, and the
// conflict choices. Saving never clears or alters the working draft.
import Link from 'next/link';
import { useExperience } from '../experience/ExperienceProvider.tsx';
import { promptSaveView } from '../experience/state.ts';
import { useSession } from '../account/SessionProvider.tsx';
import { ConflictPanel } from './ConflictPanel.tsx';
import { isRetryable, PRIVACY_NOTE, problemText, promptStatusText } from './messages.ts';

export function SavePanel() {
  const { state, work, dispatch } = useExperience();
  const { session } = useSession();
  const view = promptSaveView(state);
  const w = state.work;
  const busy = w.inFlight !== null;
  const problem = w.problem && w.problem.during !== 'result_new' && w.problem.during !== 'result_update' ? w.problem : null;
  const pillClass = view === 'not_saved' || view === 'changed' ? '' : view;
  const anon = session.status === 'anonymous' && w.saved === null;
  return (
    <section className="save-panel" aria-labelledby="save-h">
      <div className="save-head">
        <h3 id="save-h">Save to your account</h3>
        <span id="save-status" className={`save-pill ${pillClass}`} role="status" aria-live="polite">{promptStatusText(view, w.saved?.savedAt ?? null)}</span>
      </div>
      <div className="actions">
        <button type="button" id="save-prompt" className="btn primary" disabled={busy} aria-busy={busy && view === 'saving'} onClick={() => { void work.savePrompt('save'); }}>{w.saved ? 'Save changes' : 'Save prompt'}</button>
        <button type="button" id="save-copy" className="btn" disabled={busy} onClick={() => { void work.savePrompt('copy'); }}>Save as new copy</button>
        {w.saved ? <Link className="btn subtle" id="open-my-prompts" href="/account/prompts">My prompts</Link> : null}
      </div>
      {anon ? <p className="save-note" id="save-anon">You’re not signed in. <Link href="/account/sign-in?next=%2Flab">Sign in</Link> to save; your draft stays on this page.</p> : null}
      {problem ? (
        <div className="save-msg" id="save-problem" role="alert">
          {problemText(problem)}
          <div className="actions" style={{ marginTop: 8 }}>
            {problem.kind === 'signin' ? <Link className="btn" id="save-signin" href="/account/sign-in?next=%2Flab">Sign in</Link> : null}
            {isRetryable(problem) || problem.kind === 'signin' ? <button type="button" className="btn" id="save-retry" disabled={busy} onClick={() => { void work.savePrompt('save'); }}>Try saving again</button> : null}
            {problem.kind === 'gone' ? <button type="button" className="btn" id="save-as-new" disabled={busy} onClick={() => { dispatch({ type: 'unlink', target: 'prompt', id: w.saved?.id ?? '' }); void work.savePrompt('copy'); }}>Save as a new prompt</button> : null}
            <button type="button" className="btn subtle" onClick={() => dispatch({ type: 'dismissProblem' })}>Dismiss</button>
          </div>
        </div>
      ) : null}
      {w.conflict?.target === 'prompt' ? <ConflictPanel conflict={w.conflict} /> : null}
      <p className="save-note">{PRIVACY_NOTE}</p>
    </section>
  );
}
