// Server-only composition of the catalog module with the platform: validated env + the ANONYMOUS public client. This is the only
// place the experience touches the database, and it only calls the two public read functions. Any configuration problem is reported
// as "unavailable" (never demo content, never a thrown page error).
import 'server-only';
import { getEnv } from '@/src/platform/env';
import { createPublicDb } from '@/src/platform/db/clients';
import { getPublicHack, listPublicHacks, type CatalogCursor, type DetailResult, type ListArgs, type ListResult, type RpcClient } from '@/src/modules/catalog';

function rpcClient(): RpcClient | null {
  try {
    const db = createPublicDb(getEnv('web'));
    return { rpc: (fn, args) => db.client.schema('api').rpc(fn, args) as unknown as ReturnType<RpcClient['rpc']> };
  } catch { return null; }
}

export async function readPage(args: ListArgs): Promise<ListResult> {
  const c = rpcClient();
  return c ? listPublicHacks(c, args) : { ok: false, kind: 'unavailable' };
}
export async function readHack(slug: string): Promise<DetailResult> {
  const c = rpcClient();
  return c ? getPublicHack(c, slug) : { ok: false, kind: 'unavailable' };
}
/** Identifies one server render of the list; a new value tells the client list to reset to the new result. */
export const newRenderId = (): string => globalThis.crypto.randomUUID();
export type { CatalogCursor };
