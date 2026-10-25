'use client';
// After a CONFIRMED copy of exactly this prompt, offers the member's AI tools. Each link is a fixed home page (see providers.ts) opened by a separate click in a new tab:
// nothing is built from the prompt or the member, nothing is opened by script, and the row disappears as soon as the prompt, the draft or the account changes.
import { useId } from 'react';
import { useExperience } from './ExperienceProvider.tsx';
import { PROVIDERS } from './providers.ts';

/** `compact`: just the four buttons in one row (the phone's copy bar); the same fixed links. */
export function ProviderLinks({ text, compact = false }: { text: string; compact?: boolean }) {
  const { copiedExactly } = useExperience();
  const id = useId();
  if (text === '' || !copiedExactly(text)) return null;
  if (compact) {
    return (
      <div className="provider-row compact" role="group" aria-label="Open your AI tool">
        <div className="actions">
          {PROVIDERS.map((p) => <a key={p.id} className="btn" data-provider={p.id} href={p.href} target="_blank" rel="noopener noreferrer">{p.name}<span className="sr-only"> (opens in a new tab)</span></a>)}
        </div>
      </div>
    );
  }
  return (
    <div className="provider-row" role="group" aria-labelledby={id}>
      <p id={id} className="small"><strong>Copied.</strong> Open your AI tool, then paste it there yourself.</p>
      <div className="actions">
        {PROVIDERS.map((p) => (
          <a key={p.id} className="btn" data-provider={p.id} href={p.href} target="_blank" rel="noopener noreferrer">Open {p.name}<span className="sr-only"> (opens in a new tab)</span></a>
        ))}
      </div>
      <p className="muted small">Each button opens that tool&apos;s home page in a new tab. HackAss sends nothing: not your prompt, not anything about you.</p>
    </div>
  );
}
