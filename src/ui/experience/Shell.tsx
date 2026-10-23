'use client';
// The experience chrome: sidebar (desktop) / icon rail (tablet) / bottom navigation (phone), top bar, journey bar. Detail navigation is DISABLED until a hack has been
// selected. Focus moves to the page heading on every route change so keyboard and screen-reader users land in the new content.
import Image from 'next/image';
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
const WHERE: Record<Page, string> = { spark: 'Home · Discover', detail: 'Hack · Understand', lab: 'Make it yours · Adapt or create', reveal: 'How did it go? · Reflect', states: 'Interface states · design review', account: 'Account · Sign in', prompts: 'My hacks · My prompts', results: 'My hacks · My results' };
const STEPS = ['1 · Discover', '2 · Understand', '3 · Adapt / Create', '4 · Reflect'];
const STEP_OF: Record<Page, number> = { spark: 0, detail: 1, lab: 2, reveal: 3, states: -1, account: -1, prompts: -1, results: -1 };

// Icons: Lucide-style paths (2px stroke, round caps), as in the design.
const ICONS: Record<Page, ReactNode> = {
  spark: <path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  detail: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
  lab: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />,
  reveal: <><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></>,
  prompts: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  results: <path d="M5 13l4 4L19 7" />,
  states: <circle cx="12" cy="12" r="9" />, account: <circle cx="12" cy="12" r="9" />,
};
const Icon = ({ k }: { k: Page }) => <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{ICONS[k]}</svg>;

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

  const items: { key: Page; label: string; mobile: string; to: string | null }[] = [
    { key: 'spark', label: 'The Spark', mobile: 'Discover', to: '/spark' },
    { key: 'detail', label: 'Hack detail', mobile: 'Detail', to: hasDetail ? href : null },
    { key: 'lab', label: 'The Lab', mobile: 'Create', to: '/lab' },
    { key: 'reveal', label: 'The Reveal', mobile: 'Reflect', to: '/reveal' },
    { key: 'prompts', label: 'My prompts', mobile: 'Saved', to: '/account/prompts' },
    { key: 'results', label: 'My results', mobile: 'Results', to: '/account/results' },
  ];
  const renderItem = (it: (typeof items)[number], mobile: boolean) => {
    const label = mobile ? <><Icon k={it.key} /><span>{it.mobile}</span></> : <><Icon k={it.key} /><span className="nav-label">{it.label}</span></>;
    if (it.to === null) return <button key={it.key} type="button" disabled title="Select a hack in The Spark first" aria-label={`${it.label} (select a hack in The Spark first)`}>{label}</button>;
    const current = page === it.key || (mobile && it.key === 'prompts' && page === 'results'); // on a phone, My results is reached from the tabs inside Saved
    return <Link key={it.key} href={it.to} aria-current={current ? 'page' : undefined} aria-label={mobile ? undefined : it.label} title={it.label}>{label}</Link>;
  };
  const Mark = <span className="brand-tile"><Image src="/hack/hack-official.png" alt="" width={36} height={36} unoptimized /></span>;

  return (
    <div className="shell">
      <a className="skip" href="#hx-main">Skip to content</a>
      <aside className="sidebar">
        <Link className="brand" href="/spark" aria-label="HackAss home">{Mark}<span className="brand-name">HackAss</span></Link>
        <nav className="nav" aria-label="Primary">{items.map((it) => renderItem(it, false))}</nav>
        <div className="side-note">Private preview<br /><strong>Save to your account, or copy your work before leaving.</strong><br />Accounts are by invitation.</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <Link className="mobile-brand" href="/spark" aria-label="HackAss home">{Mark}<span>HackAss</span></Link>
          <span className="eyebrow">{WHERE[page]}</span><span className="status">PRIVATE PREVIEW · SAVING IS EXPLICIT</span><AccountChip />
        </header>
        <main className="page" id="hx-main" tabIndex={-1} ref={mainRef} style={{ outline: 'none' }}>
          {STEP_OF[page] >= 0 ? <ol className="stepbar" aria-label="Journey">{STEPS.map((s, i) => <li key={s} aria-current={i === STEP_OF[page] ? 'step' : undefined}>{s}</li>)}</ol> : null}
          {children}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">{items.filter((it) => it.key !== 'results').map((it) => renderItem(it, true))}</nav>
    </div>
  );
}
