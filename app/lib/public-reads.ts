// Public read handlers (M01-B). All database access for anonymous reads lives here so it can be
// tested with an injected client. This file must not import anything (it is loaded directly by
// the Node test runner). Rules: approved content only, explicit field allowlists applied both in
// the query and to the output, identical response for missing and unpublished hacks.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = { from(table: string): any };

export const HACK_LIST_FIELDS = [
  'id', 'title', 'description', 'category', 'difficulty', 'why_it_works', 'content_type',
  'content_url', 'content_thumbnail', 'source_attribution', 'source_platform', 'worked_votes',
  'failed_votes', 'unique_users_who_validated', 'view_count', 'share_count', 'like_count',
  'bookmark_count', 'hack_score', 'created_at',
] as const;
export const HACK_DETAIL_FIELDS = [
  'id', 'title', 'description', 'category', 'difficulty', 'why_it_works', 'content_type',
  'content_url', 'content_thumbnail', 'created_at', 'worked_votes', 'failed_votes', 'view_count',
  'share_count', 'like_count', 'bookmark_count', 'source_attribution', 'user_id',
] as const;
// real_name, bio and website_url are NOT public: no consent/visibility flag exists yet (CTO review).
// Attribution uses username only until managed profile settings exist.
export const AUTHOR_FIELDS = ['id', 'username', 'avatar', 'profile_image_url', 'is_verified'] as const;
export const COMMENT_AUTHOR_FIELDS = ['id', 'username', 'avatar', 'profile_image_url'] as const;
export const USER_HACK_CARD_FIELDS = ['id', 'title', 'description', 'category', 'content_type', 'content_thumbnail', 'created_at', 'worked_votes', 'failed_votes'] as const;

export const PAGINATION = { commentsDefaultLimit: 5, maxLimit: 50, maxOffset: 10000, userHacksDefaultLimit: 12 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_HEADERS = { 'Cache-Control': 'no-store' };

const cols = (f: readonly string[]) => f.join(', ');
function pick<T extends readonly string[]>(row: Record<string, unknown> | null | undefined, fields: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!row) return out;
  for (const k of fields) if (k in row) out[k] = row[k];
  return out;
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: JSON_HEADERS });
export const hackNotFound = () => json({ error: 'Hack not found' }, 404);
const userNotFound = () => json({ message: 'User not found' }, 404);
const serverError = () => json({ error: 'Internal server error' }, 500);

/** Parse a non-negative integer query value. null = absent, NaN-like/invalid => 'invalid'. */
function intParam(sp: URLSearchParams, name: string): number | null | 'invalid' {
  const raw = sp.get(name);
  if (raw === null) return null;
  if (!/^\d{1,9}$/.test(raw)) return 'invalid';
  return Number(raw);
}

export function parsePagination(
  sp: URLSearchParams,
  defaultLimit: number,
): { ok: true; limit: number; offset: number } | { ok: false } {
  const l = intParam(sp, 'limit');
  const o = intParam(sp, 'offset');
  if (l === 'invalid' || o === 'invalid') return { ok: false };
  if (l === 0) return { ok: false };
  if (o !== null && o > PAGINATION.maxOffset) return { ok: false };
  return { ok: true, limit: Math.min(l ?? defaultLimit, PAGINATION.maxLimit), offset: o ?? 0 };
}

async function approvedHackExists(db: Db, hackId: string): Promise<boolean | 'error'> {
  if (!UUID.test(hackId)) return false;
  const { data, error } = await db.from('hacks').select('id').eq('id', hackId).eq('status', 'approved').maybeSingle();
  if (error) return 'error';
  return !!data;
}

export async function getApprovedHackList(db: Db): Promise<Response> {
  try {
    const { data, error } = await db
      .from('hacks').select(cols(HACK_LIST_FIELDS)).eq('status', 'approved')
      .order('created_at', { ascending: false }).order('id', { ascending: false });
    if (error) return serverError();
    return json({ hacks: (data || []).map((h: Record<string, unknown>) => pick(h, HACK_LIST_FIELDS)) });
  } catch { return serverError(); }
}

const ANON_AUTHOR = (id: unknown) => ({ id: id ?? null, username: 'Unknown', avatar: null, profile_image_url: null, is_verified: false });

/** Approved hack plus public author, allowlisted. null = not found/unpublished/malformed; 'error' = DB failure. */
async function fetchPublicHack(db: Db, hackId: string): Promise<Record<string, unknown> | null | 'error'> {
  if (!UUID.test(hackId)) return null;
  const { data: hack, error } = await db
    .from('hacks').select(cols(HACK_DETAIL_FIELDS)).eq('id', hackId).eq('status', 'approved').maybeSingle();
  if (error) return 'error';
  if (!hack) return null; // identical for missing and unpublished
  let author: Record<string, unknown> | null = null;
  if (hack.user_id) {
    const { data: u, error: uErr } = await db.from('users').select(cols(AUTHOR_FIELDS)).eq('id', hack.user_id).maybeSingle();
    if (uErr) return 'error';
    author = u ? pick(u, AUTHOR_FIELDS) : null;
  }
  return { ...pick(hack, HACK_DETAIL_FIELDS), users: author ?? ANON_AUTHOR(hack.user_id) };
}

export async function getPublicHack(db: Db, hackId: string): Promise<Response> {
  try {
    const r = await fetchPublicHack(db, hackId);
    if (r === 'error') return serverError();
    if (!r) return hackNotFound();
    return json(r);
  } catch { return serverError(); }
}

/** Page-load outcome: a database failure is never reported as not_found. */
export type PageLoad<T> = { status: 'ok'; data: T } | { status: 'not_found' } | { status: 'error' };
const toPageLoad = (r: Record<string, unknown> | null | 'error'): PageLoad<Record<string, unknown>> =>
  r === 'error' ? { status: 'error' } : r ? { status: 'ok', data: r } : { status: 'not_found' };

/** For server-rendered pages: same projection as the API. */
export async function loadPublicHackPage(db: Db, hackId: string): Promise<PageLoad<Record<string, unknown>>> {
  try { return toPageLoad(await fetchPublicHack(db, hackId)); } catch { return { status: 'error' }; }
}

export async function listPublicComments(db: Db, hackId: string, sp: URLSearchParams): Promise<Response> {
  try {
    const page = parsePagination(sp, PAGINATION.commentsDefaultLimit);
    if (!page.ok) return json({ error: 'Invalid pagination parameters' }, 400);
    const exists = await approvedHackExists(db, hackId);
    if (exists === 'error') return serverError();
    if (!exists) return hackNotFound();
    const { limit, offset } = page;
    const { data: comments, error } = await db
      .from('comments').select('id, content, created_at, user_id').eq('hack_id', hackId)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return serverError();
    const { count, error: countError } = await db.from('comments').select('id', { count: 'exact', head: true }).eq('hack_id', hackId);
    if (countError) return serverError();
    const ids = [...new Set((comments || []).map((c: { user_id: string }) => c.user_id))];
    const byId: Record<string, Record<string, unknown>> = {};
    if (ids.length > 0) {
      const { data: users, error: uErr } = await db.from('users').select(cols(COMMENT_AUTHOR_FIELDS)).in('id', ids);
      if (uErr) return serverError();
      for (const u of users || []) byId[u.id] = pick(u, COMMENT_AUTHOR_FIELDS);
    }
    return json({
      data: (comments || []).map((c: { id: string; content: string; created_at: string; user_id: string }) => {
        const u = byId[c.user_id];
        return {
          id: c.id, content: c.content, created_at: c.created_at, user_id: c.user_id,
          users: u ? { id: u.id, username: u.username, avatar: u.profile_image_url || u.avatar }
                   : { id: c.user_id, username: 'Unknown', avatar: null },
        };
      }),
      meta: { hasMore: offset + limit < (count || 0), total: count || 0, offset, limit },
    });
  } catch { return serverError(); }
}

const PROFILE_FIELDS = ['id', 'username', 'avatar', 'profile_image_url', 'is_verified', 'followers_count', 'following_count'] as const; // no email, real_name, bio, website_url

/** Public post count: approved hacks only, counted directly (never from an aggregate view). */
async function countApprovedHacks(db: Db, userId: string): Promise<number | 'error'> {
  const { count, error } = await db.from('hacks').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'approved');
  if (error || count === null || count === undefined) return 'error';
  return count;
}

async function fetchPublicProfile(db: Db, username: string): Promise<Record<string, unknown> | null | 'error'> {
  if (!username || username.length > 100) return null;
  const { data: user, error } = await db.from('users').select(cols(PROFILE_FIELDS)).eq('username', username).maybeSingle();
  if (error) return 'error';
  if (!user) return null;
  const posts = await countApprovedHacks(db, user.id);
  if (posts === 'error') return 'error';
  return {
    id: user.id, username: user.username, avatar: user.avatar, profile_image_url: user.profile_image_url,
    is_verified: user.is_verified, followers: user.followers_count || 0, following: user.following_count || 0, posts,
  };
}

export async function getPublicProfile(db: Db, username: string): Promise<Response> {
  try {
    const r = await fetchPublicProfile(db, username);
    if (r === 'error') return serverError();
    if (!r) return userNotFound();
    return json(r);
  } catch { return serverError(); }
}

/** For the server-rendered profile page (replaces select('*') from user_stats). */
export async function loadPublicProfilePage(db: Db, username: string): Promise<PageLoad<Record<string, unknown>>> {
  try { return toPageLoad(await fetchPublicProfile(db, username)); } catch { return { status: 'error' }; }
}

export async function listUserHacks(db: Db, username: string, sp: URLSearchParams): Promise<Response> {
  try {
    const l = intParam(sp, 'limit');
    if (l === 'invalid' || l === 0) return json({ error: 'Invalid pagination parameters' }, 400);
    const limit = Math.min(l ?? PAGINATION.userHacksDefaultLimit, PAGINATION.maxLimit);
    const cursor = sp.get('cursor');
    if (cursor !== null && Number.isNaN(Date.parse(cursor))) return json({ error: 'Invalid pagination parameters' }, 400);
    if (!username || username.length > 100) return userNotFound();
    const tab = sp.get('tab') || 'grid';
    // Private bookmarks are never served from a public, unauthenticated route.
    if (tab === 'bookmarks') return json({ data: [], meta: { hasMore: false, cursor: null } });
    const { data: user, error: userErr } = await db.from('users').select('id').eq('username', username).maybeSingle();
    if (userErr) return serverError();
    if (!user) return userNotFound();
    let q = db.from('hacks').select(cols(USER_HACK_CARD_FIELDS)).eq('user_id', user.id).eq('status', 'approved')
      .order('created_at', { ascending: false }).order('id', { ascending: false });
    if (tab === 'videos') q = q.in('content_type', ['video/mp4', 'video/youtube', 'video/webm']);
    if (cursor) q = q.lt('created_at', cursor);
    const { data, error } = await q.limit(limit + 1);
    if (error) return serverError(); // never report a failed query as an empty collection
    const rows = (data || []).map((h: Record<string, unknown>) => pick(h, USER_HACK_CARD_FIELDS));
    const page = rows.slice(0, limit);
    return json({ data: page, meta: { hasMore: rows.length > limit, cursor: page.length ? page[page.length - 1].created_at : null } });
  } catch { return serverError(); }
}

const CARD_USER_FIELDS = ['id', 'username', 'avatar', 'profile_image_url', 'is_verified', 'followers_count', 'following_count'] as const;

export async function getCardData(db: Db, username: string): Promise<Response> {
  try {
    if (!username || username.length > 100) return userNotFound();
    const { data: user, error: userErr } = await db.from('users').select(cols(CARD_USER_FIELDS)).eq('username', username).maybeSingle();
    if (userErr) return serverError();
    if (!user) return userNotFound();
    // Counts come from the users row and a direct approved-only count; the user_stats aggregate is not used
    // because its publication filtering is unverified.
    const posts = await countApprovedHacks(db, user.id);
    if (posts === 'error') return serverError();
    const { data: recent, error: recentErr } = await db.from('hacks').select('id, title, content_thumbnail').eq('user_id', user.id).eq('status', 'approved')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(6);
    if (recentErr) return serverError();
    return json({
      id: user.id, username: user.username, avatar: user.avatar, profile_image_small_url: user.profile_image_url,
      is_verified: user.is_verified,
      posts, followers: user.followers_count || 0, following: user.following_count || 0,
      recentHacks: (recent || []).map((h: Record<string, unknown>) => pick(h, ['id', 'title', 'content_thumbnail'] as const)),
      // Follow state cannot be established without a verified visitor identity; do not claim a value.
      follow_state: 'unavailable',
    });
  } catch { return serverError(); }
}
