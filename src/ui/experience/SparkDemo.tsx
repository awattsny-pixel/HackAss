'use client';
import Link from 'next/link';
import { useState } from 'react';
import { DEMO_CATEGORIES, DEMO_HACKS } from './demo-hacks.ts';
import { SparkHeader } from './SparkHeader.tsx';
import { StateBox } from './StateBox.tsx';

/** DEMO MODE: the three draft examples of the UX-08 prototype. Always labelled; reachable only on purpose (never a fallback for the catalog). */
export function SparkDemo() {
  const [cat, setCat] = useState<string>('All');
  const shown = DEMO_HACKS.filter((h) => cat === 'All' || h.category === cat);
  return (
    <>
      <SparkHeader mode="demo" exploreHref={DEMO_HACKS[0].href} />
      <div className="banner demo" role="note"><strong>Demo mode.</strong> These three examples are draft content written for design review. They are not in the published catalog, not verified methods and not community posts.</div>
      <div className="chips" role="group" aria-label="Demo categories">
        {['All', ...DEMO_CATEGORIES].map((c) => (
          <button key={c} type="button" className="chip" aria-current={cat === c ? 'true' : undefined} onClick={() => setCat(c)}>{c}</button>
        ))}
      </div>
      <div className="sectiontop"><h2>Worth a try</h2><span className="muted small">3 editorial examples · draft content</span></div>
      {shown.length === 0 ? <StateBox kind="empty">No examples match this category.</StateBox> : (
        <ul className="cards">
          {shown.map((h) => (
            <li key={h.key}>
              <article className="card hack-card">
                <div className={`visual ${h.visual}`} aria-hidden="true">{h.emoji}</div>
                <div className="hack-body">
                  <div className="actions"><span className="draft-pill">Demo example · draft</span><span className="meta">{h.category}</span></div>
                  <h3>{h.title}</h3>
                  <p>{h.summary}</p>
                  <div className="actions"><Link className="btn primary" href={h.href}>Explore hack →</Link></div>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
      <div className="footer">All example hacks are drafts written for this preview, not live community posts or independently tested methods.</div>
    </>
  );
}
