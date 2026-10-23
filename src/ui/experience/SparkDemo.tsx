'use client';
import { useState } from 'react';
import { DEMO_CATEGORIES, DEMO_HACKS } from './demo-hacks.ts';
import { ChipIcon } from './CategoryIcon.tsx';
import { HackCard } from './HackCard.tsx';
import { SourceSwitch, SparkHeader } from './SparkHeader.tsx';
import { StateBox } from './StateBox.tsx';

/** DEMO MODE: the three draft examples of the UX-08 prototype. Always labelled; reachable only on purpose (never a fallback for the catalog). */
export function SparkDemo() {
  const [cat, setCat] = useState<string>('All');
  const shown = DEMO_HACKS.filter((h) => cat === 'All' || h.category === cat);
  return (
    <>
      <SparkHeader mode="demo">
        <div className="chips" role="group" aria-label="Demo categories">
          {['All', ...DEMO_CATEGORIES].map((c) => (
            <button key={c} type="button" className="chip" aria-current={cat === c ? 'true' : undefined} onClick={() => setCat(c)}><ChipIcon category={c === 'All' ? null : c} />{c}</button>
          ))}
        </div>
      </SparkHeader>
      <div className="banner demo" role="note"><strong>Demo mode.</strong> These three examples are draft content written for design review. They are not in the published catalog, not verified methods and not community posts.</div>
      <div className="sectiontop"><h2>Worth a try</h2><SourceSwitch mode="demo" /></div>
      {shown.length === 0 ? <StateBox kind="empty">No examples match this category.</StateBox> : (
        <ul className="cards">
          {shown.map((h) => (
            <li key={h.key}>
              <HackCard href={h.href} title={h.title} summary={h.summary} category={h.category} demo>
                <span className="credit">Draft written for design review · not community verified</span>
              </HackCard>
            </li>
          ))}
        </ul>
      )}
      <div className="footer">All example hacks are drafts written for this preview, not live community posts or independently tested methods.</div>
    </>
  );
}
