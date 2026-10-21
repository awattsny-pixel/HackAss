'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from './SessionProvider.tsx';

const RETURN_AREAS = ['/spark', '/lab', '/reveal', '/states', '/account/prompts', '/account/results'];
/** Where the member should land after signing in: the page they are on, when it is one of the experience areas (the server validates it again). */
function returnTo(pathname: string): string | null {
  return RETURN_AREAS.some((p) => pathname === p || pathname.startsWith(p + '/')) ? pathname : null;
}

/** The signed-in indicator in the top bar. PROVISIONAL (claims level) by design: it says "signed in", never "verified". */
export function AccountChip() {
  const { session, recheck, signOut } = useSession();
  const pathname = usePathname();
  const next = returnTo(pathname);
  const href = next ? `/account/sign-in?next=${encodeURIComponent(next)}` : '/account/sign-in';
  const s = session.status;
  return (
    <div className="account-chip" role="group" aria-label="Account">
      <span className="account-state" role="status" aria-live="polite">
        {s === 'checking' ? 'Checking sign-in…' : null}
        {s === 'anonymous' ? 'Not signed in' : null}
        {s === 'member' ? 'Signed in' : null}
        {s === 'degraded' ? 'Signed in · can’t check right now' : null}
        {s === 'unavailable' ? 'Can’t check sign-in right now' : null}
      </span>
      {s === 'anonymous' ? <Link className="btn subtle small-btn" href={href}>Sign in</Link> : null}
      {(s === 'member' || s === 'degraded') && session.setupPending ? <a className="btn small-btn" href="/auth/set-password">Choose your password</a> : null}
      {s === 'member' || s === 'degraded' ? <button type="button" className="btn subtle small-btn" onClick={() => { void signOut(); }}>Sign out</button> : null}
      {s === 'unavailable' || s === 'degraded' ? <button type="button" className="btn subtle small-btn" onClick={() => { void recheck(); }}>Try again</button> : null}
    </div>
  );
}
