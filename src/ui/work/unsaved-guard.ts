'use client';
// Unsaved-edit protection: while `active`, closing or reloading the page raises the browser's warning, and clicking an in-app link asks first (Stay is the default).
// Back/Forward within the app keeps the edits (shared in-memory state, see edit-store.ts); the page warning covers leaving the site.
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useExperience } from '../experience/ExperienceProvider.tsx';

/** `onDiscard` runs when the member explicitly chooses to leave and lose the edits (the unsaved state is then removed). The browser's Back button is not intercepted: the edits are kept in memory and restored by Forward. */
export function useUnsavedGuard(active: boolean, what: string, onDiscard?: () => void): void {
  const router = useRouter();
  const { confirm } = useExperience();
  useEffect(() => {
    if (!active) return;
    const before = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const u = new URL(a.href, location.href);
      if (u.origin !== location.origin || (u.pathname === location.pathname && u.search === location.search)) return;
      e.preventDefault(); e.stopPropagation();
      confirm({ title: 'Leave without saving?', message: `You have changes to ${what} that are not saved. If you leave now they will be lost.`, confirmLabel: 'Leave and discard', cancelLabel: 'Stay and keep editing', danger: true, run: () => { onDiscard?.(); router.push(u.pathname + u.search + u.hash); } });
    };
    window.addEventListener('beforeunload', before);
    document.addEventListener('click', click, true);
    return () => { window.removeEventListener('beforeunload', before); document.removeEventListener('click', click, true); };
  }, [active, what, confirm, router, onDiscard]);
}
