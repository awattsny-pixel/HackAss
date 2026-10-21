'use client';
// The Reveal's "Save this result". If the prompt is saved and unchanged the result is attached to it at the version the member tried; otherwise ONE operation
// saves the prompt AND the result (both stored, or neither). A result keeps a snapshot of what was tried, made by the database at save time.
import Link from 'next/link';
import { useExperience } from '../experience/ExperienceProvider.tsx';
import { resultSaveView } from '../experience/state.ts';
import { useSession } from '../account/SessionProvider.tsx';
import { ConflictPanel } from './ConflictPanel.tsx';
import { isRetryable, PRIVACY_NOTE, problemText, resultStatusText } from './messages.ts';

export function ResultSavePanel() {
  const { state, work } = useExperience();
  const { session } = useSession();
  const view = resultSaveView(state);
  const w = state.work;
  const busy = w.inFlight !== null;
  const promptCurrent = w.saved !== null && w.revision === w.savedRevision;
  const problem = w.problem && w.problem.during !== 'prompt_create' && w.problem.during !== 'prompt_update' ? w.problem : null;
  const pillClass = view === 'not_saved' || view === 'changed' ? '' : view;
  const hasResult = w.savedResult !== null;
  const changed = w.reflectionRevision > w.reflectionSavedRevision;
  return (
    <section className="save-panel" aria-labelledby="save-result-h">
      <div className="save-head">
        <h3 id="save-result-h">Save this result</h3>
        <span id="result-status" className={`save-pill ${pillClass}`} role="status" aria-live="polite">{resultStatusText(view, w.savedResult?.savedAt ?? null)}</span>
      </div>
      <p className="muted small" id="result-explain">{promptCurrent
        ? 'Your result will be saved with the prompt you tried (as it is saved now).'
        : w.saved ? 'Your prompt has changed since it was saved. Saving now updates the saved prompt and saves your result together: both are saved, or neither.'
          : 'Your prompt isn’t saved yet. Saving now saves the prompt and your result together: both are saved, or neither.'}</p>
      <div className="actions">
        {hasResult ? (
          <>
            <button type="button" id="result-update" className="btn primary" disabled={busy || !changed} onClick={() => { void work.saveResult('update'); }}>Update saved result</button>
            <button type="button" id="result-new" className="btn" disabled={busy} onClick={() => { void work.saveResult('new'); }}>Save as a new result</button>
            <Link className="btn subtle" id="open-my-results" href="/account/results">My results</Link>
          </>
        ) : (
          <button type="button" id="result-save" className="btn primary" disabled={busy} aria-busy={busy && view === 'saving'} onClick={() => { void work.saveResult('save'); }}>{promptCurrent ? 'Save this result' : 'Save prompt and result'}</button>
        )}
      </div>
      {session.status === 'anonymous' ? <p className="save-note" id="result-anon">You’re not signed in. <Link href="/account/sign-in?next=%2Freveal">Sign in</Link> to save; your reflection stays on this page.</p> : null}
      {problem ? (
        <div className="save-msg" id="result-problem" role="alert">
          {problemText(problem)}
          <div className="actions" style={{ marginTop: 8 }}>
            {problem.kind === 'signin' ? <Link className="btn" id="result-signin" href="/account/sign-in?next=%2Freveal">Sign in</Link> : null}
            {isRetryable(problem) || problem.kind === 'signin' ? <button type="button" className="btn" id="result-retry" disabled={busy} onClick={() => { void work.saveResult(hasResult ? 'update' : 'save'); }}>Try saving again</button> : null}
            {problem.kind === 'result_gone' ? <button type="button" className="btn" id="result-as-new" disabled={busy} onClick={() => { void work.saveResult('new'); }}>Save as a new result</button> : null}
          </div>
        </div>
      ) : null}
      {w.conflict ? <ConflictPanel conflict={w.conflict} /> : null}
      <p className="save-note">{PRIVACY_NOTE}</p>
    </section>
  );
}
