'use client';
import Link from 'next/link';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { StateBox } from '../experience/StateBox.tsx';
import { originLabel } from '../experience/state.ts';
import { OUTCOME_LABELS } from '../experience/prompt.ts';
import { formatDate } from '../experience/format.ts';
import type { ResultPage } from '../../modules/mywork/index.ts';
import { useSession } from '../account/SessionProvider.tsx';
import { workApi, type Cursor } from './api.ts';
import { initialList, reduceList, visibleList, type ListAction, type ListState } from './list-state.ts';
import { ExportPanel } from './ExportPanel.tsx';
import { WorkProblem, WorkTabs } from './WorkChrome.tsx';

type Item = ResultPage['items'][number];
type Next = ResultPage['next_cursor'];
const reducer = (st: ListState<Item, Next>, a: ListAction<Item, Next>) => reduceList<Item, Next>(st, a);
const FILTERS = [['', 'All outcomes'], ['yes', OUTCOME_LABELS.yes], ['partial', OUTCOME_LABELS.partial], ['no', OUTCOME_LABELS.no], ['notyet', OUTCOME_LABELS.notyet]] as const;

export function MyResultsScreen() {
  const { session } = useSession();
  const epoch = session.accountEpoch;
  const [raw, dispatch] = useReducer(reducer, undefined, () => initialList<Item, Next>());
  const view = visibleList(raw, epoch);       // nothing fetched under another account is ever shown
  const [outcome, setOutcome] = useState('');
  const ctl = useRef<AbortController | null>(null);
  const gen = useRef(0);
  const load = useCallback(async (o: string) => {
    ctl.current?.abort(); const c = new AbortController(); ctl.current = c;
    const g = ++gen.current; dispatch({ type: 'load', gen: g, epoch });   // a filter change is a new view: rows and cursor of the old one are dropped now
    const r = await workApi.listResults({ limit: 25, outcome: o || null }, c.signal);
    if (c.signal.aborted) return;
    dispatch(r.ok ? { type: 'loaded', gen: g, items: r.data.items, next: r.data.next_cursor } : { type: 'failed', gen: g, kind: r.kind });
  }, [epoch]);
  useEffect(() => { const t = setTimeout(() => { void load(outcome); }, 0); return () => { clearTimeout(t); ctl.current?.abort(); }; }, [load, outcome]);
  async function more() {
    if (view.s !== 'ready' || !view.next || view.more === 'loading') return;
    const g = view.gen, signal = ctl.current?.signal, o = outcome;
    dispatch({ type: 'more', gen: g });
    const r = await workApi.listResults({ limit: 25, outcome: o || null, after: view.next as Cursor }, signal);
    if (signal?.aborted) return;                // a newer view (filter, retry, another account) aborted this request; its answer is dropped by generation as well
    dispatch(r.ok ? { type: 'moreLoaded', gen: g, items: r.data.items, next: r.data.next_cursor } : { type: 'moreFailed', gen: g });
  }
  return (
    <>
      <div className="sectiontop"><div><span className="eyebrow">ACCOUNT · SAVED WORK</span><h1>My results</h1><p className="lead">What happened when you tried a prompt. Each result keeps the prompt as it was when you saved it. Private to your account.</p></div></div>
      <WorkTabs current="results" />
      <div className="filters">
        <label htmlFor="outcome-filter">Show</label>
        <select id="outcome-filter" value={outcome} onChange={(e) => setOutcome(e.target.value)}>{FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </div>
      {view.s === 'loading' ? <div className="skeleton" role="status" aria-busy="true" aria-label="Loading your results" style={{ minHeight: 160 }} /> : null}
      {view.s === 'error' ? <WorkProblem kind={view.kind} next="/account/results" onRetry={() => { void load(outcome); }} /> : null}
      {view.s === 'ready' && view.items.length === 0 ? (
        <StateBox kind="empty" title={outcome ? 'No results with that outcome' : 'No saved results yet'} actions={outcome ? <button type="button" className="btn" onClick={() => setOutcome('')}>Show all outcomes</button> : <><Link className="btn primary" href="/reveal">Open The Reveal</Link><Link className="btn" href="/lab">Open The Lab</Link></>}>
          {outcome ? 'Try another outcome.' : 'After you try a prompt, use “Save this result” in The Reveal and it appears here.'}
        </StateBox>
      ) : null}
      {view.s === 'ready' && view.items.length > 0 ? (
        <>
          <ul className="work-list" aria-label="Saved results">
            {view.items.map((i) => (
              <li key={i.id} className="work-row">
                <h3><Link href={`/account/results/${i.id}`}>{i.title}</Link></h3>
                <span className={`outcome-badge ${i.outcome}`}>{OUTCOME_LABELS[i.outcome]}</span>
                <p className="snippet">{i.snippet || 'No words added.'}</p>
                <span className="meta">{originLabel(i.origin_kind, i.origin_title)} · Saved {formatDate(i.created_at)}</span>
              </li>
            ))}
          </ul>
          {view.next ? <div className="actions" style={{ marginTop: 14 }}><button type="button" id="load-more" className="btn" disabled={view.more === 'loading'} onClick={() => { void more(); }}>{view.more === 'loading' ? 'Loading…' : 'Load more'}</button>{view.more === 'error' ? <span role="alert" className="muted small">Couldn’t load more. Try again.</span> : null}</div> : null}
        </>
      ) : null}
      {view.s === 'ready' ? <ExportPanel /> : null}
    </>
  );
}
