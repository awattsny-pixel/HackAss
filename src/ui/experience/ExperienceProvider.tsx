'use client';
// The temporary, in-memory state of the whole journey (survives navigation between the screens, is discarded on reload) and the two
// shared pieces of UI that need it: the overwrite-confirmation dialog and the toast. No storage API is used anywhere.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createStore, type Store } from './store.ts';
import { emptyEdits, reduceEditMap, type EditMap, type EditMapAction } from '../work/edit-store.ts';
import { initialState, reduce, requiresConfirmation, type Action, type ExperienceState, type Replacement } from './state.ts';
import type { ExperienceHack } from './types.ts';
import { workApi } from '../work/api.ts';
import { createWorkController, type WorkController } from '../work/controller.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { Toast } from './Toast.tsx';
import { COPIED, copyText, createCopyFlow, type CopyFlow } from './copy.ts';
import { ManualCopyDialog } from './ManualCopyDialog.tsx';

export interface ConfirmOptions { readonly title: string; readonly message: string; readonly confirmLabel: string; readonly cancelLabel?: string; readonly danger?: boolean; readonly run: () => void }
interface Pending { readonly title?: string; readonly message: string; readonly confirmLabel: string; readonly cancelLabel?: string; readonly danger?: boolean; readonly run: () => void }
interface Ctx {
  readonly state: ExperienceState;
  readonly dispatch: (a: Action) => void;
  /** Runs `run` now, or after the member confirms when unsaved work would be replaced. */
  readonly confirmThen: (what: Replacement, run: () => void) => void;
  /** A confirmation with its own wording (delete, overwrite, leaving a conflict). Cancel is the focused default. */
  readonly confirm: (o: ConfirmOptions) => void;
  /** Saving: explicit save of the prompt and of the result, and the conflict choices. The state is read synchronously, so a decision never uses a stale draft. */
  readonly work: WorkController;
  /** Unsaved result-detail edits, in memory only, scoped to account epoch and result id (see work/edit-store.ts). Cleared on an account change. */
  readonly edits: Store<EditMap, EditMapAction>;
  readonly view: (hack: ExperienceHack) => void;
  readonly toast: (message: string) => void;
  readonly copy: (text: string) => Promise<void>;
  /** Account boundary: closes and clears the manual-copy dialog and the toast, and invalidates clipboard requests still running (see copy.ts). */
  readonly invalidateCopies: () => void;
}
const ExperienceContext = createContext<Ctx | null>(null);
export function useExperience(): Ctx {
  const c = useContext(ExperienceContext);
  if (!c) throw new Error('useExperience must be used inside ExperienceProvider');
  return c;
}

const MESSAGES: Record<Replacement, { message: string; confirmLabel: string }> = {
  adapt: { message: 'You have unsaved work. Adapting another hack will replace your current draft and reflection. Copy anything you want to keep first.', confirmLabel: 'Replace my draft' },
  new: { message: 'You have unsaved work. Creating a new prompt will replace your current draft and reflection. Copy anything you want to keep first.', confirmLabel: 'Replace my draft' },
  reset: { message: 'You have unsaved work. Resetting will replace your current draft and reflection. Copy anything you want to keep first.', confirmLabel: 'Reset my draft' },
  load: { message: 'You have unsaved work. Opening this saved prompt will replace your current draft and reflection. Save or copy anything you want to keep first.', confirmLabel: 'Open the saved prompt' },
  regenerate: { message: 'Replace the editable prompt with a new draft assembled from the fields? Your manual edits to the prompt will be lost.', confirmLabel: 'Replace the prompt' },
};

export function ExperienceProvider({ children }: { children: ReactNode }) {
  // The synchronous store (see store.ts): the save controller reads the latest draft through store.get(), so what it submits is exactly what is on screen.
  const [store] = useState(() => createStore<ExperienceState, Action>(initialState, reduce));
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const dispatch = store.dispatch;
  const [edits] = useState(() => createStore<EditMap, EditMapAction>(emptyEdits, reduceEditMap));
  const [pending, setPending] = useState<Pending | null>(null);
  const [toastText, setToastText] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((message: string) => {
    setToastText(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(''), 3500);
  }, []);
  const confirmThen = useCallback((what: Replacement, run: () => void) => {
    if (!requiresConfirmation(store.get(), what)) { run(); return; }
    setPending({ ...MESSAGES[what], run });
  }, [store]);
  const confirm = useCallback((o: ConfirmOptions) => { setPending(o); }, []);
  const [work] = useState<WorkController>(() => createWorkController({ api: workApi, getState: store.get, dispatch: store.dispatch, newId: () => crypto.randomUUID(), now: () => Date.now() }));
  const view = useCallback((hack: ExperienceHack) => dispatch({ type: 'view', hack }), [dispatch]);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  // "Copied" is announced only after the browser confirms the write. Otherwise nothing is claimed: the text is shown selected, with manual-copy instructions.
  // The flow is bound to the account boundary: invalidateCopies() (called by AccountBoundary) clears the dialog and the toast and drops late clipboard answers.
  const clearCopyUi = useCallback(() => { setManualCopy(null); setToastText(''); }, []);
  // The flow object owns the account-boundary epoch. It is created once, after mount (a ref is only touched in effects and handlers).
  const copyFlow = useRef<CopyFlow | null>(null);
  useEffect(() => { copyFlow.current = createCopyFlow({ write: copyText, onCopied: () => toast(COPIED), onManual: setManualCopy, onClear: clearCopyUi }); }, [toast, clearCopyUi]);
  const copy = useCallback(async (text: string) => { await copyFlow.current?.copy(text); }, []);
  const invalidateCopies = useCallback(() => { copyFlow.current?.invalidate(); }, []);

  // Unsaved prompt or reflection edits: the browser warns before the page is closed or reloaded.
  useEffect(() => {
    if (!state.dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [state.dirty]);

  const value = useMemo<Ctx>(() => ({ state, dispatch, confirmThen, confirm, work, edits, view, toast, copy, invalidateCopies }), [state, dispatch, confirmThen, confirm, work, edits, view, toast, copy, invalidateCopies]);
  return (
    <ExperienceContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        title={pending?.title ?? 'Replace unsaved work?'}
        message={pending?.message ?? ''}
        confirmLabel={pending?.confirmLabel ?? 'Continue'}
        cancelLabel={pending?.cancelLabel}
        danger={pending?.danger}
        onCancel={() => setPending(null)}
        onConfirm={() => { const p = pending; setPending(null); p?.run(); }}
      />
      <ManualCopyDialog text={manualCopy} onClose={() => setManualCopy(null)} />
      <Toast message={toastText} />
    </ExperienceContext.Provider>
  );
}
