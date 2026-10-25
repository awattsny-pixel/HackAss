// Clipboard export: the ONLY way text leaves the experience. Nothing is sent anywhere by HackAss.
// Success is reported ONLY after the browser confirms the write. When it cannot be confirmed the caller shows the text selected for manual copying
// (ManualCopyDialog); it never says "copied" for a write that did not happen.
export type CopyResult = 'copied' | 'blocked';
export async function copyText(text: string): Promise<CopyResult> {
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.append(t); t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    t.remove();
    return ok ? 'copied' : 'blocked';
  }
}
export const COPIED = 'Copied. Paste it into your AI tool · nothing saved or published';
export const MANUAL_COPY_TITLE = 'Copy it yourself';
export const MANUAL_COPY_HELP = 'Your browser did not allow automatic copying, so nothing has been copied yet. The text is selected below: press Ctrl+C (or ⌘C on a Mac), then paste it into your AI tool.';

/**
 * The copy flow with an account boundary. A clipboard request that is still running when the account changes (sign-out, sign-in, a check that finds the member
 * signed out) is INVALIDATED: its late answer can neither reopen the manual-copy dialog with the old text nor announce success under the new account. `invalidate`
 * also clears whatever the flow is currently showing (an open dialog, a toast). The working draft itself is not touched here: it may stay on the page, unsaved.
 */
export interface CopyFlowDeps {
  readonly write: (text: string) => Promise<CopyResult>;
  /** `stamp` is whatever the caller passed to `copy` (the provider remembers which draft revision the confirmed copy belonged to). */
  readonly onCopied: (text: string, stamp?: unknown) => void;
  readonly onManual: (text: string) => void;
  readonly onClear: () => void;
}
export function createCopyFlow(deps: CopyFlowDeps) {
  let epoch = 0;
  return {
    async copy(text: string, stamp?: unknown): Promise<void> {
      const mine = epoch;
      let result: CopyResult;
      try { result = await deps.write(text); } catch { result = 'blocked'; }
      if (mine !== epoch) return;                // the account changed while the request ran: say nothing, show nothing
      if (result === 'copied') deps.onCopied(text, stamp); else deps.onManual(text);
    },
    invalidate(): void { epoch++; deps.onClear(); },
  };
}
export type CopyFlow = ReturnType<typeof createCopyFlow>;

/** A copy the browser CONFIRMED, remembered with the draft revision and generation it belonged to. */
export interface CopiedRecord { readonly text: string; readonly revision: number; readonly epoch: number }
/** True only for exactly the same text, the same revision of the same draft generation. Any edit, a new or reset draft, or an account change (which clears the record) makes it false. */
export const copyStillValid = (rec: CopiedRecord | null, text: string, revision: number, epoch: number): boolean => rec !== null && rec.text === text && rec.revision === revision && rec.epoch === epoch;
