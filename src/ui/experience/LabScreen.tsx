'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, type KeyboardEvent } from 'react';
import { useExperience } from './ExperienceProvider.tsx';
import { HackGuide } from './HackGuide.tsx';
import { StateBox } from './StateBox.tsx';
import { SavePanel } from '../work/SavePanel.tsx';
import { HACK_ADVICE, MODE_LABELS, MODE_PANELS, isOutputFormat } from './prompt.ts';
import { OUTPUT_FORMATS, type Mode } from './types.ts';

const MODES: Mode[] = ['try', 'learn', 'master'];

export function LabScreen() {
  const router = useRouter();
  const { state, dispatch, confirmThen, toast, copy } = useExperience();
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const create = () => confirmThen('new', () => dispatch({ type: 'startBlank' }));

  if (!state.started) {
    return (
      <>
        <div className="sectiontop"><div><span className="eyebrow">THE LAB</span><h1>Make it yours.</h1><p className="lead">Shape a prompt with Hack. Save it to your account, or copy it before leaving.</p></div></div>
        <StateBox kind="empty" title="No draft yet" actions={<><button type="button" className="btn primary" onClick={create}>＋ Create a Prompt</button><Link className="btn" href="/spark">Browse The Spark</Link></>}>
          Start from a hack in The Spark, or create a prompt from scratch. Sign in to save your work to your account; until then it lives on this page and is lost on reload.
        </StateBox>
      </>
    );
  }

  const { fields } = state;
  const origin = state.origin;
  const heading = origin ? 'Make this hack yours.' : 'Create your own prompt.';
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, m: Mode) => {
    const i = MODES.indexOf(m);
    const next = e.key === 'ArrowRight' ? MODES[(i + 1) % 3] : e.key === 'ArrowLeft' ? MODES[(i + 2) % 3] : e.key === 'Home' ? MODES[0] : e.key === 'End' ? MODES[2] : null;
    if (next) { e.preventDefault(); dispatch({ type: 'setMode', mode: next }); tabs.current[next]?.focus(); }
  };
  const copyPrompt = () => { const p = state.fullPrompt.trim(); if (!p) { toast('Write a prompt before copying.'); return; } void copy(p); };
  const panel = MODE_PANELS[state.mode];

  return (
    <>
      <div className="sectiontop">
        <div><span className="eyebrow">THE LAB</span><h1>{heading}</h1><p className="lead">Shape a prompt with Hack. Save it to your account, or copy it before leaving.</p></div>
        <Link className="btn subtle" href="/spark">← Discover</Link>
      </div>
      {origin?.source === 'demo' ? <div className="banner demo" role="note"><strong>Demo mode.</strong> This draft started from a demo example, not from the catalog.</div> : null}
      <div className="tabs" role="tablist" aria-label="Guidance mode">
        {MODES.map((m) => (
          <button key={m} type="button" role="tab" id={`tab-${m}`} aria-selected={state.mode === m} aria-controls="mode-panel" tabIndex={state.mode === m ? 0 : -1}
            ref={(el) => { tabs.current[m] = el; }} onKeyDown={(e) => onTabKey(e, m)} onClick={() => dispatch({ type: 'setMode', mode: m })}>{MODE_LABELS[m]}</button>
        ))}
      </div>
      <div className="lab-grid">
        <div className="panel">
          <div className="actions" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <span className="draft-pill" role="status">{state.dirty ? 'Unsaved edits on this page' : 'No edits yet'}</span>
            <button type="button" className="btn subtle" onClick={() => confirmThen('reset', () => dispatch({ type: 'resetDraft' }))}>Reset draft</button>
          </div>
          <div className="field"><label htmlFor="promptTitle">Prompt title</label><input id="promptTitle" maxLength={120} placeholder="Give your prompt a name" value={fields.title} onChange={(e) => dispatch({ type: 'editField', field: 'title', value: e.target.value })} /></div>
          <div className="field"><label htmlFor="promptGoal">What should the AI accomplish?</label><textarea id="promptGoal" placeholder="Describe the goal and expected outcome" value={fields.goal} onChange={(e) => dispatch({ type: 'editField', field: 'goal', value: e.target.value })} /></div>
          <div className="field"><label htmlFor="promptContext">Context or constraints</label><textarea id="promptContext" placeholder="Audience, budget, tone, inputs, limitations..." value={fields.context} onChange={(e) => dispatch({ type: 'editField', field: 'context', value: e.target.value })} /></div>
          <div className="field"><label htmlFor="promptOutput">Preferred output</label>
            <select id="promptOutput" value={fields.format} onChange={(e) => { if (isOutputFormat(e.target.value)) dispatch({ type: 'editField', field: 'format', value: e.target.value }); }}>{OUTPUT_FORMATS.map((f) => <option key={f}>{f}</option>)}</select></div>
          <h3>Editable prompt</h3>
          <p className="muted small">You can rewrite the complete prompt directly. It won&apos;t be automatically overwritten when you change a field unless you choose Regenerate draft.</p>
          <div className="field"><label className="sr-only" htmlFor="fullPrompt">Full prompt</label><textarea id="fullPrompt" style={{ minHeight: 215, fontFamily: 'ui-monospace,monospace', fontSize: 13 }} value={state.fullPrompt} onChange={(e) => dispatch({ type: 'editPrompt', value: e.target.value })} /></div>
          <div className="actions">
            <button type="button" className="btn" onClick={() => confirmThen('regenerate', () => { dispatch({ type: 'regenerate' }); toast('Local draft regenerated · not saved'); })}>Regenerate draft from fields</button>
            <button type="button" className="btn primary" onClick={copyPrompt}>Copy prompt ↗</button>
            <button type="button" className="btn" onClick={() => router.push('/reveal')}>Compare versions →</button>
          </div>
          <SavePanel />
          <div className="banner">Copy sends text to your clipboard only. Paste into your own AI tool. No prompt is sent to an AI provider by HackAss.</div>
        </div>
        <aside className="panel">
          <HackGuide heading="Hack · Your AI badass"><span>{state.fullPrompt || fields.goal ? HACK_ADVICE[state.mode] : '“You bring the goal. I’ll help with the structure. No magic wand required.”'}</span></HackGuide>
          <section id="mode-panel" role="tabpanel" aria-labelledby={`tab-${state.mode}`}><h3>{panel.heading}</h3><p className="muted small">{panel.body}</p></section>
          <section>
            <h3>AI assistance</h3>
            <StateBox kind="ai" title="AI unavailable in this preview">Hack&apos;s coaching content is prewritten. Live generation, critique and model integrations are not connected.</StateBox>
            <button type="button" className="btn" disabled>Ask Hack to improve this (unavailable)</button>
          </section>
          <section>
            <h3>Copy-out workflow</h3>
            <p className="muted small">Works with an external AI tool of your choice. Compatibility and results have not been validated.</p>
            <button type="button" className="btn" onClick={() => router.push('/reveal')}>I&apos;ve tried it · Reflect →</button>
          </section>
        </aside>
      </div>
    </>
  );
}
