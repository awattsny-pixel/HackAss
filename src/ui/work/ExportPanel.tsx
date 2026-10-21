'use client';
// Download my data: collects the member's own data page by page and hands the browser a file. Cancellable; failures are retryable and lose nothing.
import { useEffect, useRef, useState } from 'react';
import { StateBox } from '../experience/StateBox.tsx';
import { useSession } from '../account/SessionProvider.tsx';
import { workApi } from './api.ts';
import { collectExport, exportFileName, type ExportProgress } from './export.ts';
import { failureText } from './messages.ts';

type Phase = { s: 'idle' } | { s: 'working'; p: ExportProgress | null } | { s: 'done'; prompts: number; results: number } | { s: 'error'; kind: string };

export function ExportPanel() {
  const [phase, setPhase] = useState<Phase>({ s: 'idle' });
  const ctl = useRef<AbortController | null>(null);
  const { session } = useSession();
  const epoch = session.accountEpoch;
  const seen = useRef(epoch);
  useEffect(() => () => { ctl.current?.abort(); }, []);
  // another account (sign-out, sign-in): an export in progress is stopped and its progress or result message is not left on screen
  useEffect(() => { if (seen.current !== epoch) { seen.current = epoch; ctl.current?.abort(); const t = setTimeout(() => setPhase({ s: 'idle' }), 0); return () => clearTimeout(t); } }, [epoch]);
  async function run() {
    ctl.current?.abort(); const c = new AbortController(); ctl.current = c;
    setPhase({ s: 'working', p: null });
    const r = await collectExport(workApi, { signal: c.signal, onProgress: (p) => { if (!c.signal.aborted) setPhase({ s: 'working', p }); } });
    if (c.signal.aborted) return;
    if (!r.ok) { setPhase(r.kind === 'cancelled' ? { s: 'idle' } : { s: 'error', kind: r.kind }); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(r.bundle, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = exportFileName(new Date()); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setPhase({ s: 'done', prompts: r.bundle.counts.prompts, results: r.bundle.counts.results });
  }
  return (
    <section className="export-box" aria-labelledby="export-h">
      <h2 id="export-h" style={{ fontSize: 18 }}>Download my data</h2>
      <p className="muted small">Your saved prompts and results as one file, built in your browser. Keep the file private: it contains everything you saved.</p>
      <div className="actions">
        <button type="button" id="export-start" className="btn" disabled={phase.s === 'working'} onClick={() => { void run(); }}>{phase.s === 'working' ? 'Preparing…' : 'Download my data'}</button>
        {phase.s === 'working' ? <button type="button" className="btn subtle" onClick={() => ctl.current?.abort()}>Cancel</button> : null}
      </div>
      <div role="status" aria-live="polite" id="export-status">
        {phase.s === 'working' ? <p className="muted small">{phase.p ? `Collecting your ${phase.p.phase}: ${phase.p.done} of ${phase.p.total}` : 'Starting…'}</p> : null}
        {phase.s === 'done' ? <p className="muted small">Downloaded {phase.prompts} prompt{phase.prompts === 1 ? '' : 's'} and {phase.results} result{phase.results === 1 ? '' : 's'}.</p> : null}
      </div>
      {phase.s === 'error' ? <StateBox kind="error" title="The download didn’t finish" actions={<button type="button" className="btn" onClick={() => { void run(); }}>Try again</button>}>{failureText(phase.kind)}</StateBox> : null}
    </section>
  );
}
