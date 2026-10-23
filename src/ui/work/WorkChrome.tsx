'use client';
import Link from 'next/link';
import { StateBox } from '../experience/StateBox.tsx';
import { failureText } from './messages.ts';

export function WorkTabs({ current }: { current: 'prompts' | 'results' }) {
  return (
    <nav className="work-tabs" aria-label="My hacks">
      <Link href="/account/prompts" aria-current={current === 'prompts' ? 'page' : undefined}>Prompts</Link>
      <Link href="/account/results" aria-current={current === 'results' ? 'page' : undefined}>Results</Link>
    </nav>
  );
}
/** The error / sign-in / outage state of a saved-work page. The member's unsaved draft is never touched by any of these. */
export function WorkProblem({ kind, next, onRetry }: { kind: string; next: string; onRetry: () => void }) {
  if (kind === 'unauthenticated') return <StateBox kind="denied" title="Sign in to see your saved work" actions={<Link id="work-signin" className="btn primary" href={`/account/sign-in?next=${encodeURIComponent(next)}`}>Sign in</Link>}>Your saved prompts and results are private to your account. Anything you haven’t saved is still on the Lab page.</StateBox>;
  if (kind === 'not_found') return <StateBox kind="error" title="Not found" actions={<Link className="btn" href="/account/prompts">My prompts</Link>}>That item was not found. It may have been deleted.</StateBox>;
  return <StateBox kind="error" title={kind === 'forbidden' || kind === 'setup_required' ? 'Saved work isn’t available yet' : 'Saved work can’t be reached right now'} actions={kind === 'forbidden' || kind === 'setup_required' ? undefined : <button type="button" id="work-retry" className="btn" onClick={onRetry}>Try again</button>}>{failureText(kind)}</StateBox>;
}
