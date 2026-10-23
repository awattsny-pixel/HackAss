'use client';
// The compact account entry for the icon rail and the phone header: ONE button (a native <details>, so it is keyboard-operable and announced as a disclosure)
// that opens the same account controls as the sidebar (sign in, sign out, try again). Closes on Escape (focus returns to the button) and on navigation.
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { AccountChip } from './AccountChip.tsx';
import { accountSummary } from './account-summary.ts';
import { useSession } from './SessionProvider.tsx';

export function AccountMenu({ where }: { where: 'rail' | 'header' }) {
  const { session } = useSession();
  const pathname = usePathname();
  const ref = useRef<HTMLDetailsElement>(null);
  const label = accountSummary(session.status);
  useEffect(() => { if (ref.current) ref.current.open = false; }, [pathname]);
  return (
    <details className={`account-menu account-menu-${where}`} ref={ref} onKeyDown={(e) => { if (e.key === 'Escape' && ref.current?.open) { e.preventDefault(); ref.current.open = false; ref.current.querySelector('summary')?.focus(); } }}>
      <summary aria-label={`Account menu: ${label.name}`}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></svg>
        <span className="account-menu-label">{label.short}</span>
      </summary>
      <div className="account-menu-panel"><AccountChip /></div>
    </details>
  );
}
