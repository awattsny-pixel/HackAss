// Module boundary: other code may import only this file (see docs/adr/0001-foundation.md).
// The public catalog READ side: a thin, validating wrapper around the two anonymous database functions of F2-E
// (api.list_public_hacks and api.get_public_hack). Nothing here can write, nothing here holds a database client (the
// composition root injects a handle that can only call functions), and every response is parsed against an allowlist
// schema before it reaches the UI. A failed or empty response is REPORTED as such: this module never substitutes
// other content.
import { z } from 'zod';

export const MODULE_NAME = 'catalog' as const;

// ---- types ---------------------------------------------------------------------------------------------------------
const slugSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80);
const categorySlugSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(40);
const text = (max: number) => z.string().max(max);
const intOrNull = z.number().int().nullable();

const itemShape = {
  slug: slugSchema,
  version_id: z.uuid(),
  published_at: z.iso.datetime({ offset: true }),
  category: z.object({ slug: categorySlugSchema, name: text(80) }),
  title: text(200),
  summary: text(1000),
  difficulty: z.enum(['easy', 'moderate', 'hard']).nullable(),
  time_minutes: z.object({ min: intOrNull, max: intOrNull }),
  cost: z.object({ min_cents: z.number().int().nullable(), max_cents: z.number().int().nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable() }),
  ai_requirement: z.enum(['none', 'helpful', 'required']).nullable(),
};
const cursorSchema = z.object({ published_at: z.iso.datetime({ offset: true }), slug: slugSchema });
const itemSchema = z.object(itemShape);
const pageSchema = z.object({ items: z.array(itemSchema).max(100), page_size: z.number().int().min(1).max(100), next_cursor: cursorSchema.nullable() });
const detailSchema = z.object({
  ...itemShape,
  outcome: text(2000).nullable(),
  estimate_basis: text(1000).nullable(),
  limitations: text(4000).nullable(),
  steps: z.array(z.object({ position: z.number().int(), body: text(4000) })).max(60),
  materials: z.array(z.object({ position: z.number().int(), name: text(300), detail: text(1000).nullable() })).max(60),
  requirements: z.array(z.object({ kind: z.string().max(40), name: text(300), detail: text(1000).nullable() })).max(60),
  tags: z.array(text(60)).max(60),
  attributions: z.array(z.object({ role: z.string().max(40), name: text(300).nullable(), url: text(500).nullable() })).max(20),
  sources: z.array(z.object({ kind: z.string().max(40), url: text(500).nullable(), author: text(300).nullable(), license: text(100).nullable(), license_version: text(60).nullable() })).max(20),
});

export type PublicHackItem = z.infer<typeof itemSchema>;
export type PublicHackDetail = z.infer<typeof detailSchema>;
export type CatalogCursor = z.infer<typeof cursorSchema>;
export interface HackPage { readonly items: readonly PublicHackItem[]; readonly nextCursor: CatalogCursor | null; readonly pageSize: number }

/** Why a read did not produce content. The caller shows the matching state; it never falls back to other content. */
export type CatalogFailureKind = 'denied' | 'unavailable' | 'invalid_response' | 'not_found' | 'invalid_request';
export interface CatalogFailure { readonly ok: false; readonly kind: CatalogFailureKind }
export type ListResult = { readonly ok: true; readonly page: HackPage } | CatalogFailure;
export type DetailResult = { readonly ok: true; readonly hack: PublicHackDetail } | CatalogFailure;

/** The only database capability the module receives: call one named function of the `api` schema. */
export interface RpcClient {
  rpc(fn: 'list_public_hacks' | 'get_public_hack', args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null; status?: number }>;
}

export interface ListArgs { readonly limit?: number; readonly category?: string; readonly difficulty?: 'easy' | 'moderate' | 'hard'; readonly after?: CatalogCursor }

// ---- helpers -------------------------------------------------------------------------------------------------------
type RpcError = { code?: string; message?: string } | null;
/** Maps a database/HTTP error to a user-facing kind WITHOUT carrying any provider text into the result. */
export function classifyFailure(error: RpcError, status?: number): CatalogFailureKind {
  const code = error?.code ?? '';
  if (code === 'PT404' || (status === 404 && code !== 'PGRST202')) return 'not_found';
  if (code === 'PT422') return 'invalid_request';
  if (status === 401 || status === 403 || code === '42501' || code === 'PGRST301' || code === 'PGRST302') return 'denied';
  return 'unavailable';
}

// ---- reads ---------------------------------------------------------------------------------------------------------
export async function listPublicHacks(db: RpcClient, args: ListArgs = {}): Promise<ListResult> {
  const limit = args.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false, kind: 'invalid_request' };
  if (args.category !== undefined && !categorySlugSchema.safeParse(args.category).success) return { ok: false, kind: 'invalid_request' };
  if (args.after !== undefined && !cursorSchema.safeParse(args.after).success) return { ok: false, kind: 'invalid_request' };
  let res: Awaited<ReturnType<RpcClient['rpc']>>;
  try {
    res = await db.rpc('list_public_hacks', {
      p_limit: limit, p_category: args.category ?? null, p_difficulty: args.difficulty ?? null,
      p_after_published_at: args.after?.published_at ?? null, p_after_slug: args.after?.slug ?? null,
    });
  } catch { return { ok: false, kind: 'unavailable' }; }
  if (res.error) return { ok: false, kind: classifyFailure(res.error, res.status) };
  const parsed = pageSchema.safeParse(res.data);
  if (!parsed.success) return { ok: false, kind: 'invalid_response' };
  return { ok: true, page: { items: parsed.data.items, nextCursor: parsed.data.next_cursor, pageSize: parsed.data.page_size } };
}

export async function getPublicHack(db: RpcClient, slug: string): Promise<DetailResult> {
  if (!slugSchema.safeParse(slug).success) return { ok: false, kind: 'not_found' };
  let res: Awaited<ReturnType<RpcClient['rpc']>>;
  try { res = await db.rpc('get_public_hack', { p_slug: slug }); } catch { return { ok: false, kind: 'unavailable' }; }
  if (res.error) return { ok: false, kind: classifyFailure(res.error, res.status) };
  const parsed = detailSchema.safeParse(res.data);
  if (!parsed.success) return { ok: false, kind: 'invalid_response' };
  return { ok: true, hack: parsed.data };
}
