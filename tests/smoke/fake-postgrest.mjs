// Minimal in-process PostgREST emulator with controlled fixtures, for local smoke tests only.
// Honors select projection, eq./in./lt. filters, order, limit/offset, HEAD+count, and the
// single-object Accept header. Logs every request so tests can prove which tables were touched.
import http from 'node:http';

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const IDS = { approved1: ID(1), approved2: ID(4), pending: ID(2), rejected: ID(3), missing: ID(99), alice: ID(101), bob: ID(102) };

const hack = (id, status, n, extra = {}) => ({
  id, title: `Fixture hack ${n}`, description: 'desc', category: 'Food', difficulty: 'easy', why_it_works: 'because',
  content_type: 'link', content_url: 'https://example.com/x', content_thumbnail: null, source_attribution: null,
  source_platform: null, worked_votes: 3, failed_votes: 1, unique_users_who_validated: 4, view_count: 0, share_count: 0,
  like_count: 0, bookmark_count: 0, hack_score: 1, created_at: `2026-01-0${n}T00:00:00Z`, user_id: IDS.alice,
  status, created_by: 'admin', updated_at: '2026-02-01', internal_notes: 'INTERNAL-NOTE-PRIVATE', ...extra,
});
const user = (id, name) => ({
  id, username: name, email: `${name}@private.test`, password_hash: 'HASH-PRIVATE', real_name: 'Real Name PRIVATE',
  bio: 'Bio PRIVATE', website_url: 'https://private.example', avatar: null, profile_image_url: null,
  profile_image_small_url: null, is_verified: false, followers_count: 2, following_count: 1,
});
export const tables = () => ({
  hacks: [hack(IDS.approved1, 'approved', 1), hack(IDS.approved2, 'approved', 4), hack(IDS.pending, 'pending', 2), hack(IDS.rejected, 'rejected', 3)],
  users: [user(IDS.alice, 'alice'), user(IDS.bob, 'bob')],
  comments: [
    { id: ID(501), hack_id: IDS.approved1, user_id: IDS.alice, content: 'first', created_at: '2026-03-01T00:00:00Z' },
    { id: ID(502), hack_id: IDS.approved1, user_id: IDS.bob, content: 'second', created_at: '2026-03-02T00:00:00Z' },
    { id: ID(503), hack_id: IDS.pending, user_id: IDS.alice, content: 'COMMENT-ON-UNPUBLISHED', created_at: '2026-03-03T00:00:00Z' },
  ],
  bookmarks: [{ id: 'b1', user_id: IDS.alice, hack_id: IDS.pending, created_at: '2026-03-01' }],
  archive: [{ id: 'a1', user_id: IDS.alice, hack_id: IDS.pending, created_at: '2026-03-01' }],
  user_stats: [{ id: IDS.alice, username: 'alice', followers: 2, following: 1, hacks_count: 2 }],
  auth_tokens: [{ token: 'TOKEN-PRIVATE', user_id: IDS.alice }], follows: [], likes: [],
});

export function startFake() {
  const data = tables();
  const log = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const m = u.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    log.push({ method: req.method, table: m ? m[1] : u.pathname, query: u.search });
    if (!m || !data[m[1]]) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"message":"not found"}'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('{"message":"writes not allowed in smoke fixture"}'); }
    let rows = [...data[m[1]]];
    let select = '*', limit = Infinity, offset = 0; const orders = [];
    for (const [k, v] of u.searchParams) {
      if (k === 'select') select = v;
      else if (k === 'limit') limit = Number(v);
      else if (k === 'offset') offset = Number(v);
      else if (k === 'order') for (const part of v.split(',')) { const [c, d] = part.split('.'); orders.push([c, d !== 'asc']); }
      else if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === v.slice(3));
      else if (v.startsWith('lt.')) rows = rows.filter((r) => String(r[k]) < v.slice(3));
      else if (v.startsWith('in.(')) { const set = v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, '')); rows = rows.filter((r) => set.includes(String(r[k]))); }
    }
    const total = rows.length;
    rows.sort((a, b) => { for (const [c, desc] of orders) { const x = String(a[c]), y = String(b[c]); if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1); } return 0; });
    rows = rows.slice(offset, offset + limit);
    if (select !== '*') { const cols = select.split(',').map((c) => c.trim()); rows = rows.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]]))); }
    const headers = { 'content-type': 'application/json', 'content-range': `${rows.length ? `${offset}-${offset + rows.length - 1}` : '*'}/${total}` };
    if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
    if ((req.headers.accept || '').includes('vnd.pgrst.object')) {
      if (rows.length !== 1) { res.writeHead(406, headers); return res.end(JSON.stringify({ code: 'PGRST116', details: `The result contains ${rows.length} rows`, hint: null, message: 'Cannot coerce the result to a single JSON object' })); }
      res.writeHead(200, headers); return res.end(JSON.stringify(rows[0]));
    }
    res.writeHead(200, headers); res.end(JSON.stringify(rows));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, port: server.address().port, close: () => new Promise((r) => server.close(r)) })));
}
