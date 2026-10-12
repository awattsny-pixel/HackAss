// M01-B behavioral tests for public read handlers, using an in-memory fake client that returns
// FULL rows (including private columns), so the tests prove handler-side allowlisting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lib = await import(pathToFileURL(join(root, 'app/lib/public-reads.ts')).href);

type Row = Record<string, unknown>;
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const H_APPROVED = ID(1), H_PENDING = ID(2), H_REJECTED = ID(3), H_MISSING = ID(99);
const U1 = ID(101), U2 = ID(102);

function makeDb(tables: Record<string, Row[]>) {
  const calls: { table: string; select?: string }[] = [];
  const from = (table: string) => {
    let rows = [...(tables[table] || [])];
    let head = false; let wantCount = false; const orders: [string, boolean][] = [];
    let lo = 0, hi = Infinity; let lim = Infinity; const entry: { table: string; select?: string } = { table };
    calls.push(entry);
    const q: any = {
      select(c: string, o?: { count?: string; head?: boolean }) { entry.select = c; head = !!o?.head; wantCount = !!o?.count; return q; },
      eq(c: string, v: unknown) { rows = rows.filter((r) => r[c] === v); return q; },
      in(c: string, vs: unknown[]) { rows = rows.filter((r) => vs.includes(r[c])); return q; },
      lt(c: string, v: string) { rows = rows.filter((r) => String(r[c]) < v); return q; },
      order(c: string, o: { ascending: boolean }) { orders.push([c, o.ascending]); return q; },
      range(a: number, b: number) { lo = a; hi = b + 1; return q; },
      limit(n: number) { lim = n; return q; },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'none' } }); },
      then(res: (v: unknown) => unknown) {
        const total = rows.length;
        const sorted = [...rows].sort((a, b) => { for (const [c, asc] of orders) { const x = String(a[c]), y = String(b[c]); if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1); } return 0; });
        const data = head ? null : sorted.slice(lo, Math.min(hi, lo + lim === Infinity ? hi : hi)).slice(0, lim);
        return Promise.resolve({ data, error: null, count: wantCount ? total : null }).then(res);
      },
    };
    return q;
  };
  return { from, calls };
}

const hack = (id: string, status: string, extra: Row = {}): Row => ({
  id, title: `t-${id.slice(-2)}`, description: 'd', category: 'Food', difficulty: 'easy', why_it_works: 'w',
  content_type: 'link', content_url: 'https://example.com/x', content_thumbnail: null, source_attribution: null,
  source_platform: null, worked_votes: 1, failed_votes: 0, unique_users_who_validated: 1, view_count: 0,
  share_count: 0, like_count: 0, bookmark_count: 0, hack_score: 1, created_at: '2026-01-01T00:00:00Z',
  user_id: U1, status, created_by: 'admin', updated_at: '2026-01-02', internal_notes: 'SECRET', ...extra,
});
const user = (id: string, name: string): Row => ({
  id, username: name, email: `${name}@private.test`, password_hash: 'SECRET', real_name: null, bio: 'b', website_url: null,
  avatar: null, profile_image_url: null, is_verified: false, followers_count: 0, following_count: 0,
});
const comment = (n: number, hackId: string, at: string): Row => ({ id: ID(500 + n), hack_id: hackId, user_id: U1, content: `c${n}`, created_at: at, moderation: 'SECRET' });

const world = () => makeDb({
  hacks: [hack(H_APPROVED, 'approved'), hack(H_PENDING, 'pending'), hack(H_REJECTED, 'rejected')],
  users: [user(U1, 'alice'), user(U2, 'bob')],
  comments: [comment(1, H_APPROVED, 'T1'), comment(2, H_APPROVED, 'T2'), comment(3, H_APPROVED, 'T2'), comment(4, H_PENDING, 'T3')],
  bookmarks: [{ id: 'b1', user_id: U1, hack_id: H_PENDING }],
});
const FORBIDDEN = ['status', 'created_by', 'updated_at', 'internal_notes', 'email', 'password_hash', 'moderation'];
const leaks = (o: unknown) => FORBIDDEN.filter((k) => JSON.stringify(o).includes(`"${k}"`));
const sp = (s: string) => new URLSearchParams(s);

test('hack-by-ID: approved returns allowlisted public fields only', async () => {
  const db = world();
  const res = await lib.getPublicHack(db, H_APPROVED);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, H_APPROVED);
  assert.deepEqual(leaks(body), []);
  assert.equal(body.users.username, 'alice');
  assert.equal('email' in body.users, false);
  for (const c of db.calls) assert.ok(!/\*|email|status|password/.test(c.select || ''), `non-explicit select: ${c.select}`);
});

test('hack-by-ID: pending, rejected, missing and malformed IDs give the identical response', async () => {
  const seen = new Set<string>();
  for (const id of [H_PENDING, H_REJECTED, H_MISSING, 'not-a-uuid', "' or 1=1 --"]) {
    const db = world();
    const res = await lib.getPublicHack(db, id);
    assert.equal(res.status, 404, id);
    seen.add(`${res.status}|${await res.text()}`);
    assert.ok(!db.calls.some((c) => c.table === 'users'), 'unpublished hack must not trigger author lookup');
  }
  assert.equal(seen.size, 1, `responses differ: ${[...seen]}`);
});

test('hack list: approved only, explicit allowlist, no private fields, newest first', async () => {
  const db = world();
  const body = await (await lib.getApprovedHackList(db)).json();
  assert.deepEqual(body.hacks.map((h: Row) => h.id), [H_APPROVED]);
  assert.deepEqual(leaks(body), []);
  assert.equal('user_id' in body.hacks[0], false);
});

test('comments: unpublished and missing hacks reveal nothing and match hack-not-found', async () => {
  const notFound = await (await lib.getPublicHack(world(), H_MISSING)).text();
  for (const id of [H_PENDING, H_REJECTED, H_MISSING, 'bad-id']) {
    const db = world();
    const res = await lib.listPublicComments(db, id, sp(''));
    assert.equal(res.status, 404, id);
    assert.equal(await res.text(), notFound);
    assert.ok(!db.calls.some((c) => c.table === 'comments' || c.table === 'users'), 'no comment/user query for unpublished hack');
  }
});

test('comments: approved hack, deterministic order (created_at desc, id desc), no private fields', async () => {
  const body = await (await lib.listPublicComments(world(), H_APPROVED, sp(''))).json();
  assert.deepEqual(body.data.map((c: Row) => c.content), ['c3', 'c2', 'c1']);
  assert.deepEqual(body.meta, { hasMore: false, total: 3, offset: 0, limit: 5 });
  assert.deepEqual(leaks(body), []);
  const page2 = await (await lib.listPublicComments(world(), H_APPROVED, sp('limit=1&offset=1'))).json();
  assert.deepEqual(page2.data.map((c: Row) => c.content), ['c2']);
  assert.equal(page2.meta.hasMore, true);
});

test('comments: invalid pagination is rejected with 400 and no comment query', async () => {
  for (const q of ['limit=abc', 'limit=-1', 'limit=0', 'limit=1.5', 'limit=', 'limit=1e3', 'limit=99999999999', 'offset=-5', 'offset=x', 'offset=10001', 'limit=%20%205']) {
    const db = world();
    const res = await lib.listPublicComments(db, H_APPROVED, sp(q));
    assert.equal(res.status, 400, q);
    assert.ok(!db.calls.some((c) => c.table === 'comments'), q);
  }
});

test('comments: oversized limit is capped at the maximum; boundary offset allowed', async () => {
  const body = await (await lib.listPublicComments(world(), H_APPROVED, sp('limit=51&offset=10000'))).json();
  assert.equal(body.meta.limit, 50);
  assert.equal(body.meta.offset, 10000);
  const big = await (await lib.listPublicComments(world(), H_APPROVED, sp('limit=999999999'))).json();
  assert.equal(big.meta.limit, 50);
});

test('profile: email and credentials are never returned', async () => {
  const res = await lib.getPublicProfile(world(), 'alice');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.username, 'alice');
  assert.deepEqual(leaks(body), []);
  assert.equal((await lib.getPublicProfile(world(), 'nobody')).status, 404);
});

test('user hacks: bookmarks tab is never served; only approved; limit validated and capped', async () => {
  let db = world();
  let body = await (await lib.listUserHacks(db, 'alice', sp('tab=bookmarks'))).json();
  assert.deepEqual(body.data, []);
  assert.ok(!db.calls.some((c) => c.table === 'bookmarks'));
  db = world();
  body = await (await lib.listUserHacks(db, 'alice', sp(''))).json();
  assert.deepEqual(body.data.map((h: Row) => h.id), [H_APPROVED]);
  assert.deepEqual(leaks(body), []);
  for (const q of ['limit=abc', 'limit=0', 'limit=-3', 'cursor=notadate']) assert.equal((await lib.listUserHacks(world(), 'alice', sp(q))).status, 400, q);
  assert.equal((await lib.listUserHacks(world(), 'alice', sp('limit=100000'))).status, 200);
});

test('card data: no bespoke-token lookup; isFollowing is false; no private fields', async () => {
  const db = world();
  const body = await (await lib.getCardData(db, 'alice')).json();
  assert.equal(body.isFollowing, false);
  assert.deepEqual(leaks(body), []);
  assert.ok(!db.calls.some((c) => c.table === 'auth_tokens' || c.table === 'follows'));
});

test('wiring: read routes hold no queries (all DB access is in the tested library) and no route uses auth_tokens', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : n === 'route.ts' && files.push(p); } };
  walk(join(root, 'app/api'));
  const READ = ['app/api/hacks/route.ts', 'app/api/hacks/[hackId]/route.ts', 'app/api/hacks/[hackId]/comments/route.ts', 'app/api/users/[username]/route.ts', 'app/api/users/[username]/hacks/route.ts', 'app/api/users/[username]/card-data/route.ts'];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/auth_tokens/.test(src), `${f} references auth_tokens`);
    if (READ.some((r) => f.endsWith(r))) {
      assert.ok(!/\.from\(|\.select\(|createClient/.test(src), `${f} queries directly`);
      assert.ok(/@\/app\/lib\/public-reads/.test(src), `${f} does not use the tested library`);
    }
  }
});

test('retained POST stubs in read routes: executing the handler source makes no outbound call', async () => {
  const realFetch = globalThis.fetch; let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error('outbound'); }) as typeof fetch;
  try {
    for (const f of ['app/api/hacks/route.ts', 'app/api/hacks/[hackId]/comments/route.ts']) {
      const src = readFileSync(join(root, f), 'utf8');
      const m = src.match(/export async function POST\(\) \{[\s\S]*?\n\}/);
      assert.ok(m, `${f} POST stub not found`);
      // Evaluated with only globals in scope: it cannot reach a database client.
      const post = new Function(`${m![0].replace('export ', '')}; return POST;`)();
      const res: Response = await post();
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'temporarily_unavailable');
    }
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = realFetch; }
});
