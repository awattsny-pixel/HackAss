'use client';
// The prompt read as a sentence, with the parts the member can change highlighted INSIDE it (V3: "tap a highlight to change it"). Choosing a highlight opens an editor:
// an inline panel under the prompt on desktop, a bottom sheet on phones. The edit is one Apply, so Cancel and Escape leave everything untouched. The parent decides what
// Apply does (on the Hack page it first starts the draft through the replace-draft guard). The editor's unapplied text lives in the shared state for the current draft
// generation (the parent passes it in and receives changes), so a mode switch or page change keeps it and a reset or replacement clears it; this component holds no draft, no save and no dispatch.
// Parts that cannot be identified reliably (free text, a block edited past recognition) are one highlight for the whole prompt: nothing is split by guesswork.
import { LIMITS } from '../../modules/mywork/index.ts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { analyzePrompt, type EditorDraft, type Slot } from './guided.ts';
import { PROMPT_TAIL } from './prompt.ts';
import { OUTPUT_FORMATS, type PromptFields } from './types.ts';

export type { Slot };
export interface HighlightedPromptProps {
  readonly idPrefix: string;
  readonly fields: PromptFields;
  readonly fullPrompt: string;
  /** When set, the original is shown instead (read only): a view choice that changes nothing in the draft. */
  readonly original: string | null;
  /** This prompt's editor, if one is open, and how it changes. `null` closes it (Cancel, Escape). */
  readonly editor: EditorDraft | null;
  readonly onEditor: (editor: EditorDraft | null) => void;
  /** Apply: the parent applies the editor's text to the draft (a cancelled replace-draft guard leaves the editor open with what was typed). */
  readonly onApply: (editor: EditorDraft) => void;
}

const TITLE: Record<Slot, string> = { goal: 'Change the objective', context: 'Change the context and constraints', format: 'Change how the answer looks', all: 'Change your prompt' };
const NAME: Record<Slot, string> = { goal: 'objective', context: 'context and constraints', format: 'format', all: 'prompt' };
const EMPTY: Record<Slot, string> = { goal: 'add the result you want', context: 'add who it is for and any limits', format: 'choose a format', all: 'add your prompt' };
const MAX: Record<Slot, number> = { goal: LIMITS.goal, context: LIMITS.context, format: 0, all: LIMITS.prompt };

export function HighlightedPrompt(p: HighlightedPromptProps) {
  const { idPrefix: id, fields, fullPrompt } = p;
  const { editor } = p;
  const slot: Slot | null = editor ? editor.slot : null;
  const value = editor ? editor.value : '';
  const dialog = useRef<HTMLDialogElement>(null);
  const [last, setLast] = useState<Slot | null>(null); // the highlight that opened the editor last (it gets focus back)
  const link = analyzePrompt(fullPrompt, fields);
  const current = (s: Slot): string => (s === 'goal' ? fields.goal : s === 'context' ? fields.context : s === 'format' ? fields.format : fullPrompt);

  const open = (s: Slot) => { setLast(s); p.onEditor({ slot: s, value: current(s), base: current(s) }); };
  const close = () => p.onEditor(null);

  // The editor is a native dialog: a modal bottom sheet on phones (focus stays inside until it closes), an inline panel next to the prompt on wider screens.
  useEffect(() => {
    const d = dialog.current; if (!d) return;
    if (slot === null) { if (d.open) d.close(); return; }
    if (!d.open) { if (window.matchMedia('(max-width: 767px)').matches) d.showModal(); else d.show(); }
    const raf = requestAnimationFrame(() => { (d.querySelector('textarea, [aria-checked="true"], [role="radio"]') as HTMLElement | null)?.focus(); });
    return () => cancelAnimationFrame(raf);
  }, [slot]);
  // Focus returns to the highlight that opened the editor.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (slot !== null) { wasOpen.current = true; return; }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    let r2 = 0; // two frames: a confirmation dialog that closed at the same time hands focus back to its own opener first
    const raf = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => { document.getElementById(`${id}-hl-${last ?? 'all'}`)?.focus(); }); });
    return () => { cancelAnimationFrame(raf); cancelAnimationFrame(r2); };
  }, [slot, id, last]);

  const hl = (s: Slot, text: string) => (
    <button type="button" id={`${id}-hl-${s}`} className="hl-inline" aria-haspopup="dialog" aria-label={`Change the ${NAME[s]}: ${text.trim() || 'empty'}`} onClick={() => open(s)}>{text.trim() || <span className="hl-empty">{EMPTY[s]}</span>}</button>
  );

  let prose: ReactNode;
  if (p.original !== null) {
    prose = <div className="hl-prose" tabIndex={0} role="group" aria-label="Original prompt, read only"><p className="hl-plain">{p.original}</p></div>;
  } else if (link.kind !== 'follows') {
    prose = (
      <div className="hl-prose" role="group" aria-label="Your prompt. The highlighted text can be changed.">
        <p className="hl-plain">{hl('all', fullPrompt)}</p>
        <p className="muted small">{link.kind === 'free' ? 'This prompt is free text, so it has no separate parts to highlight: change it as one piece.' : 'This prompt was edited by hand, so its parts cannot be highlighted separately: change it as one piece.'}</p>
      </div>
    );
  } else {
    const rest = link.rest.trim();
    prose = (
      <div className="hl-prose" role="group" aria-label="Your prompt. The highlighted parts can be changed.">
        <p><span className="hl-label">Objective:</span> {hl('goal', fields.goal)}</p>
        <p><span className="hl-label">Context and constraints:</span> {hl('context', fields.context)}</p>
        <p><span className="hl-label">Return:</span> {hl('format', fields.format)}.</p>
        <p className="hl-fixed">{PROMPT_TAIL}</p>
        {rest ? <p className="hl-plain hl-rest">{rest}</p> : null}
        {rest ? <p className="muted small">The method steps stay as they are. Change them in Advanced.</p> : null}
      </div>
    );
  }

  const shown: Slot = slot ?? last ?? 'goal';
  const unchanged = editor !== null && value === editor.base;
  return (
    <div className="hl-wrap">
      {prose}
      <dialog ref={dialog} className="hl-editor" aria-labelledby={`${id}-ed-h`} onCancel={(e) => { e.preventDefault(); close(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
        <h4 id={`${id}-ed-h`}>{TITLE[shown]}</h4>
        {shown === 'format' ? (
          <div className="chips" role="radiogroup" aria-label="Output format">
            {OUTPUT_FORMATS.map((f) => <button key={f} type="button" role="radio" aria-checked={value === f} className={`chip${value === f ? ' on' : ''}`} onClick={() => p.onEditor({ slot: 'format', value: f, base: editor?.base ?? '' })}>{f}</button>)}
          </div>
        ) : (
          <textarea id={`${id}-ed-text`} className="hl-textarea" aria-labelledby={`${id}-ed-h`} maxLength={MAX[shown]} rows={shown === 'all' ? 8 : 4} value={value} onChange={(e) => p.onEditor({ slot: shown, value: e.target.value, base: editor?.base ?? '' })} />
        )}
        <div className="actions">
          <button type="button" className="btn primary" id={`${id}-apply`} disabled={unchanged} onClick={() => { if (editor) p.onApply(editor); }}>Apply</button>
          <button type="button" className="btn" id={`${id}-cancel`} onClick={close}>Cancel</button>
        </div>
      </dialog>
    </div>
  );
}
