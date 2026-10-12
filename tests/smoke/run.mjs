// Local public-page smoke check. Builds the app against the local fixture server (NEXT_PUBLIC_* values are
// inlined at build time, so the build must see the fixture URL), then starts it. Dummy keys only; no calls to
// any real service. Run: node tests/smoke/run.mjs  (takes ~1 minute; rebuilds .next)
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFake, IDS } from './fake-postgrest.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fake = await startFake();
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const env = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${fake.port}`, SUPABASE_URL: `http://127.0.0.1:${fake.port}`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'dummy-anon', SUPABASE_SERVICE_KEY: 'dummy-service', SUPABASE_SERVICE_ROLE_KEY: 'dummy-service' };
const build = spawnSync(process.execPath, ['node_modules/next/dist/bin/next', 'build'], { cwd: root, env, encoding: 'utf8' });
if (build.status !== 0) { console.log(build.stdout.slice(-1500), build.stderr.slice(-1500)); await fake.close(); process.exit(2); }
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let appLog = ''; app.stdout.on('data', (d) => (appLog += d)); app.stderr.on('data', (d) => (appLog += d));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) { try { const r = await fetch(`${base}/api/hacks`); if (r.status < 500) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

const results = []; let failed = 0;
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const get = async (p, init) => { const r = await fetch(base + p, init); const t = await r.text(); return { status: r.status, text: t, json: () => JSON.parse(t) }; };
const PRIVATE = ['Real Name PRIVATE', 'Bio PRIVATE', 'private.test', 'private.example', 'HASH-PRIVATE', 'INTERNAL-NOTE-PRIVATE', 'TOKEN-PRIVATE', 'COMMENT-ON-UNPUBLISHED'];
const leaks = (t) => PRIVATE.filter((s) => t.includes(s));

// --- API reads
let r = await get('/api/hacks'); let j = r.json();
check('GET /api/hacks: 200, approved only', r.status === 200 && j.hacks.length === 2 && j.hacks.every((h) => [IDS.approved1, IDS.approved2].includes(h.id)));
check('GET /api/hacks: no private fields/values', leaks(r.text).length === 0 && !/"status"|"created_by"|"user_id"/.test(r.text), leaks(r.text).join());
r = await get(`/api/hacks/${IDS.approved1}`); j = r.json();
check('GET hack approved: 200, author attributed by username only', r.status === 200 && j.users.username === 'alice' && !('real_name' in j.users) && !('bio' in j.users) && leaks(r.text).length === 0);
const nf = [];
for (const id of [IDS.pending, IDS.rejected, IDS.missing, 'not-a-uuid']) { const x = await get(`/api/hacks/${id}`); nf.push(`${x.status}|${x.text}`); }
check('GET hack pending/rejected/missing/malformed: identical 404', new Set(nf).size === 1 && nf[0].startsWith('404|'), nf[0]);
r = await get(`/api/hacks/${IDS.approved1}/comments`); j = r.json();
check('GET comments approved: 200, newest first', r.status === 200 && j.data.map((c) => c.content).join() === 'second,first' && leaks(r.text).length === 0);
const nfc = await get(`/api/hacks/${IDS.pending}/comments`);
check('GET comments on pending hack: 404, same body as hack not found', nfc.status === 404 && nfc.text === nf[0].split('|').slice(1).join('|') && !nfc.text.includes('COMMENT-ON-UNPUBLISHED'));
for (const q of ['limit=abc', 'limit=0', 'limit=-1', 'offset=10001', 'limit=99999999999']) { const x = await get(`/api/hacks/${IDS.approved1}/comments?${q}`); check(`GET comments ?${q}: 400`, x.status === 400); }
r = await get(`/api/hacks/${IDS.approved1}/comments?limit=500`); check('GET comments ?limit=500: capped to 50', r.status === 200 && r.json().meta.limit === 50);
r = await get('/api/users/alice'); check('GET profile: no email/real_name/bio/website', r.status === 200 && leaks(r.text).length === 0 && !/"email"|"real_name"|"bio"|"website_url"/.test(r.text));
r = await get('/api/users/alice/hacks?tab=bookmarks'); check('GET user hacks ?tab=bookmarks: empty, nothing private', r.status === 200 && r.json().data.length === 0 && leaks(r.text).length === 0);
r = await get('/api/users/alice/hacks'); check('GET user hacks: approved only', r.status === 200 && r.json().data.every((h) => h.id !== IDS.pending && h.id !== IDS.rejected) && leaks(r.text).length === 0);
r = await get('/api/users/alice/card-data', { headers: { authorization: 'Bearer TOKEN-PRIVATE' } }); j = r.json();
check('GET card-data: follow_state unavailable, isFollowing absent, no bio', r.status === 200 && j.follow_state === 'unavailable' && !('isFollowing' in j) && !('bio' in j) && leaks(r.text).length === 0);
// --- disabled mutations
const muts = [['POST', '/api/auth/login', { email: 'demo@hackass.com', password: 'demo123' }], ['POST', '/api/auth/signup', { username: 'x', email: 'x@x', password: 'secret1' }], ['GET', '/api/admin/hacks'], ['POST', `/api/admin/hacks/${IDS.pending}/approve`, { approved: true }], ['POST', '/api/admin/extract-url', { url: `http://127.0.0.1:${fake.port}/ssrf` }], ['POST', '/api/hacks', { title: 't' }], ['POST', `/api/hacks/${IDS.approved1}/validate`, { worked: true }], ['POST', `/api/hacks/${IDS.approved1}/like`], ['POST', `/api/hacks/${IDS.approved1}/bookmark`], ['POST', `/api/hacks/${IDS.approved1}/comments`, { content: 'hi' }], ['POST', `/api/follow/${IDS.bob}`], ['DELETE', `/api/follow/${IDS.bob}`], ['PATCH', '/api/me/profile']];
const before = fake.log.length;
for (const [m, p, body] of muts) { const x = await get(p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer TOKEN-PRIVATE' }, body: body ? JSON.stringify(body) : undefined }); check(`${m} ${p.replace(/[0-9a-f-]{36}/g, ':id')}: 503, no token`, x.status === 503 && !/token/i.test(x.text.replace('temporarily_unavailable', '')), `status ${x.status}`); }
check('disabled mutations made zero fixture-database requests', fake.log.length === before, `${fake.log.length - before} requests`);
// --- pages
for (const [p, expect] of [['/', 200], ['/browse', 200], [`/hack/${IDS.approved1}`, 200], [`/hack/${IDS.pending}`, 404], [`/hack/${IDS.missing}`, 404], ['/profile/alice', 200], ['/profile/alice/archive', 200], ['/profile/nobody', 404]]) {
  const x = await get(p); check(`page ${p.replace(/[0-9a-f-]{36}/g, ':id')}: ${expect}`, x.status === expect, `got ${x.status}`);
  check(`page ${p.replace(/[0-9a-f-]{36}/g, ':id')}: no private strings in HTML/RSC payload`, leaks(x.text).length === 0, leaks(x.text).join());
}
const pg = await get(`/hack/${IDS.approved1}`); check('hack page renders fixture title and author username', pg.text.includes('Fixture hack 1') && pg.text.includes('alice'));
const prof = await get('/profile/alice'); check('profile page: follow control rendered as unavailable', /unavailable/i.test(prof.text) && !/>Following</.test(prof.text));
// --- image optimizer: non-allow-listed upstream must be refused, with no fetch of it
const imgBefore = fake.log.length;
const img = await get(`/_next/image?url=${encodeURIComponent(`http://127.0.0.1:${fake.port}/x.png`)}&w=64&q=75`);
check('image optimizer refuses non-allow-listed URL (400) and does not fetch it', img.status === 400 && fake.log.length === imgBefore, `status ${img.status}`);
// --- global fixture-database assertions
const writes = fake.log.filter((l) => l.method !== 'GET' && l.method !== 'HEAD');
const forbidden = fake.log.filter((l) => ['auth_tokens', 'bookmarks', 'archive', 'follows', 'likes'].includes(l.table));
const stars = fake.log.filter((l) => /select=\*/.test(l.query) && l.method === 'GET');
check('no write requests reached the fixture database', writes.length === 0, JSON.stringify(writes));
check('no query touched auth_tokens/bookmarks/archive/follows/likes', forbidden.length === 0, forbidden.map((l) => l.table).join());
check("no query used select=*", stars.length === 0, stars.map((l) => l.table).join());
console.log(`\nfixture-database requests: ${fake.log.length}; tables: ${[...new Set(fake.log.map((l) => l.table))].join(', ')}`);

app.kill('SIGTERM'); await fake.close();
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log('--- app log tail ---\n' + appLog.slice(-1500)); process.exit(1); }
