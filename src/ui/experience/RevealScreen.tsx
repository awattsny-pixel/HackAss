'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useExperience } from './ExperienceProvider.tsx';
import { HackGuide } from './HackGuide.tsx';
import { StateBox } from './StateBox.tsx';
import { ResultSavePanel } from '../work/ResultSavePanel.tsx';
import { OUTCOME_HINTS, OUTCOME_LABELS, OUTCOME_ORDER, reflectionText } from './prompt.ts';
import { LIMITS } from '../../modules/mywork/index.ts';
import type { Outcome } from './types.ts';

export function RevealScreen() {
  const router = useRouter();
  const { state, dispatch, copy } = useExperience();
  if (!state.started) {
    return (
      <>
        <div className="sectiontop"><div><span className="eyebrow">The Reveal</span><h1>How did it go?</h1></div></div>
        <StateBox kind="empty" title="Nothing to compare yet" actions={<><Link className="btn primary" href="/lab">Open The Lab</Link><Link className="btn" href="/spark">Browse The Spark</Link></>}>
          Start a prompt in The Lab first. When you come back from your AI tool, this page compares your starting version with your current one. Save it to your account or copy it.
        </StateBox>
      </>
    );
  }
  const r = state.reflection;
  return (
    <>
      <div className="sectiontop">
        <div><span className="eyebrow">The Reveal</span><h1>How did it go?</h1><p className="lead">Return from your AI tool, compare what you tried, and capture what you learned. No result is generated or published here.</p></div>
        <Link className="btn subtle" href="/lab">← The Lab</Link>
      </div>
      <div className="result-box">
        <div className="actions" style={{ justifyContent: 'space-between' }}><h2>Original and adapted prompt</h2><span className="draft-pill">Temporary session comparison</span></div>
        <div className="comparison">
          <div><h3>Starting version</h3><div className="sample" tabIndex={0} aria-label="Starting version">{state.startingPrompt || 'No starting version'}</div></div>
          <div><h3>Your current version</h3><div className="sample" tabIndex={0} aria-label="Your current version">{state.fullPrompt.trim() || 'No current prompt yet'}</div></div>
        </div>
      </div>
      <div className="detail-grid" style={{ marginTop: 18 }}>
        <div className="panel">
          <h2>Reflect on your attempt</h2>
          <fieldset className="outcomes" aria-describedby="outcome-note">
            <legend>Did it work?</legend>
            <div className="outcome-grid">{OUTCOME_ORDER.map((k) => (
              <label key={k} className="outcome-choice"><input type="radio" name="outcome" value={k} checked={r.outcome === k} onChange={() => dispatch({ type: 'reflect', field: 'outcome', value: k as Outcome })} /><b>{OUTCOME_LABELS[k]}</b><span>{OUTCOME_HINTS[k]}</span></label>
            ))}</div>
          </fieldset>
          <p className="muted small" id="outcome-note">Your answer is self-reported. A suggestion from an AI tool is not proof that it worked.</p>
          <div className="field"><label htmlFor="reflection">What happened? What would you improve?</label><textarea id="reflection" maxLength={LIMITS.reflection} placeholder="Describe what your external AI tool produced, what was useful, and any gaps." value={r.text} onChange={(e) => dispatch({ type: 'reflect', field: 'text', value: e.target.value })} /></div>
          <div className="field"><label htmlFor="nextVersion">One improvement for next time</label><input id="nextVersion" maxLength={LIMITS.nextChange} placeholder="e.g. Add a clearer budget constraint" value={r.next} onChange={(e) => dispatch({ type: 'reflect', field: 'next', value: e.target.value })} /></div>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => void copy(reflectionText(state.fields.title, r.outcome, r.text, r.next))}>Copy reflection</button>
            <button type="button" className="btn" onClick={() => router.push('/lab')}>Refine prompt in The Lab</button>
          </div>
          <ResultSavePanel />
          <div className="banner">Saving is explicit and private to your account. Nothing is posted publicly. You can still copy your reflection.</div>
        </div>
        <aside className="panel">
          <HackGuide>“Didn&apos;t nail it? Excellent. That&apos;s called learning. Let&apos;s make the next version smarter.”</HackGuide>
          <section><h3>Community publishing</h3><StateBox kind="info" title="Not connected">Sharing to the community is not available in this preview. Copy your work before leaving.</StateBox><button type="button" className="btn" disabled>Submit to community (unavailable)</button></section>
          <section><h3>Temporary and saved data</h3><p className="muted small">Until you save, your work stays on this page and reloading clears it. Saved prompts and results are in <Link href="/account/prompts">My prompts</Link> and <Link href="/account/results">My results</Link>.</p></section>
        </aside>
      </div>
    </>
  );
}
