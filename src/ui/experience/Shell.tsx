'use client';
// The experience chrome: labelled sidebar (desktop, with the account controls and the private-preview notice) / icon rail (tablet, with a compact account entry) / compact header + bottom navigation (phone), and a compact journey bar on the hack, Lab and Reveal screens only. Detail navigation is DISABLED until a hack has been
// selected. Focus moves to the page heading on every route change so keyboard and screen-reader users land in the new content.
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { AccountChip } from '../account/AccountChip.tsx';
import { AccountMenu } from '../account/AccountMenu.tsx';
import { useExperience } from './ExperienceProvider.tsx';
import { useNewHack } from './NewHack.ts';
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
const STEPS = ['1 · Discover', '2 · Understand', '3 · Adapt / Create', '4 · Reflect'];
const STEP_OF: Record<Page, number> = { spark: -1, detail: 1, lab: 2, reveal: 3, states: -1, account: -1, prompts: -1, results: -1 };

// Icons: Lucide-style paths (2px stroke, round caps), as in the design.
type IconKey = 'home' | 'new' | 'mine';
const ICONS: Record<IconKey, ReactNode> = {
  home: <path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  new: <path d="M12 5v14M5 12h14" />,
  mine: <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />,
};
const Icon = ({ k }: { k: IconKey }) => <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{ICONS[k]}</svg>;

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

  const newHack = useNewHack();
  // Supported destinations only. The journey screens (hack, Lab, Reveal) are steps reached from Home, New hack and the journey bar; saved work is ONE destination whose
  // Prompts and Results tabs keep the existing routes.
  const items: { key: 'home' | 'mine'; label: string; to: string; icon: IconKey; current: boolean }[] = [
    { key: 'home', label: 'Home', to: '/spark', icon: 'home', current: page === 'spark' || page === 'detail' },
    { key: 'mine', label: 'My hacks', to: '/account/prompts', icon: 'mine', current: page === 'prompts' || page === 'results' },
  ];
  const renderItem = (it: (typeof items)[number], mobile: boolean) => (
    <Link key={it.key} href={it.to} aria-current={it.current ? 'page' : undefined} aria-label={mobile ? undefined : it.label} title={it.label}>
      <Icon k={it.icon} /><span className={mobile ? undefined : 'nav-label'}>{it.label}</span>
    </Link>
  );
  const stepLinks: (string | null)[] = ['/spark', hasDetail ? href : null, '/lab', '/reveal'];
  const Mark = <span className="brand-tile"><Image src="/hack/hack-official.png" alt="" width={36} height={36} unoptimized /></span>;

  return (
    <div className="shell">
      <a className="skip" href="#hx-main">Skip to content</a>
      <aside className="sidebar">
        <Link className="brand" href="/spark" aria-label="HackAss home">{Mark}<span className="brand-name">HackAss</span></Link>
        <button type="button" className="new-hack" onClick={newHack} aria-label="New hack"><Icon k="new" /><span className="nav-label">New hack</span></button>
        <nav className="nav" aria-label="Primary">{items.map((it) => renderItem(it, false))}</nav>
        <div className="side-foot">
          <p className="side-note"><span className="status">PRIVATE PREVIEW · SAVING IS EXPLICIT</span><strong>Save to your account, or copy your work before leaving.</strong><br />Accounts are by invitation.</p>
          <div className="side-account"><AccountChip /></div>
          <AccountMenu where="rail" />
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <Link className="mobile-brand" href="/spark" aria-label="HackAss home">{Mark}<span>HackAss</span></Link>
          <AccountMenu where="header" />
        </header>
        <main className="page" id="hx-main" tabIndex={-1} ref={mainRef} style={{ outline: 'none' }}>
          <p className="preview-strip" role="note"><span className="status">PRIVATE PREVIEW · SAVING IS EXPLICIT</span></p>
          {STEP_OF[page] >= 0 ? <ol className="stepbar" aria-label="Journey">{STEPS.map((s, i) => (
            <li key={s} aria-current={i === STEP_OF[page] ? 'step' : undefined}>{stepLinks[i] ? <Link href={stepLinks[i]}>{s}</Link> : <span title="Select a hack first">{s}</span>}</li>
          ))}</ol> : null}
          {children}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {renderItem(items[0], true)}
        <button type="button" className="new-hack" onClick={newHack}><Icon k="new" /><span>New hack</span></button>
        {renderItem(items[1], true)}
      </nav>
    </div>
  );
}
