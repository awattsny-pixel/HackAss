'use client';
// Overwrite confirmation. Uses the native modal <dialog>: focus is trapped inside while it is open, Escape cancels, and focus returns to the
// control that opened it. "Cancel" is the default (focused) action, so an accidental Enter never destroys work.
import { useEffect, useId, useRef } from 'react';

export interface ConfirmDialogProps { open: boolean; title: string; message: string; confirmLabel: string; cancelLabel?: string; danger?: boolean; onCancel: () => void; onConfirm: () => void }

export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel = 'Keep my draft', danger = false, onCancel, onConfirm }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId(); const descId = useId();
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="confirm" aria-labelledby={titleId} aria-describedby={descId} role="alertdialog" onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <h2 id={titleId}>{title}</h2>
      <p id={descId} className="muted">{message}</p>
      <div className="actions" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" autoFocus onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}
