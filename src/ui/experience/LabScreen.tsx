'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useExperience } from './ExperienceProvider.tsx';
import { HackGuide } from './HackGuide.tsx';
import { StateBox } from './StateBox.tsx';
import { SavePanel } from '../work/SavePanel.tsx';
import { HACK_ADVICE, MODE_LABELS, MODE_PANELS, isOutputFormat } from './prompt.ts';
import { GuidedPanel } from './GuidedPanel.tsx';
import { HighlightedPrompt } from './HighlightedPrompt.tsx';
import type { Version } from './HackActions.tsx';
import { ProviderLinks } from './ProviderLinks.tsx';
import { EDIT_MODES, EDIT_MODE_LABELS, type EditMode } from './guided.ts';
import { useRebuild } from './useRebuild.ts';
import { NO_ORIGINAL } from './state.ts';
import { OUTPUT_FORMATS, type Mode } from './types.ts';
import { LIMITS } from '../../modules/mywork/index.ts';

const MODES: Mode[] = ['try', 'learn', 'master'];

export function LabScreen() {
  const router = useRouter();
  const { state, dispatch, confirmThen, toast, copy } = useExperience();
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const editTabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [version, setVersion] = useState<Version>('mine'); // which version Adapt shows: a view choice, never part of the draft
  const rebuild = useRebuild();
  const create = () => confirmThen('new', () => dispatch({ type: 'startBlank' }));

  if (!state.started) {
    return (
      <>
        <div className="sectiontop"><div><span className="eyebrow">The Lab</span><h1>Make it yours.</h1><p className="lead">Shape a prompt with Hack. Save it to your account, or copy it before leaving.</p></div></div>
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
  const onEditKey = (e: KeyboardEvent<HTMLButtonElement>, m: EditMode) => {
    const i = EDIT_MODES.indexOf(m);
    const next = e.key === 'ArrowRight' ? EDIT_MODES[(i + 1) % 3] : e.key === 'ArrowLeft' ? EDIT_MODES[(i + 2) % 3] : e.key === 'Home' ? EDIT_MODES[0] : e.key === 'End' ? EDIT_MODES[2] : null;
    if (next) { e.preventDefault(); dispatch({ type: 'setEditMode', editMode: next }); editTabs.current[next]?.focus(); }
  };
  const copyPrompt = () => { const p = state.fullPrompt.trim(); if (!p) { toast('Write a prompt before copying.'); return; } void copy(p); };
  const panel = MODE_PANELS[state.mode];

  return (
    <>
      <div className="sectiontop lab-head">
        <div><span className="eyebrow">The Lab</span><h1>{heading}</h1><p className="lead">Shape a prompt with Hack. Save it to your account, or copy it before leaving.</p></div>
        <Link className="btn subtle" href="/spark">← Discover</Link>
      </div>
      {origin?.source === 'demo' ? <div className="banner demo" role="note"><strong>Demo mode.</strong> This draft started from a demo example, not from the catalog.</div> : null}
      <div className="tabs" role="tablist" aria-label="Guidance mode">
        {MODES.map((m) => (
          <button key={m} type="button" role="tab" id={`tab-${m}`} aria-selected={state.mode === m} aria-controls="mode-panel" tabIndex={state.mode === m ? 0 : -1}
            ref={(el) => { tabs.current[m] = el; }} onKeyDown={(e) => onTabKey(e, m)} onClick={() => dispatch({ type: 'setMode', mode: m })}>{MODE_LABELS[m]}</button>
        ))}
      </div>
      <div className={`lab-grid${state.editMode === 'guided' ? ' guided' : ''}`}>
        <div className="panel">
          <div className="actions lab-bar" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <span className="draft-pill" role="status">{state.dirty ? 'Unsaved edits on this page' : 'No edits yet'}</span>
            <button type="button" className="btn subtle" onClick={() => confirmThen('reset', () => dispatch({ type: 'resetDraft' }))}>Reset draft</button>
          </div>
          <div className="tabs" role="tablist" aria-label="How to edit">
            {EDIT_MODES.map((m) => (
              <button key={m} type="button" role="tab" id={`edit-tab-${m}`} aria-selected={state.editMode === m} aria-controls="edit-panel" tabIndex={state.editMode === m ? 0 : -1}
                ref={(el) => { editTabs.current[m] = el; }} onKeyDown={(e) => onEditKey(e, m)} onClick={() => dispatch({ type: 'setEditMode', editMode: m })}>{EDIT_MODE_LABELS[m]}</button>
            ))}
          </div>
          <div id="edit-panel" role="tabpanel" aria-labelledby={`edit-tab-${state.editMode}`}>
            {state.editMode === 'guided' ? <GuidedPanel /> : null}
            {state.editMode === 'adapt' ? (
              <>
                <div className="field"><label htmlFor="adaptTitle">Prompt title</label><input id="adaptTitle" maxLength={LIMITS.title} placeholder="Give your prompt a name" value={fields.title} onChange={(e) => dispatch({ type: 'editSlot', field: 'title', value: e.target.value })} /></div>
                {state.startingPrompt !== NO_ORIGINAL && state.startingPrompt !== '' ? (
                  <div className="seg" role="group" aria-label="Which version to show">
                    <button type="button" aria-pressed={version === 'mine'} onClick={() => setVersion('mine')}>Your version</button>
                    <button type="button" aria-pressed={version === 'original'} onClick={() => setVersion('original')}>Original</button>
                  </div>
                ) : null}
                <HighlightedPrompt idPrefix="adapt" fields={fields} fullPrompt={state.fullPrompt} original={version === 'original' && state.startingPrompt !== NO_ORIGINAL && state.startingPrompt !== '' ? state.startingPrompt : null}
                  editor={state.pending.editors.adapt ?? null} onEditor={(editor) => dispatch({ type: 'setEditor', gen: state.draftGen, key: 'adapt', editor })} onApply={() => dispatch({ type: 'applyEditor', gen: state.draftGen, key: 'adapt' })} />
              </>
            ) : null}
            {state.editMode === 'advanced' ? (
              <>
                <div className="field"><label htmlFor="promptTitle">Prompt title</label><input id="promptTitle" maxLength={LIMITS.title} placeholder="Give your prompt a name" value={fields.title} onChange={(e) => dispatch({ type: 'editField', field: 'title', value: e.target.value })} /></div>
                <div className="field"><label htmlFor="promptGoal">What should the AI accomplish?</label><textarea id="promptGoal" maxLength={LIMITS.goal} placeholder="Describe the goal and expected outcome" value={fields.goal} onChange={(e) => dispatch({ type: 'editField', field: 'goal', value: e.target.value })} /></div>
                <div className="field"><label htmlFor="promptContext">Context or constraints</label><textarea id="promptContext" maxLength={LIMITS.context} placeholder="Audience, budget, tone, inputs, limitations..." value={fields.context} onChange={(e) => dispatch({ type: 'editField', field: 'context', value: e.target.value })} /></div>
                <div className="field"><label htmlFor="promptOutput">Preferred output</label>
                  <select id="promptOutput" value={fields.format} onChange={(e) => { if (isOutputFormat(e.target.value)) dispatch({ type: 'editField', field: 'format', value: e.target.value }); }}>{OUTPUT_FORMATS.map((f) => <option key={f}>{f}</option>)}</select></div>
                <h3>Editable prompt</h3>
                <p className="muted small">You can rewrite the complete prompt directly. Changing a field above does not rewrite it: choose Rebuild prompt from fields when you want that. Rebuilding replaces only the generated part and keeps the text after it.</p>
                <div className="field"><label className="sr-only" htmlFor="fullPrompt">Full prompt</label><textarea id="fullPrompt" className="prompt-box" maxLength={LIMITS.prompt} style={{ minHeight: 215 }} value={state.fullPrompt} onChange={(e) => dispatch({ type: 'editPrompt', value: e.target.value })} /></div>
                <div className="actions"><button type="button" className="btn" id="rebuild-prompt" onClick={rebuild}>Rebuild prompt from fields</button></div>
              </>
            ) : null}
          </div>
          {state.editMode === 'guided' ? null : (
            <>
              <div className="actions">
                <button type="button" className="btn primary" onClick={copyPrompt}>Copy prompt</button>
                <button type="button" className="btn subtle" onClick={() => router.push('/reveal')}>Next: How did it go? →</button>
              </div>
              <ProviderLinks text={state.fullPrompt.trim()} />
              <SavePanel />
            </>
          )}
          <div className="banner">Copy-out is how this version works today: copy the prompt and paste it into the AI tool you already use. HackAss sends nothing to an AI provider. Running AI inside HackAss is part of the approved vision and is not available yet.</div>
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
            <p className="muted small">Works with the external AI tool of your choice. Compatibility and results have not been validated. Copying is always free.</p>
            <button type="button" className="btn" onClick={() => router.push('/reveal')}>I&apos;ve tried it · Reflect →</button>
          </section>
        </aside>
      </div>
    </>
  );
}
