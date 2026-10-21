'use client';
// One saved prompt: reopen it in the Lab, copy it, or delete it (with the cascade stated). All text is rendered as text.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useExperience } from '../experience/ExperienceProvider.tsx';
import { originLabel } from '../experience/state.ts';
import { formatDate } from '../experience/format.ts';
import { StateBox } from '../experience/StateBox.tsx';
import type { PromptDetail } from '../../modules/mywork/index.ts';
import { useSession } from '../account/SessionProvider.tsx';
import { workApi } from './api.ts';
import { deleteWarning } from './delete-warning.ts';
import { failureText } from './messages.ts';
import { WorkProblem, WorkTabs } from './WorkChrome.tsx';

type View = { s: 'loading'; epoch: number } | { s: 'error'; epoch: number; kind: string } | { s: 'ready'; epoch: number; d: PromptDetail };
export function PromptDetailScreen({ id }: { id: string }) {
  const router = useRouter();
  const { dispatch, confirm, confirmThen, toast, copy } = useExperience();
  const { session } = useSession();
  const epoch = session.accountEpoch;
  const [raw, setView] = useState<View>({ s: 'loading', epoch });
  const view: View = raw.epoch === epoch ? raw : { s: 'loading', epoch };   // nothing fetched under another account is ever shown
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    ctl.current?.abort(); const c = new AbortController(); ctl.current = c; setView({ s: 'loading', epoch });
    const r = await workApi.getPrompt(id, c.signal);
    if (c.signal.aborted) return;
    setView(r.ok ? { s: 'ready', epoch, d: r.data } : { s: 'error', epoch, kind: r.kind });
  }, [id, epoch]);
  useEffect(() => { const t = setTimeout(() => { void load(); }, 0); return () => { clearTimeout(t); ctl.current?.abort(); }; }, [load]);

  function continueEditing(d: PromptDetail) {
    confirmThen('load', () => { dispatch({ type: 'loadSaved', detail: d, at: Date.now() }); router.push('/lab'); });
  }
  function askDelete(d: PromptDetail) {
    confirm({
      title: 'Delete this prompt?', message: deleteWarning(d.result_count), confirmLabel: 'Delete permanently', cancelLabel: 'Keep it', danger: true,
      run: () => { void doDelete(d); },
    });
  }
  async function doDelete(d: PromptDetail) {
    setBusy(true); setProblem(null);
    const r = await workApi.deletePrompt(d.id, d.version);
    setBusy(false);
    if (r.ok || r.kind === 'not_found') { dispatch({ type: 'unlink', target: 'prompt', id: d.id }); toast('Deleted. Your draft on the Lab page, if any, is unchanged.'); router.push('/account/prompts'); return; }
    setProblem(r.kind === 'version_conflict' ? 'This prompt changed since you opened it, so it was not deleted. Reload it to see the latest version.' : failureText(r.kind));
  }

  if (view.s === 'loading') return <><div className="sectiontop"><div><span className="eyebrow">ACCOUNT · SAVED WORK</span><h1>My prompt</h1></div></div><WorkTabs current="prompts" /><div className="skeleton" role="status" aria-busy="true" aria-label="Loading this prompt" /></>;
  if (view.s === 'error') return <><div className="sectiontop"><div><span className="eyebrow">ACCOUNT · SAVED WORK</span><h1>My prompt</h1></div></div><WorkTabs current="prompts" /><WorkProblem kind={view.kind} next={`/account/prompts/${id}`} onRetry={() => { void load(); }} /></>;
  const d = view.d;
  return (
    <>
      <div className="sectiontop">
        <div><span className="eyebrow">ACCOUNT · SAVED WORK</span><h1 style={{ overflowWrap: 'anywhere' }}>{d.title}</h1><p className="lead">{originLabel(d.origin_kind, d.origin_title)} · Saved {formatDate(d.created_at)} · Last changed {formatDate(d.updated_at)}</p></div>
        <Link className="btn subtle" href="/account/prompts">← My prompts</Link>
      </div>
      <WorkTabs current="prompts" />
      <div className="panel">
        <div className="actions">
          <button type="button" id="continue-editing" className="btn primary" onClick={() => continueEditing(d)}>Continue editing in The Lab</button>
          <button type="button" id="copy-prompt" className="btn" onClick={() => { void copy(d.full_prompt); }}>Copy prompt ↗</button>
          <button type="button" id="delete-prompt" className="btn danger" disabled={busy} onClick={() => askDelete(d)}>Delete…</button>
        </div>
        {problem ? <div className="save-msg" role="alert" id="detail-problem">{problem} <button type="button" className="btn" onClick={() => { setProblem(null); void load(); }}>Reload</button></div> : null}
        <dl className="kv" style={{ marginTop: 18 }}>
          <div><dt>Prompt</dt><dd><div className="sample" tabIndex={0} aria-label="Saved prompt">{d.full_prompt}</div></dd></div>
          {d.goal ? <div><dt>Goal</dt><dd>{d.goal}</dd></div> : null}
          {d.context ? <div><dt>Context</dt><dd>{d.context}</dd></div> : null}
          <div><dt>Preferred output</dt><dd>{d.output_format}</dd></div>
          {d.starting_prompt ? <div><dt>Starting version</dt><dd><div className="sample" tabIndex={0} aria-label="Starting version">{d.starting_prompt}</div></dd></div> : null}
        </dl>
        <p className="muted small">{d.result_count > 0 ? <>This prompt has {d.result_count} saved result{d.result_count === 1 ? '' : 's'}. <Link href="/account/results">See My results</Link>.</> : 'No results saved for this prompt yet.'}</p>
      </div>
      <StateBox kind="info" title="Private to your account">Not shared with other members. Please don’t store passwords or other secrets in prompts.</StateBox>
    </>
  );
}
