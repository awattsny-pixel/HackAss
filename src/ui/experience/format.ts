// Presentation helpers for catalog fields (pure).
export function timeRange(t: { min: number | null; max: number | null }): string | null {
  const { min, max } = t;
  if (min === null && max === null) return null;
  if (min !== null && max !== null) return min === max ? `${min} min` : `${min}–${max} min`;
  return `${min ?? max} min`;
}
export function costRange(c: { min_cents: number | null; max_cents: number | null; currency: string | null }): string | null {
  const { min_cents: a, max_cents: b, currency } = c;
  if ((a === null && b === null) || !currency) return null;
  const fmt = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
  const lo = a ?? b as number; const hi = b ?? a as number;
  return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
}
export const AI_LABEL = { none: 'No AI needed', helpful: 'AI helpful', required: 'AI required' } as const;
export const DIFFICULTY_LABEL = { easy: 'Easy', moderate: 'Moderate', hard: 'Hard' } as const;
export function visualFor(slug: string): 'a' | 'b' | 'c' | 'd' | 'e' | 'f' {
  let h = 0; for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (['a', 'b', 'c', 'd', 'e', 'f'] as const)[h % 6];
}
/** The card colour for a category (the approved palette): the six design categories by name, any other category by a stable hash so a card never changes colour between renders. */
export function toneFor(category: string): 'a' | 'b' | 'c' | 'd' | 'e' | 'f' {
  const named: Record<string, 'a' | 'b' | 'c' | 'd' | 'e' | 'f'> = { everyday: 'a', work: 'b', business: 'b', creative: 'c', money: 'd', life: 'e', visual: 'f' };
  return named[category.trim().toLowerCase()] ?? visualFor(category.trim().toLowerCase());
}
export type IconKey = 'all' | 'everyday' | 'work' | 'money' | 'life' | 'creative' | 'visual' | 'other';
/** The icon for a category: the six design categories by name (Business shares Work's), anything else a neutral tag. */
export function iconKeyFor(category: string): IconKey {
  const named: Record<string, IconKey> = { everyday: 'everyday', work: 'work', business: 'work', money: 'money', life: 'life', creative: 'creative', visual: 'visual' };
  return named[category.trim().toLowerCase()] ?? 'other';
}
export const formatDate = (iso: string): string => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
