import { SparkCatalog, type CatalogView } from '@/src/ui/experience/SparkCatalog';
import { newRenderId, readPage } from '../_server/catalog';
import { loadMore } from './actions';

export const dynamic = 'force-dynamic';

export default async function SparkPage({ searchParams }: { searchParams: Promise<{ category?: string | string[] }> }) {
  const sp = await searchParams;
  const category = typeof sp.category === 'string' && sp.category ? sp.category : null;
  const [filtered, all] = await Promise.all([readPage({ limit: 25, ...(category ? { category } : {}) }), category ? readPage({ limit: 25 }) : null]);
  const source = all ?? filtered;
  const seen = new Map<string, string>();
  if (source.ok) for (const h of source.page.items) seen.set(h.category.slug, h.category.name);
  if (category && filtered.ok) for (const h of filtered.page.items) seen.set(h.category.slug, h.category.name);
  const renderId = newRenderId();
  const view: CatalogView = filtered.ok
    ? { renderId, status: 'ok', items: filtered.page.items, nextCursor: filtered.page.nextCursor, categories: [...seen].map(([slug, name]) => ({ slug, name })), activeCategory: category }
    : { renderId, status: filtered.kind, items: [], nextCursor: null, categories: [], activeCategory: category };
  return <SparkCatalog view={view} loadMore={loadMore} />;
}
