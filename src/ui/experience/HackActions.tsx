'use client';
// The Hack page's action panel (V3 web: a sticky side panel; phone: the actions under the prompt). Supported actions only: copy, copy-then-open, Original / Your version,
// Save my version, How did it go?, and the way into the Lab. Sharing and remixing are shown unavailable. Nothing here saves or copies except through the shared
// controller and copy flow.
import Link from 'next/link';
import { useExperience } from './ExperienceProvider.tsx';
import { ProviderLinks } from './ProviderLinks.tsx';
import { promptSaveView } from './state.ts';
import { SavePanel } from '../work/SavePanel.tsx';
import { useKeyboardInset } from './useKeyboardInset.ts';

export type Version = 'mine' | 'original';
export interface HackActionsProps {
  readonly bound: boolean;
  readonly version: Version;
  readonly onVersion: (v: Version) => void;
  /** The exact text the member is looking at: what Copy puts on the clipboard. */
  readonly shown: string;
  readonly copyLabel: string;
  readonly onCopy: () => void;
  readonly onLab: () => void;
}

export function HackActions(p: HackActionsProps) {
  const { state, copiedExactly } = useExperience();
  useKeyboardInset();
  const saveView = promptSaveView(state);
  const status = !p.bound ? 'Original' : saveView === 'saved' ? 'Saved' : state.dirty ? 'Unsaved' : 'Original';
  const copied = copiedExactly(p.shown);
  return (
    <>
    <section className="actions-panel panel" aria-label="Actions">
      <button type="button" className="btn primary block hide-767" id="hack-copy" onClick={p.onCopy}>{p.copyLabel}</button>
      <div className="hide-767">{copied ? <ProviderLinks text={p.shown} /> : <p className="muted small">Copy first, then open your AI tool from here.</p>}</div>
      <div className="act-row">
        <button type="button" className="btn" disabled aria-disabled="true" aria-describedby="hack-unavail">Share</button>
        <button type="button" className="btn" disabled aria-disabled="true" aria-describedby="hack-unavail">Remix</button>
      </div>
      <p className="muted small" id="hack-unavail">Sharing and remixing are not available in this preview.</p>
      <div className="your-version">
        <div className="yv-head"><h3>Your version</h3><span className={`save-pill ${status === 'Saved' ? 'saved' : ''}`} id="hack-version-status">{status}</span></div>
        {p.bound ? (
          <div className="seg" role="group" aria-label="Which version to show">
            <button type="button" aria-pressed={p.version === 'mine'} onClick={() => p.onVersion('mine')}>Your version</button>
            <button type="button" aria-pressed={p.version === 'original'} onClick={() => p.onVersion('original')}>Original</button>
          </div>
        ) : null}
        {p.bound ? <SavePanel compact /> : (
          <>
            <button type="button" className="btn block" disabled aria-disabled="true" aria-describedby="hack-save-hint">Save my version</button>
            <p className="muted small" id="hack-save-hint">Change a highlighted part first. Your version starts when you apply a change.</p>
          </>
        )}
        {p.bound ? <Link className="btn block" href="/reveal">How did it go?</Link> : <button type="button" className="btn block" disabled aria-disabled="true">How did it go?</button>}
      </div>
      <button type="button" className="btn subtle block" id="hack-lab" onClick={p.onLab}>{p.bound ? 'Continue in the Lab →' : 'Make it yours →'}</button>
      <p className="muted small">Copy-out only: HackAss sends nothing anywhere, and AI inside HackAss is not available yet.</p>
    </section>
    {/* Phones: Copy stays at the bottom of the screen, above the bottom navigation, the safe area and the on-screen keyboard. */}
    <div className="copy-bar">
      {copied ? <ProviderLinks text={p.shown} compact /> : null}
      <button type="button" className="btn primary block" id="hack-copy-bar" onClick={p.onCopy}>{p.copyLabel}</button>
      {copied ? null : <p className="muted small">Copy, then open ChatGPT, Claude, Gemini or Copilot.</p>}
    </div>
    </>
  );
}
