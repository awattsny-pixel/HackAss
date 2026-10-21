'use client';
// One saved result: the starting version, the prompt that was tried and the member's words, all as they were when saved. The member can edit their own words
// (never the snapshot). The editor has the Lab's protection: a save submits a captured revision, success marks only that revision saved (words typed meanwhile stay
// in the open form, unsaved), leaving with unsaved edits asks first, and loading the saved version over local edits needs confirmation. All of it is dropped when the
// account changes.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useExperience } from '../experience/ExperienceProvider.tsx';
import { originLabel } from '../experience/state.ts';
import { OUTCOME_LABELS } from '../experience/prompt.ts';
import { formatDate } from '../experience/format.ts';
import type { ResultDetail } from '../../modules/mywork/index.ts';
import { OUTCOMES } from '../../modules/mywork/index.ts';
import { useSession } from '../account/SessionProvider.tsx';
import { workApi } from './api.ts';
import { failureText } from './messages.ts';
import { editFor, editKey } from './edit-store.ts';
import { editDirty, type EditAction } from './result-edit.ts';
import { useUnsavedGuard } from './unsaved-guard.ts';
import { WorkProblem, WorkTabs } from './WorkChrome.tsx';

type View = { s: 'loading'; epoch: number } | { s: 'error'; epoch: number; kind: string } | { s: 'ready'; epoch: number; d: ResultDetail };

export function ResultDetailScreen({ id }: { id: string }) {
  const router = useRouter();
  const { session } = useSession();
  const epoch = session.accountEpoch;
  const { dispatch, confirm, toast, edits } = useExperience();
  const [raw, setView] = useState<View>({ s: 'loading', epoch });
  const view: View = raw.epoch === epoch ? raw : { s: 'loading', epoch };   // nothing fetched under another account is ever shown
  // The editor state is SHARED and in memory, keyed by account epoch + result id: Back then Forward restores unsaved edits; an account change clears it.
  const key = editKey(epoch, id);
  const map = useSyncExternalStore(edits.subscribe, edits.get, edits.get);
  const ed = editFor(map, key);
  const edit = (a: EditAction) => edits.dispatch({ type: 'apply', key, action: a });   // async callbacks below keep the key they were created with
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const token = useRef(0);
  const load = useCallback(async () => {
    ctl.current?.abort(); const c = new AbortController(); ctl.current = c; setView({ s: 'loading', epoch });
    const r = await workApi.getResult(id, c.signal);
    if (c.signal.aborted) return;
    if (r.ok) { setView({ s: 'ready', epoch, d: r.data }); edits.dispatch({ type: 'apply', key: editKey(epoch, id), action: { type: 'loaded', detail: r.data } }); } else setView({ s: 'error', epoch, kind: r.kind });
  }, [id, epoch, edits]);
  useEffect(() => { const t = setTimeout(() => { void load(); }, 0); return () => { clearTimeout(t); ctl.current?.abort(); }; }, [load]);   // a reload refreshes the saved copy and keeps an open editor's edits
  useUnsavedGuard(editDirty(ed), 'this result', () => edits.dispatch({ type: 'apply', key, action: { type: 'reset' } }));

  async function saveWords(version?: number) {
    if (!ed.form || ed.inFlight) return;
    const t = `save-${++token.current}`, words = ed.form;
    if (version !== undefined) edit({ type: 'adoptVersion', version });
    edit({ type: 'saveBegin', token: t }); setProblem(null); setBusy(true);
    const r = await workApi.updateResult(id, { expected_version: version ?? ed.base?.version ?? 1, result: { outcome: words.outcome, reflection: words.reflection, next_change: words.next } });
    setBusy(false);
    if (r.ok) { edit({ type: 'saveDone', token: t, version: r.data.version }); toast('Saved your changes.'); return; }
    if (r.kind === 'version_conflict') {
      const g = await workApi.getResult(id);
      if (g.ok) { edit({ type: 'conflict', token: t, server: g.data }); return; }
    }
    edit({ type: 'saveFail', token: t, problem: `${failureText(r.kind)} Your edits are still in the form.` });
  }
  function askDelete(d: ResultDetail) {
    confirm({ title: 'Delete this result?', message: 'This result is permanently deleted. The prompt it came from is not affected. This can’t be undone.', confirmLabel: 'Delete permanently', cancelLabel: 'Keep it', danger: true, run: () => { void doDelete(d); } });
  }
  async function doDelete(d: ResultDetail) {
    setBusy(true); setProblem(null);
    const r = await workApi.deleteResult(d.id, ed.base?.version ?? d.version);
    setBusy(false);
    if (r.ok || r.kind === 'not_found') { dispatch({ type: 'unlink', target: 'result', id: d.id }); edit({ type: 'reset' }); toast('Result deleted.'); router.push('/account/results'); return; }
    setProblem(r.kind === 'version_conflict' ? 'This result changed since you opened it, so it was not deleted. Reload it to see the latest version.' : failureText(r.kind));
  }

  const head = <div className="sectiontop"><div><span className="eyebrow">ACCOUNT · SAVED WORK</span><h1>My result</h1></div></div>;
  if (view.s === 'loading') return <>{head}<WorkTabs current="results" /><div className="skeleton" role="status" aria-busy="true" aria-label="Loading this result" /></>;
  if (view.s === 'error') return <>{head}<WorkTabs current="results" /><WorkProblem kind={view.kind} next={`/account/results/${id}`} onRetry={() => { void load(); }} /></>;
  const d = view.d, base = ed.base ?? { id: d.id, version: d.version, outcome: d.outcome, reflection: d.reflection, next: d.next_change };
  const oc = base.outcome as keyof typeof OUTCOME_LABELS;
  const form = ed.form, dirty = editDirty(ed), saving = ed.inFlight !== null;
  return (
    <>
      <div className="sectiontop">
        <div><span className="eyebrow">ACCOUNT · SAVED WORK</span><h1 style={{ overflowWrap: 'anywhere' }}>{d.title}</h1><p className="lead">{OUTCOME_LABELS[oc] ?? base.outcome} · {originLabel(d.origin_kind, d.origin_title)} · Saved {formatDate(d.created_at)}</p></div>
        <Link className="btn subtle" href="/account/results">← My results</Link>
      </div>
      <WorkTabs current="results" />
      <div className="detail-grid">
        <div className="panel">
          <h2>What happened</h2>
          {form === null ? (
            <>
              <dl className="kv"><div><dt>Outcome</dt><dd>{OUTCOME_LABELS[oc] ?? base.outcome}</dd></div><div><dt>What happened</dt><dd>{base.reflection || 'No words added.'}</dd></div><div><dt>One improvement for next time</dt><dd>{base.next || '—'}</dd></div></dl>
              <div className="actions">
                <button type="button" id="edit-words" className="btn" onClick={() => { setProblem(null); edit({ type: 'open' }); }}>Edit my words</button>
                <button type="button" id="delete-result" className="btn danger" disabled={busy} onClick={() => askDelete(d)}>Delete…</button>
              </div>
            </>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void saveWords(); }} noValidate>
              <p className="muted small" id="edit-status" role="status" aria-live="polite">{saving ? 'Saving…' : dirty ? 'Changed since last save' : 'No unsaved changes'}</p>
              <div className="field"><label htmlFor="edit-outcome">Did it work?</label><select id="edit-outcome" value={form.outcome} onChange={(e) => edit({ type: 'edit', field: 'outcome', value: e.target.value })}>{OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}</select></div>
              <div className="field"><label htmlFor="edit-reflection">What happened?</label><textarea id="edit-reflection" maxLength={4000} value={form.reflection} onChange={(e) => edit({ type: 'edit', field: 'reflection', value: e.target.value })} /></div>
              <div className="field"><label htmlFor="edit-next">One improvement for next time</label><input id="edit-next" maxLength={500} value={form.next} onChange={(e) => edit({ type: 'edit', field: 'next', value: e.target.value })} /></div>
              <div className="actions"><button type="submit" id="save-words" className="btn primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button><button type="button" className="btn subtle" id="cancel-edit" disabled={saving} onClick={() => {
                if (dirty) confirm({ title: 'Discard your edits?', message: 'Your changes to this result are not saved.', confirmLabel: 'Discard my edits', cancelLabel: 'Keep editing', danger: true, run: () => edit({ type: 'cancel' }) });
                else edit({ type: 'cancel' });
              }}>Cancel</button></div>
            </form>
          )}
          {ed.problem || problem ? <div className="save-msg" role="alert" id="detail-problem">{ed.problem ?? problem}</div> : null}
          {ed.conflict && form ? (
            <div className="conflict-box" role="group" aria-labelledby="rc-h" id="result-conflict">
              <h4 id="rc-h">This result was changed from somewhere else</h4>
              <p className="muted small">Your edits are still in the form. Choose what to do.</p>
              <div className="conflict-cols"><div><strong className="small">Saved version</strong><div className="sample" tabIndex={0}>{ed.conflict.reflection || '—'}</div></div><div><strong className="small">Your version</strong><div className="sample" tabIndex={0}>{form.reflection || '—'}</div></div></div>
              <div className="actions">
                <button type="button" className="btn" id="rc-load" onClick={() => {
                  const server = ed.conflict!;
                  confirm({ title: 'Load the saved version?', message: 'The words in this form will be replaced by the saved version. Copy anything you want to keep first.', confirmLabel: 'Load the saved version', cancelLabel: 'Keep mine', run: () => edit({ type: 'loadServer', server }) });
                }}>Load the saved version</button>
                <button type="button" className="btn" id="rc-overwrite" onClick={() => { const v = ed.conflict!.version; confirm({ title: 'Overwrite the saved result?', message: 'The saved words will be replaced by yours. This can’t be undone.', confirmLabel: 'Overwrite', cancelLabel: 'Keep both for now', danger: true, run: () => { void saveWords(v); } }); }}>Overwrite the saved version</button>
              </div>
            </div>
          ) : null}
        </div>
        <aside className="panel">
          <h3>What you tried</h3>
          <p className="muted small">Saved with the result: this is the prompt as it was then, even if you have changed it since.</p>
          <div className="sample" tabIndex={0} aria-label="Prompt tried">{d.attempted_prompt}</div>
          <h3 style={{ marginTop: 16 }}>Starting version</h3>
          <div className="sample" tabIndex={0} aria-label="Starting version">{d.starting_prompt || 'No original prompt — you started from scratch.'}</div>
          {d.prompt_id ? <p style={{ marginTop: 14 }}><Link className="btn" id="open-prompt" href={`/account/prompts/${d.prompt_id}`}>Open the saved prompt</Link></p> : <p className="muted small">The saved prompt this came from has been deleted.</p>}
        </aside>
      </div>
    </>
  );
}
