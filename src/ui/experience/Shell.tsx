'use client';
// The experience chrome: sidebar (desktop), top bar, step bar, mobile bottom navigation. Detail navigation is DISABLED until a hack has been
// selected. Focus moves to the page heading on every route change so keyboard and screen-reader users land in the new content.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { AccountChip } from '../account/AccountChip.tsx';
import { useExperience } from './ExperienceProvider.tsx';
import { canOpenDetail, detailHref } from './state.ts';

type Page = 'spark' | 'detail' | 'lab' | 'reveal' | 'states' | 'account' | 'prompts' | 'results';
export function pageOf(pathname: string): Page {
  if (pathname.startsWith('/spark/catalog/') || pathname.startsWith('/spark/demo/')) return 'detail';
  if (pathname.startsWith('/lab')) return 'lab';
  if (pathname.startsWith('/reveal')) return 'reveal';
  if (pathname.startsWith('/states')) return 'states';
  if (pathname.startsWith('/account/prompts')) return 'prompts';
  if (pathname.startsWith('/account/results')) return 'results';
  if (pathname.startsWith('/account')) return 'account';
  return 'spark';
}
const WHERE: Record<Page, string> = { spark: 'THE SPARK · DISCOVER', detail: 'HACK DETAIL · UNDERSTAND', lab: 'THE LAB · ADAPT / CREATE', reveal: 'THE REVEAL · REFLECT', states: 'INTERFACE STATES · DESIGN REVIEW', account: 'ACCOUNT · SIGN IN', prompts: 'ACCOUNT · MY PROMPTS', results: 'ACCOUNT · MY RESULTS' };
const STEPS = ['1 · Discover', '2 · Understand', '3 · Adapt / Create', '4 · Reflect'];
const STEP_OF: Record<Page, number> = { spark: 0, detail: 1, lab: 2, reveal: 3, states: -1, account: -1, prompts: -1, results: -1 };

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const page = pageOf(pathname);
  const { state } = useExperience();
  const hasDetail = canOpenDetail(state);
  const href = detailHref(state);
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    mainRef.current?.focus();
  }, [pathname]);

  const items: { key: Page; label: string; glyph: string; mobile: string; to: string | null }[] = [
    { key: 'spark', label: 'The Spark', glyph: '⚡', mobile: 'Discover', to: '/spark' },
    { key: 'detail', label: 'Hack detail', glyph: '◫', mobile: 'Detail', to: hasDetail ? href : null },
    { key: 'lab', label: 'The Lab', glyph: '✦', mobile: 'Create', to: '/lab' },
    { key: 'reveal', label: 'The Reveal', glyph: '◎', mobile: 'Reflect', to: '/reveal' },
    { key: 'prompts', label: 'My prompts', glyph: '▤', mobile: 'Saved', to: '/account/prompts' },
    { key: 'results', label: 'My results', glyph: '✔', mobile: 'Results', to: '/account/results' },
  ];
  const renderItem = (it: (typeof items)[number], mobile: boolean) => {
    const label = mobile ? <>{it.glyph}<br />{it.mobile}</> : <>{it.glyph} {it.label}</>;
    if (it.to === null) return <button key={it.key} type="button" disabled title="Select a hack in The Spark first" aria-label={`${it.label} (select a hack in The Spark first)`}>{label}</button>;
    const current = page === it.key || (mobile && it.key === 'prompts' && page === 'results'); // on a phone, My results is reached from the tabs inside Saved
    return <Link key={it.key} href={it.to} aria-current={current ? 'page' : undefined}>{label}</Link>;
  };

  return (
    <div className="shell">
      <a className="skip" href="#hx-main">Skip to content</a>
      <aside className="sidebar">
        <div><Link className="brand" href="/spark">Hack<span>Ass</span> ⚡</Link><div className="tagline">Discover your superpower.</div></div>
        <nav className="nav" aria-label="Primary">{items.map((it) => renderItem(it, false))}</nav>
        <div className="side-note">Private preview<br /><strong>Save to your account, or copy your work before leaving.</strong><br />No AI or publishing yet. Accounts are by invitation.</div>
      </aside>
      <div className="main">
        <header className="topbar"><span className="eyebrow">{WHERE[page]}</span><span className="status">PRIVATE PREVIEW · SAVING IS EXPLICIT</span><AccountChip /></header>
        <main className="page" id="hx-main" tabIndex={-1} ref={mainRef} style={{ outline: 'none' }}>
          {STEP_OF[page] >= 0 ? <ol className="stepbar" aria-label="Journey">{STEPS.map((s, i) => <li key={s} aria-current={i === STEP_OF[page] ? 'step' : undefined}>{s}</li>)}</ol> : null}
          {children}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">{items.filter((it) => it.key !== 'results').map((it) => renderItem(it, true))}</nav>
    </div>
  );
}
