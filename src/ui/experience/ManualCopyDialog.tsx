'use client';
// Shown when the clipboard write could not be confirmed: the text is selected in a read-only box with plain instructions, so copying never depends on the
// browser's permission. Uses the native modal <dialog> (focus trapped, Escape closes, focus returns to the control that opened it).
import { useEffect, useId, useRef } from 'react';
import { MANUAL_COPY_HELP, MANUAL_COPY_TITLE } from './copy.ts';

export function ManualCopyDialog({ text, onClose }: { text: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const titleId = useId(); const descId = useId();
  const open = text !== null;
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) { d.showModal(); area.current?.focus(); area.current?.select(); }
    if (!open && d.open) d.close();
  }, [open, text]);
  return (
    <dialog ref={ref} className="confirm" aria-labelledby={titleId} aria-describedby={descId} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <h2 id={titleId}>{MANUAL_COPY_TITLE}</h2>
      <p id={descId} className="muted">{MANUAL_COPY_HELP}</p>
      <label className="sr-only" htmlFor={`${titleId}-text`}>Text to copy</label>
      <textarea id={`${titleId}-text`} ref={area} className="manual-copy" readOnly value={text ?? ''} onFocus={(e) => e.currentTarget.select()} />
      <div className="actions" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn primary" onClick={onClose}>Done</button></div>
    </dialog>
  );
}
