'use client';
import Link from 'next/link';
import { useSyncExternalStore, type ReactNode } from 'react';
import { useExperience } from './ExperienceProvider.tsx';
import { HackGuide } from './HackGuide.tsx';
import { greetingFor, homeGuidance } from './home.ts';
import { useNewHack } from './NewHack.ts';

const noop = () => () => {};
/** The server render and hydration use the neutral "Hello" (the server cannot know the member's time zone); the browser's own clock gives the real greeting. No name is shown: none is available here. */
function useGreeting(): string { return useSyncExternalStore(noop, () => greetingFor(new Date().getHours()), () => 'Hello'); }

/** The Spark / Demo source switch: which list the cards come from. */
export function SourceSwitch({ mode }: { mode: 'catalog' | 'demo' }) {
  return (
    <nav className="modeswitch" aria-label="Hack source">
      <Link href="/spark" aria-current={mode === 'catalog' ? 'page' : undefined}>Published catalog</Link>
      <Link href="/spark/demo" aria-current={mode === 'demo' ? 'page' : undefined}>Demo examples</Link>
    </nav>
  );
}

/** Home: greeting, the question, a prominent "Create a prompt" entry (the same guarded action as the shell's New hack) and Hack's contextual guidance. Category chips follow as `children`. */
export function SparkHeader({ mode, children }: { mode: 'catalog' | 'demo'; children?: ReactNode }) {
  const { state } = useExperience();
  const create = useNewHack();
  const greeting = useGreeting();
  const g = homeGuidance(state.started, state.dirty, mode);
  return (
    <>
      <div className="hero">
        <div>
          <p className="greeting" suppressHydrationWarning>{greeting}</p>
          <h1>What do you want to hack?</h1>
          <button type="button" className="create-card" onClick={create}>
            <span className="create-mark" aria-hidden="true">+</span>
            <span><b>Create a prompt</b><span className="sub">Start from a blank prompt. Always free.</span></span>
          </button>
        </div>
        <div className="home-guide">
          <HackGuide heading="Hack says" size={64}>
            <span>{g.text}</span>
            {g.continueDraft ? <><br /><Link className="guide-link" href="/lab">Continue your draft →</Link></> : null}
          </HackGuide>
        </div>
      </div>
      {children}
    </>
  );
}
