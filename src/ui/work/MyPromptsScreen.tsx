'use client';
import Link from 'next/link';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { StateBox } from '../experience/StateBox.tsx';
import { originLabel } from '../experience/state.ts';
import { formatDate } from '../experience/format.ts';
import type { PromptPage } from '../../modules/mywork/index.ts';
import { useSession } from '../account/SessionProvider.tsx';
import { workApi, type Cursor } from './api.ts';
import { initialList, reduceList, visibleList, type ListAction, type ListState } from './list-state.ts';
import { ExportPanel } from './ExportPanel.tsx';
import { WorkProblem, WorkTabs } from './WorkChrome.tsx';

type Item = PromptPage['items'][number];
type Next = PromptPage['next_cursor'];
const reducer = (st: ListState<Item, Next>, a: ListAction<Item, Next>) => reduceList<Item, Next>(st, a);

export function MyPromptsScreen() {
  const { session } = useSession();
  const epoch = session.accountEpoch;
  const [raw, dispatch] = useReducer(reducer, undefined, () => initialList<Item, Next>());
  const view = visibleList(raw, epoch);       // nothing fetched under another account is ever shown
  const ctl = useRef<AbortController | null>(null);
  const gen = useRef(0);
  const load = useCallback(async () => {
    ctl.current?.abort(); const c = new AbortController(); ctl.current = c;
    const g = ++gen.current; dispatch({ type: 'load', gen: g, epoch });
    const r = await workApi.listPrompts({ limit: 25 }, c.signal);
    if (c.signal.aborted) return;
    dispatch(r.ok ? { type: 'loaded', gen: g, items: r.data.items, next: r.data.next_cursor } : { type: 'failed', gen: g, kind: r.kind });
  }, [epoch]);
  useEffect(() => { const t = setTimeout(() => { void load(); }, 0); return () => { clearTimeout(t); ctl.current?.abort(); }; }, [load]);
  async function more() {
    if (view.s !== 'ready' || !view.next || view.more === 'loading') return;
    const g = view.gen, signal = ctl.current?.signal;               // the request belongs to THIS view; a newer load aborts it and its answer is dropped by generation
    dispatch({ type: 'more', gen: g });
    const r = await workApi.listPrompts({ limit: 25, after: view.next as Cursor }, signal);
    if (signal?.aborted) return;
    dispatch(r.ok ? { type: 'moreLoaded', gen: g, items: r.data.items, next: r.data.next_cursor } : { type: 'moreFailed', gen: g });
  }
  return (
    <>
      <div className="sectiontop"><div><span className="eyebrow">ACCOUNT · SAVED WORK</span><h1>My prompts</h1><p className="lead">The prompts you chose to save. Private to your account; not shared with other members.</p></div></div>
      <WorkTabs current="prompts" />
      {view.s === 'loading' ? <div className="skeleton" role="status" aria-busy="true" aria-label="Loading your prompts" style={{ minHeight: 160 }} /> : null}
      {view.s === 'error' ? <WorkProblem kind={view.kind} next="/account/prompts" onRetry={() => { void load(); }} /> : null}
      {view.s === 'ready' && view.items.length === 0 ? <StateBox kind="empty" title="No saved prompts yet" actions={<><Link className="btn primary" href="/lab">Open The Lab</Link><Link className="btn" href="/spark">Browse The Spark</Link></>}>When you save a prompt in The Lab it appears here. Nothing has been saved yet.</StateBox> : null}
      {view.s === 'ready' && view.items.length > 0 ? (
        <>
          <ul className="work-list" aria-label="Saved prompts">
            {view.items.map((i) => (
              <li key={i.id} className="work-row">
                <h3><Link href={`/account/prompts/${i.id}`}>{i.title}</Link></h3>
                <Link className="btn small-btn" href={`/account/prompts/${i.id}`} aria-label={`Open ${i.title}`}>Open</Link>
                <p className="snippet">{i.snippet}</p>
                <span className="meta">{originLabel(i.origin_kind, i.origin_title)} · Updated {formatDate(i.updated_at)}</span>
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
