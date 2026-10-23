// Line icons (Lucide-style paths, 2px stroke, round caps) for the six design categories; any other category gets a neutral tag. Decorative: the category name is always beside it.
import type { ReactNode } from 'react';
import { iconKeyFor, toneFor, type IconKey } from './format.ts';

const PATHS: Record<IconKey, ReactNode> = {
  all: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />,
  everyday: <path d="M7 3v8a2 2 0 0 0 2 2v8M11 3v6a2 2 0 0 1-2 2M17 21V3c-2 1-3.5 3.5-3.5 7 0 2 1 3 3.5 3" />,
  work: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18" /></>,
  money: <><circle cx="12" cy="12" r="9" /><path d="M14.5 9.2c-.6-.8-1.5-1.2-2.5-1.2-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-1.9-.4-2.5-1.2M12 6.5V8m0 8v1.5" /></>,
  life: <path d="M12 21s-7-4.4-9-9.3C1.8 8.2 4 5 7.2 5c1.9 0 3.4 1 4.8 3 1.4-2 2.9-3 4.8-3C20 5 22.2 8.2 21 11.7 19 16.6 12 21 12 21z" />,
  creative: <path d="M4 20l4-1 11-11a2.1 2.100 0 0 0-3-3L5 16zM14 7l3 3" />,
  visual: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.7" /><path d="M21 16l-5-5-9 9" /></>,
  other: <><path d="M20.5 13.500l-7 7a2 2 0 0 1-2.8 0L3 12.800V4h8.800l8.7 8.700a2 2 0 0 1 0 .8z" /><circle cx="8" cy="8.5" r="1" /></>,
};
export function CategoryIcon({ category }: { category: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{PATHS[iconKeyFor(category)]}</svg>;
}
/** The round coloured icon used on category chips. `all` is the "All" chip. */
export function ChipIcon({ category }: { category: string | null }) {
  return <span className={category === null ? 'chip-icon' : `chip-icon tone-${toneFor(category)}`} aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">{PATHS[category === null ? 'all' : iconKeyFor(category)]}</svg></span>;
}
