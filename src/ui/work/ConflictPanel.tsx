'use client';
// "Saved elsewhere — choose". Shown when the saved copy differs from what the member is saving (another tab or device changed it, or a retried save met a newer
// version). Nothing is lost silently: loading the saved version and overwriting both need an explicit confirmation, and saving a copy changes nothing that exists.
import { useExperience } from '../experience/ExperienceProvider.tsx';
import type { Conflict } from '../experience/state.ts';

export function ConflictPanel({ conflict }: { conflict: Conflict }) {
  const { state, dispatch, confirm, work } = useExperience();
  const isPrompt = conflict.target === 'prompt';
  const mine = isPrompt ? `${state.fields.title}\n\n${state.fullPrompt}` : `${state.reflection.text}\n\nNext: ${state.reflection.next}`;
  const theirs = conflict.target === 'prompt' ? `${conflict.server.title}\n\n${conflict.server.full_prompt}` : `${conflict.server.reflection}\n\nNext: ${conflict.server.next_change}`;
  const noun = isPrompt ? 'prompt' : 'result';
  return (
    <div className="conflict-box" role="group" aria-labelledby="conflict-h">
      <h4 id="conflict-h">This {noun} was saved from somewhere else</h4>
      <p className="muted small">The saved copy is different from yours. Nothing has been changed. Choose what to do with your version.</p>
      <div className="conflict-cols">
        <div><strong className="small">Saved version</strong><div className="sample" tabIndex={0} aria-label="Saved version">{theirs}</div></div>
        <div><strong className="small">Your version</strong><div className="sample" tabIndex={0} aria-label="Your version">{mine}</div></div>
      </div>
      <div className="actions">
        <button type="button" className="btn" id="conflict-load" onClick={() => confirm({
          title: 'Load the saved version?', message: `Your ${noun} on this page will be replaced by the saved version. Copy anything you want to keep first.`, confirmLabel: 'Load the saved version', cancelLabel: 'Keep mine',
          run: () => dispatch(conflict.target === 'prompt' ? { type: 'useServerPrompt', detail: conflict.server, at: Date.now() } : { type: 'useServerResult', detail: conflict.server, at: Date.now() }),
        })}>Load the saved version</button>
        <button type="button" className="btn" id="conflict-copy" onClick={() => { void work.saveCopy(); }}>{isPrompt ? 'Save mine as a copy' : 'Save mine as a new result'}</button>
        <button type="button" className="btn" id="conflict-overwrite" onClick={() => confirm({
          title: `Overwrite the saved ${noun}?`, message: `The saved ${noun} will be replaced by your version. The saved version will be gone. This can’t be undone.`, confirmLabel: 'Overwrite the saved version', cancelLabel: 'Keep both for now', danger: true,
          run: () => { void work.overwrite(); },
        })}>Overwrite the saved version</button>
        <button type="button" className="btn subtle" id="conflict-dismiss" onClick={() => dispatch({ type: 'dismissProblem' })}>Keep editing</button>
      </div>
    </div>
  );
}
