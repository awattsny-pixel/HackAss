'use client';
// The real catalog, as read on the server through the anonymous public-read functions. A failed or empty read is shown as such: this component
// NEVER swaps in demo content. The demo examples are reachable only through the explicit "Demo examples" switch.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useReducer } from 'react';
import { initList, reduceList } from './catalog-state.ts';
import { ChipIcon } from './CategoryIcon.tsx';
import { AI_LABEL, costRange, DIFFICULTY_LABEL, timeRange } from './format.ts';
import { HackCard } from './HackCard.tsx';
import { SourceSwitch, SparkHeader } from './SparkHeader.tsx';
import { StateBox } from './StateBox.tsx';

export interface CardItem {
  readonly slug: string; readonly title: string; readonly summary: string; readonly category: { readonly slug: string; readonly name: string };
  readonly difficulty: 'easy' | 'moderate' | 'hard' | null; readonly time_minutes: { min: number | null; max: number | null };
  readonly cost: { min_cents: number | null; max_cents: number | null; currency: string | null }; readonly ai_requirement: 'none' | 'helpful' | 'required' | null;
}
export type FailureKind = 'denied' | 'unavailable' | 'invalid_response' | 'not_found' | 'invalid_request';
export interface Cursor { readonly published_at: string; readonly slug: string }
export type MoreResult = { readonly ok: true; readonly items: readonly CardItem[]; readonly nextCursor: Cursor | null } | { readonly ok: false; readonly kind: FailureKind };
export interface CatalogView {
  /** Identifies one server render: a new value means a new server result (category change, refresh, retry). */
  readonly renderId: string;
  readonly status: 'ok' | FailureKind;
  readonly items: readonly CardItem[];
  readonly nextCursor: Cursor | null;
  readonly categories: readonly { slug: string; name: string }[];
  readonly activeCategory: string | null;
}
export type LoadMore = (input: { category: string | null; after: Cursor }) => Promise<MoreResult>;

function Failure({ kind }: { kind: FailureKind }) {
  const router = useRouter();
  const retry = <button type="button" className="btn" onClick={() => router.refresh()}>Try again</button>;
  if (kind === 'denied') return <StateBox kind="denied" title="The catalog could not be opened" actions={retry}>We couldn&apos;t open the hack catalog right now. This isn&apos;t something you did. Nothing has been replaced with other content.</StateBox>;
  if (kind === 'invalid_request') return <StateBox kind="error" title="That filter is not valid" actions={<Link className="btn" href="/spark">Show all hacks</Link>}>Choose a category from the list.</StateBox>;
  return <StateBox kind="error" title="The catalog could not be loaded" actions={retry}>Please try again. Nothing has been replaced with other content; the demo examples are available separately, labelled as demos.</StateBox>;
}

export function SparkCatalog({ view, loadMore }: { view: CatalogView; loadMore: LoadMore }) {
  const [base, dispatch] = useReducer(reduceList, view, initList);
  // Derived from the server result first, so a changed category or a refresh never renders the previous cards even for one frame.
  const list = base.renderId === view.renderId ? base : initList(view);
  useEffect(() => { dispatch({ type: 'sync', view }); }, [view]);
  const { items, cursor, busy, moreError } = list;

  const more = async () => {
    if (!cursor || busy) return;
    const mine = view.renderId;
    dispatch({ type: 'start' });
    const r = await loadMore({ category: view.activeCategory, after: cursor }).catch(() => ({ ok: false as const, kind: 'unavailable' as const }));
    if (!r.ok) { dispatch({ type: 'fail', renderId: mine }); return; }
    dispatch({ type: 'done', renderId: mine, items: r.items, cursor: r.nextCursor });
  };

  return (
    <>
      <SparkHeader mode="catalog">
        {view.status === 'ok' ? (
          <nav className="chips" aria-label="Categories">
            <Link className="chip" href="/spark" aria-current={view.activeCategory === null ? 'true' : undefined}><ChipIcon category={null} />All</Link>
            {view.categories.map((c) => <Link key={c.slug} className="chip" href={`/spark?category=${encodeURIComponent(c.slug)}`} aria-current={view.activeCategory === c.slug ? 'true' : undefined}><ChipIcon category={c.name} />{c.name}</Link>)}
          </nav>
        ) : null}
      </SparkHeader>
      {view.status !== 'ok' ? <><div className="sectiontop"><SourceSwitch mode="catalog" /></div><Failure kind={view.status} /></> : (
        <>
          <div className="sectiontop"><h2>Worth a try</h2><SourceSwitch mode="catalog" /></div>
          {items.length === 0 ? (
            <StateBox kind="empty" title={view.activeCategory ? 'No published hacks in this category yet' : 'No published hacks yet'} actions={<>{view.activeCategory ? <Link className="btn" href="/spark">Show all hacks</Link> : null}<Link className="btn" href="/spark/demo">Preview the demo examples</Link></>}>
              The catalog is empty. The three demo examples are separate, clearly labelled draft content for design review.
            </StateBox>
          ) : (
            <ul className="cards">
              {items.map((h) => {
                const t = timeRange(h.time_minutes); const c = costRange(h.cost);
                return (
                  <li key={h.slug}>
                    <HackCard href={`/spark/catalog/${h.slug}`} title={h.title} summary={h.summary} category={h.category.name}>
                      <div className="badges">
                        {h.difficulty ? <span className="badge">{DIFFICULTY_LABEL[h.difficulty]}</span> : null}
                        {t ? <span className="badge">{t}</span> : null}
                        {c ? <span className="badge">{c}</span> : null}
                        {h.ai_requirement ? <span className="badge">{AI_LABEL[h.ai_requirement]}</span> : null}
                      </div>
                    </HackCard>
                  </li>
                );
              })}
            </ul>
          )}
          {moreError ? <StateBox kind="error" title="More hacks could not be loaded" actions={<button type="button" className="btn" onClick={more}>Try again</button>}>The hacks above are unchanged.</StateBox> : null}
          {cursor ? <div className="actions" style={{ marginTop: 18 }}><button type="button" className="btn" onClick={more} disabled={busy} aria-busy={busy}>{busy ? 'Loading…' : 'Load more'}</button></div> : null}
        </>
      )}
      <div className="footer">Categories shown are those found in the newest published hacks.</div>
    </>
  );
}
