// One hack card = ONE link (the title; its ::after covers the card, so the whole card is clickable and the keyboard focus ring is drawn around the card).
// No per-card button, no "Published" decoration (the source switch already says which list this is). Demo cards stay unmistakably labelled.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CategoryIcon } from './CategoryIcon.tsx';
import { toneFor } from './format.ts';

export function HackCard({ href, title, summary, category, demo = false, children }: { href: string; title: string; summary: string; category: string; demo?: boolean; children?: ReactNode }) {
  return (
    <article className={`hack-card tone-${toneFor(category)}`}>
      <div className="top-row"><span className="meta"><CategoryIcon category={category} />{category}</span>{demo ? <span className="draft-pill">Demo example · draft</span> : null}</div>
      <h3><Link className="card-link" href={href}>{title}</Link></h3>
      <p>{summary}</p>
      {children}
    </article>
  );
}
