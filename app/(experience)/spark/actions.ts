'use server';
// READ-ONLY server action: the next page of the public catalog. It writes nothing and accepts only a category slug and a cursor,
// both re-validated by the catalog module.
import { readPage } from '../_server/catalog';

export async function loadMore(input: { category: string | null; after: { published_at: string; slug: string } }) {
  const r = await readPage({ limit: 25, ...(input.category ? { category: String(input.category) } : {}), after: { published_at: String(input.after?.published_at), slug: String(input.after?.slug) } });
  if (!r.ok) return { ok: false as const, kind: r.kind };
  return { ok: true as const, items: r.page.items, nextCursor: r.page.nextCursor };
}
