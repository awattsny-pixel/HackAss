'use client';
// Build with Hack: a short, SCRIPTED exchange. Hack asks a fixed list of questions in a fixed order, the member answers in a box or with a suggestion chip, and the prompt
// updates as each answer lands. No AI is involved: the questions, the chips and the prompt are fixed rules (guided.ts, prompt.ts). Each answer is one of the existing draft fields,
// set through the same editSlot action as every other mode, so the draft, its revision, the guards and the save controller are the ones used everywhere.
// The answer being typed lives in the shared state for the current draft generation (a mode switch keeps it; a reset or replacement clears it; it counts as unsaved work).
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useExperience } from './ExperienceProvider.tsx';
import { ProviderLinks } from './ProviderLinks.tsx';
import { SavePanel } from '../work/SavePanel.tsx';
import { analyzePrompt, answerOf, applyAnswer, CHAT_STEPS, gettingThere, nextStep, SCRIPTED_NOTE, stepOf, titleSuggestion, type ChatFlags, type StepId } from './guided.ts';
import { composePrompt } from './prompt.ts';
import { useRebuild } from './useRebuild.ts';
import { useKeyboardInset } from './useKeyboardInset.ts';

const MARK = { filled: '✓', empty: '○', skipped: '–', too_long: '!' } as const;
const SKIPPED_TEXT = 'No rules, thanks';
export function GuidedPanel() {
  const { state, dispatch, toast, copy } = useExperience();
  const router = useRouter();
  const log = useRef<HTMLDivElement>(null);

  const { fields, fullPrompt } = state;
  const gen = state.draftGen;
  // Which questions are answered is the draft's own state (set when the draft was created, changed only by this exchange), never a guess from what the fields contain.
  const flags: ChatFlags = state.chat;
  // The answer being typed, and the question it belongs to, are shared state for this draft generation: they survive a mode switch or a page change.
  const answer = state.pending.answer;
  const text = answer?.text ?? '';
  const bound: StepId | null = answer?.step ?? null;
  const setAnswer = (t: string, id: StepId) => dispatch({ type: 'setAnswer', gen, answer: { text: t, step: id } });
  const clearAnswer = () => dispatch({ type: 'setAnswer', gen, answer: null });
  const open = nextStep(fields, flags);
  const asking: StepId | null = bound ?? open; // an answer typed for a question stays with that question
  const editing = bound !== null && bound !== open; // a Change of an earlier answer
  const step = asking ? stepOf(asking) : null;
  const main = useRef<HTMLDivElement>(null);
  // With a keyboard open the exchange is a panel pinned to the visible area (CSS: --vvt, --vvh), so Hack's current question and the answer box are on screen together whatever the browser does to the page behind it; the latest message stays in view.
  // WebKit resets a scroller's position when an ancestor changes between fixed and normal flow (the keyboard closing does exactly that), so the conversation is scrolled to the newest message again on the next frames.
  const toBottom = () => { const l = log.current; if (l) l.scrollTop = l.scrollHeight; };
  useKeyboardInset(() => { toBottom(); requestAnimationFrame(() => { toBottom(); requestAnimationFrame(toBottom); }); });
  const box = useRef<HTMLTextAreaElement>(null);

  // The conversation is read from the draft: a question and its answer for every step before the open one.
  const turns = useMemo(() => {
    const out: { id: StepId; ask: string; answer: string }[] = [];
    for (const s of CHAT_STEPS) {
      if (s.id === open) break;
      const a = answerOf(s.id, fields).trim();
      out.push({ id: s.id, ask: s.ask, answer: s.id === 'limits' && a === '' ? SKIPPED_TEXT : a });
    }
    return out;
  }, [fields, open]);
  // On a phone the exchange is the screen: when it opens, it is brought into view so the prompt, the conversation and the answer box are all on screen at once.
  useEffect(() => { if (window.matchMedia('(max-width: 767px)').matches) main.current?.scrollIntoView({ block: 'start' }); }, []);
  const count = turns.length + (open ? 1 : 0);
  useEffect(() => { toBottom(); const raf = requestAnimationFrame(toBottom); return () => cancelAnimationFrame(raf); }, [count, editing]);
  // The conversation changes height when the keyboard opens or closes (the exchange is repinned); it stays scrolled to the newest message through every such change.
  useEffect(() => { const l = log.current; if (!l || typeof ResizeObserver === 'undefined') return; const ro = new ResizeObserver(() => { l.scrollTop = l.scrollHeight; requestAnimationFrame(() => { l.scrollTop = l.scrollHeight; }); }); ro.observe(l); return () => ro.disconnect(); }, []);

  const link = analyzePrompt(fullPrompt, fields);
  const follows = link.kind === 'follows';
  const progress = gettingThere(fields, flags);
  const preview = follows ? fullPrompt : composePrompt(fields);
  const previewEmpty = follows && fullPrompt.trim() === '';
  const answered = turns.length;

  const tooLong = (id: StepId, t: string) => applyAnswer(id, t, fields) === null;
  const send = () => {
    if (!step || step.control !== 'text' || text.trim() === '') return;
    if (tooLong(step.id, text)) { toast('That answer would take the context and limits past their length limit. Shorten it and send it again.'); return; }
    dispatch({ type: 'sendAnswer', gen });
  };
  const chip = (insert: string | null, label: string) => {
    if (!step) return;
    if (step.control === 'format') { dispatch({ type: 'answerStep', gen, step: 'format', text: label }); return; }
    if (insert === null) { dispatch({ type: 'answerStep', gen, step: 'limits', text: '' }); return; } // Skip: the question is closed on purpose
    setAnswer(text.trim() === '' ? insert : /\s$/.test(text) ? text + insert : `${text} ${insert}`, step.id); box.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } };
  const change = (id: StepId) => { setAnswer(answerOf(id, fields), id); requestAnimationFrame(() => box.current?.focus()); };
  const suggestion = asking === 'title' ? titleSuggestion(fields.goal) : '';
  const chips = !step ? [] : step.id === 'title' ? (suggestion ? [{ label: `Use: ${suggestion}`, insert: suggestion }] : []) : step.chips;
  const copyPrompt = () => { const t = fullPrompt.trim(); if (!t) { toast('Answer a question first: there is no prompt to copy yet.'); return; } void copy(t); };

  return (
    <div className="build">
      <div className="build-main" ref={main}>
      <section className="build-preview" aria-labelledby="g-preview-h">
        <div className="bp-head"><h3 id="g-preview-h">Your prompt so far</h3><button type="button" className="btn show-989 bp-copy" onClick={copyPrompt}>Copy prompt</button><span className="muted small hide-989">Getting there</span></div>
        <ul className="parts" aria-label="Getting there">{progress.items.map((i) => <li key={i.id} className={`part ${i.status}`}><span aria-hidden="true">{MARK[i.status]}</span> {i.label}: {i.detail}</li>)}</ul>
        <div className="sample hl-preview" id="g-preview" tabIndex={0} aria-label="Prompt preview">{previewEmpty ? 'Your prompt will appear here as you answer.' : preview}</div>
        {!follows ? (
          <div className="banner" role="note">
            <p>{link.kind === 'stale' ? 'Your prompt text no longer matches these answers (it was edited by hand or in Advanced). This preview is built from the answers; your prompt text is unchanged.' : 'Your prompt text is free text, so it is not built from these answers. This preview is built from the answers; your prompt text is unchanged.'}</p>
            <RebuildButton />
          </div>
        ) : null}
        <p className="small" id="g-check-summary" role="status">{progress.summary}</p>
        <div className="show-989"><ProviderLinks text={fullPrompt.trim()} compact /></div>
      </section>

      <section className="build-chat" aria-labelledby="g-chat-h">
        <div className="bp-head"><h3 id="g-chat-h">Build with Hack</h3><span className="step-count small" id="g-step">{open ? `Question ${Math.min(count, CHAT_STEPS.length)} of ${CHAT_STEPS.length}` : 'All answered'}</span></div>
        <div className="steps5" aria-hidden="true">{CHAT_STEPS.map((s, i) => <span key={s.id} className={i < answered ? 'on' : i === answered && open ? 'now' : ''} />)}</div>
        <p className="muted small" id="g-note"><strong>{SCRIPTED_NOTE.split(': ')[0]}.</strong><span className="hide-767"> {SCRIPTED_NOTE.split(': ').slice(1).join(': ')}</span></p>
        <div className="bubbles" ref={log} role="log" aria-live="polite" aria-label="Conversation with Hack" tabIndex={0}>
          {turns.map((t) => (
            <div key={t.id} className="turn">
              <div className="bubble hack"><span className="dot" aria-hidden="true" />{t.ask}</div>
              <div className="bubble you"><span>{t.answer}</span><button type="button" className="bubble-edit" aria-label={`Change your answer: ${stepOf(t.id).ask}`} onClick={() => change(t.id)}>Change</button></div>
            </div>
          ))}
          <div className="bubble hack" id="g-question"><span className="dot" aria-hidden="true" />{step ? step.ask : 'That is everything I need. Choose Change on any answer to redo it.'}</div>
        </div>
        {step ? (
          <div className="composer">
            {chips.length ? (
              <div className="chips" role={step.control === 'format' ? 'radiogroup' : 'group'} aria-label={step.control === 'format' ? 'Output format' : 'Suggestions'}>
                {chips.map((c) => step.control === 'format'
                  ? <button key={c.label} type="button" role="radio" aria-checked={fields.format === c.label && flags.formatDone} className={`chip${fields.format === c.label && flags.formatDone ? ' on' : ''}`} onClick={() => chip(c.insert, c.label)}>{c.label}</button>
                  : <button key={c.label} type="button" className="chip" onClick={() => chip(c.insert, c.label)}>{c.label}</button>)}
              </div>
            ) : null}
            {step.control === 'text' ? (
              <form className="answer" onSubmit={(e) => { e.preventDefault(); send(); }}>
                <label htmlFor="g-answer" className="sr-only">Your answer to: {step.ask}{step.id === 'limits' ? ' (limits are saved in the context box, after the word Limits)' : ''}</label>
                <textarea id="g-answer" ref={box} rows={1} maxLength={step.max} placeholder={step.id === 'limits' ? 'Length, tone, things to avoid' : 'Type your answer'} value={text} onChange={(e) => setAnswer(e.target.value, step.id)} onKeyDown={onKey} />
                <button type="submit" className="btn primary" id="g-send" disabled={text.trim() === ''} aria-label="Send answer">Send</button>
              </form>
            ) : <p className="muted small">Choose a format. You can change it at any time.</p>}
            {editing ? <button type="button" className="btn subtle" id="g-cancel-change" onClick={clearAnswer}>Cancel the change</button> : null}
          </div>
        ) : null}
      </section>
      </div>

      <div className="build-actions">
        <div className="actions">
          <button type="button" className="btn primary hide-989" onClick={copyPrompt}>Copy prompt</button>
          <button type="button" className="btn subtle" onClick={() => router.push('/reveal')}>Next: How did it go? →</button>
        </div>
        <div className="hide-989"><ProviderLinks text={fullPrompt.trim()} /></div>
        <SavePanel />
      </div>
    </div>
  );
}

function RebuildButton() {
  const rebuild = useRebuild();
  const { state } = useExperience();
  const link = analyzePrompt(state.fullPrompt, state.fields);
  return <button type="button" className="btn" id="g-rebuild" onClick={rebuild}>{link.kind === 'stale' ? 'Rebuild the prompt from these answers' : 'Replace the prompt with this preview'}</button>;
}
