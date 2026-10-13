#!/usr/bin/env node
// F2-B checks against the REAL local Supabase stack: content drafts and submission through PostgREST with real signed JWTs
// (including the TypeScript hash agreeing with the database hash), unauthorized access, the worker's lack of access, and
// GENUINE CONCURRENCY: two database sessions racing draft writes, child moves and freezes, with the invariant that every frozen
// version's stored hash equals the hash recomputed from its committed rows.
//
// Run through `npm run db:test:auth`, or directly with the stack up:  node --conditions=react-server scripts/local-f2b-checks.mjs
// Prints facts and PASS/FAIL only. Exit 0 all passed, 1 a check failed, 2 stack unreachable.
import { randomBytes, randomInt } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashHex } from '../src/modules/submissions/hashcanon.ts';
import { DB_CONTAINER, DOCKER, NETWORK, PUB, SECRET, confirmedSession, createRunner, decode, ok, psql, rpc } from './lib/local-stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, failed } = createRunner();
const api = (name, token, args) => rpc('api', name, token, args);
const owner = (sqlText) => psql(`set role hackass_owner;\n${sqlText}`).out;
const code = (r) => r.body?.code;
const msg = (r) => r.body?.message;
const expectErr = (r, status, c, m, what) => ok(r.status === status && code(r) === c && msg(r) === m, `${what}: got HTTP ${r.status} ${code(r)} ${msg(r)}, expected ${status} ${c} ${m}`);

const stamp = randomBytes(3).toString('hex');
owner(`insert into app.categories (slug, name) values ('f2b-${stamp}', 'F2B ${stamp}') on conflict do nothing;`);
const CAT = `f2b-${stamp}`;
const doc = (title = 'Keep herbs fresh', extra = {}) => ({
  category_slug: CAT, title, summary: 'Store cut herbs upright in water.', outcome: 'Crisp herbs for two weeks.', difficulty: 'easy',
  time_min_minutes: 5, time_max_minutes: 10, cost_min_cents: 0, cost_max_cents: 250, currency: 'USD', estimate_basis: 'three trials', ai_requirement: 'none',
  limitations: 'Basil dislikes the fridge.', steps: ['Trim the stems.', 'Stand in a jar.', 'Cover loosely.'],
  materials: [{ name: 'Glass jar', detail: 'any size' }, { name: 'Bag' }], requirements: [{ kind: 'tool', name: 'Scissors' }, { kind: 'skill', name: 'None' }],
  tags: ['kitchen', 'herbs'], attributions: [{ role: 'author', external_name: 'A. Cook' }], source_claims: [{ kind: 'original_work' }],
  assets: [{ asset_id: '30000000-0000-4000-8000-000000000001', sha256: 'ab'.repeat(32) }], ...extra,
});
const dbHash = (versionId) => owner(`select encode(app_content.version_hash('${versionId}'), 'hex');`).split('\n').pop();
const stored = (versionId) => owner(`select coalesce(encode(content_hash, 'hex'), '-') || ':' || (frozen_at is not null) from app.hack_versions where id = '${versionId}';`).split('\n').pop();
const mismatchCount = () => Number(owner(`select count(*) from app.hack_versions v where v.frozen_at is not null and v.content_hash is distinct from app_content.version_hash(v.id);`).split('\n').pop());

// ---- end to end through PostgREST with real tokens ------------------------------------------------------------------------
await check('B1', 'draft -> edit -> submit with real JWTs; the TypeScript hash equals the database hash; the frozen hash is the committed content', async () => {
  const { session } = await confirmedSession();
  const t = session.access_token;
  const created = await api('create_draft', t);
  ok(created.status === 200 && created.body.version_no === 1, `create_draft HTTP ${created.status}`);
  const vid = created.body.version_id;
  const d1 = doc();
  const s1 = await api('save_draft', t, { p_version_id: vid, p_content: d1 });
  ok(s1.status === 200, `save_draft HTTP ${s1.status} ${msg(s1)} ${JSON.stringify(s1.body?.details ?? s1.body?.detail)}`);
  const ts1 = await hashHex(d1);
  ok(s1.body.content_hash === ts1, `database hash ${s1.body.content_hash} != TypeScript hash ${ts1}`);
  const d2 = doc('Keep herbs fresh, edited');
  const s2 = await api('save_draft', t, { p_version_id: vid, p_content: d2 });
  ok(s2.status === 200 && s2.body.content_hash === await hashHex(d2) && s2.body.content_hash !== ts1, 'the edit changed the hash and TypeScript agrees');
  const got = await api('get_version', t, { p_version_id: vid });
  ok(got.status === 200 && got.body.state === 'draft' && got.body.content.title === 'Keep herbs fresh, edited' && got.body.computed_hash === s2.body.content_hash, 'get_version returns the draft and its hash');
  const wrong = await api('submit_version', t, { p_version_id: vid, p_expected_hash: ts1 });
  expectErr(wrong, 409, 'PT409', 'hash_mismatch', 'submit with a stale expected hash');
  const sub = await api('submit_version', t, { p_version_id: vid, p_expected_hash: await hashHex(d2) });
  ok(sub.status === 200 && sub.body.content_hash === await hashHex(d2), `submit HTTP ${sub.status} ${msg(sub)}`);
  ok(stored(vid) === `${await hashHex(d2)}:true`, `stored ${stored(vid)}`);
  ok(dbHash(vid) === await hashHex(d2), 'recomputed hash equals the stored hash');
  expectErr(await api('save_draft', t, { p_version_id: vid, p_content: doc('late') }), 409, 'PT409', 'version_frozen', 'edit after submission');
  expectErr(await api('delete_draft', t, { p_version_id: vid }), 409, 'PT409', 'version_frozen', 'delete after submission');
  const rev = await api('create_draft', t, { p_hack_id: created.body.hack_id });
  ok(rev.status === 200 && rev.body.version_no === 2, 'a revision is version 2');
  return `TypeScript == database == stored: ${ts1.slice(0, 12)}… then ${(await hashHex(d2)).slice(0, 12)}…; stale hash -> 409 hash_mismatch; edit/delete after submit -> 409 version_frozen`;
});

await check('B2', 'unauthorized access through direct JWT calls: other members, anon, service key and signed-out tokens cannot read, edit, submit or delete', async () => {
  const a = await confirmedSession();
  const b = await confirmedSession();
  const created = await api('create_draft', a.session.access_token);
  const vid = created.body.version_id;
  await api('save_draft', a.session.access_token, { p_version_id: vid, p_content: doc() });
  const tb = b.session.access_token;
  for (const [fn, args] of [['get_version', { p_version_id: vid }], ['save_draft', { p_version_id: vid, p_content: doc('hijack') }], ['submit_version', { p_version_id: vid, p_expected_hash: 'a'.repeat(64) }], ['delete_draft', { p_version_id: vid }], ['create_draft', { p_hack_id: created.body.hack_id }]]) {
    expectErr(await api(fn, tb, args), 404, 'PT404', 'not_found', `member B calling ${fn} on A's version`);
  }
  expectErr(await api('get_version', tb, { p_version_id: '99999999-9999-4999-8999-999999999999' }), 404, 'PT404', 'not_found', 'a missing version');
  for (const [who, key] of [['anon key', PUB], ['service key', SECRET]]) {
    const r = await api('get_version', key, { p_version_id: vid });
    ok((r.status === 401 || r.status === 403) && code(r) === '42501', `${who}: HTTP ${r.status} ${code(r)}`);
  }
  await a.c.auth.signOut();
  expectErr(await api('save_draft', a.session.access_token, { p_version_id: vid, p_content: doc('after signout') }), 403, '28000', 'session_invalid', "owner's signed-out (still unexpired) token");
  ok(owner(`select title from app.hack_versions where id = '${vid}';`).split('\n').pop() === 'Keep herbs fresh', 'none of that changed the draft');
  return 'member B/other: 404 not_found (identical to a missing id); anon/service: 401 42501; signed-out owner token: 403 session_invalid';
});

await check('B3', 'privileged or unknown fields cannot be smuggled into content; the draft is unchanged', async () => {
  const { session } = await confirmedSession();
  const t = session.access_token;
  const vid = (await api('create_draft', t)).body.version_id;
  await api('save_draft', t, { p_version_id: vid, p_content: doc() });
  const before = (await api('get_version', t, { p_version_id: vid })).body.computed_hash;
  for (const bad of [{ risk_class: 'low' }, { rights_clear: true }, { frozen_at: '2026-01-01T00:00:00Z' }, { content_hash: '00' }, { created_by: '00000000-0000-4000-8000-000000000009' }, { status: 'approved' }, { materials: [{ name: 'x', risk: 'none' }] }]) {
    expectErr(await api('save_draft', t, { p_version_id: vid, p_content: bad }), 422, 'PT422', 'invalid_content', `smuggling ${Object.keys(bad)[0]}`);
  }
  ok((await api('get_version', t, { p_version_id: vid })).body.computed_hash === before, 'content unchanged');
  return '7 smuggling attempts -> HTTP 422 PT422 invalid_content; hash unchanged';
});

// ---- the worker has no access to content --------------------------------------------------------------------------------------
const workerPw = randomBytes(18).toString('base64url');
psql(`alter role hackass_worker password '${workerPw}'`);
const image = spawnSync(DOCKER, ['inspect', DB_CONTAINER, '--format', '{{.Config.Image}}'], { encoding: 'utf8' }).stdout.trim();
function asWorker(sqlText) {
  const r = spawnSync(DOCKER, ['run', '--rm', '-i', '-e', `PGPASSWORD=${workerPw}`, '--network', NETWORK, image, 'psql', '-h', DB_CONTAINER, '-U', 'hackass_worker', '-d', 'postgres', '-v', 'ON_ERROR_STOP=0', '-At', '-X'], { input: sqlText, encoding: 'utf8', timeout: 90_000 });
  return { out: r.stdout.trim(), err: r.stderr.trim() };
}
await check('W3', 'the worker login has no access to any content table, content function or canonical-hash function', async () => {
  const tables = ['categories', 'hacks', 'hack_versions', 'version_lifecycle', 'submissions', 'hack_steps', 'hack_materials', 'hack_requirements', 'version_tags', 'version_attributions', 'source_claims', 'version_assets'];
  const stmts = [
    ...tables.map((t) => `select count(*) from app.${t};`),
    ...tables.map((t) => `delete from app.${t};`),
    `insert into app.hack_steps (version_id, position, body) values (gen_random_uuid(), 1, 'x');`,
    `select api.create_draft();`, `select api.list_my_versions();`, `select api.get_version(gen_random_uuid());`,
    `select app_content.canonical_text_json('{}'::jsonb);`, `select app_content.version_hash(gen_random_uuid());`, `select app_content.write_doc(gen_random_uuid(), '{}'::jsonb);`,
    `select app_content.freeze_version(gen_random_uuid(), gen_random_uuid(), null);`,
  ];
  const r = asWorker(['select \'health=\' || worker.healthcheck();', ...stmts].join('\n'));
  const errs = r.err.split('\n').filter((l) => /ERROR/.test(l));
  ok(r.out.split('\n').includes('health=ok'), `the worker could not call its own function: ${r.err.split('\n')[0]}`);
  ok(errs.length === stmts.length && errs.every((e) => /permission denied/i.test(e)), `expected ${stmts.length} permission refusals, got ${errs.length}: ${errs.slice(0, 3).map((e) => e.slice(0, 80)).join(' | ')}`);
  return `${stmts.length} statements (12 tables read, 12 tables delete, insert, 3 api functions, 5 app_content functions) all refused with permission denied; worker.healthcheck() still works`;
});

// ---- concurrency: two real database sessions ------------------------------------------------------------------------------------
/** Run a psql script in its own database session (a separate docker exec), after a delay. Resolves { out, err, ms, startedAt }. */
function session(script, delayMs = 0) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const t0 = Date.now();
      const p = spawn(DOCKER, ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-X', '-v', 'ON_ERROR_STOP=0'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
      p.on('close', () => resolve({ out: out.trim(), err: err.trim(), ms: Date.now() - t0 }));
      p.stdin.end(script);
    }, delayMs);
  });
}
const asMember = (claims, body) => `select set_config('request.jwt.claims', '${JSON.stringify(claims).replace(/'/g, "''")}', false);\nset role authenticated;\n${body}\nreset role;`;
const asOwner = (body) => `set role hackass_owner;\n${body}\nreset role;`;

/** A fresh member with a complete saved draft; returns ids, claims and the token. */
async function draftFor(title) {
  const { session: s, userId } = await confirmedSession();
  const t = s.access_token;
  const created = await api('create_draft', t);
  const d = doc(title);
  const saved = await api('save_draft', t, { p_version_id: created.body.version_id, p_content: d });
  ok(saved.status === 200, `fixture save_draft HTTP ${saved.status}`);
  return { t, userId, claims: decode(t).claims, versionId: created.body.version_id, hackId: created.body.hack_id, doc: d, hash: saved.body.content_hash };
}
const withTag = (d, tag) => ({ ...d, tags: [...d.tags, tag] });
const HOLD = 3000, LATE = 1000;

await check('C1', 'concurrent child write vs submit: the submit waits for the in-flight child write, then hashes exactly the committed content', async () => {
  const f = await draftFor('C1 child write vs submit');
  // S1 inserts a tag directly and holds its transaction open; S2 submits with the hash of the content WITHOUT that tag
  const s1 = session(asOwner(`begin;\ninsert into app.version_tags (version_id, slug) values ('${f.versionId}', 'c1-late');\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
  const s2 = session(asMember(f.claims, `select api.submit_version('${f.versionId}', '${f.hash}');`), LATE);
  const [, r2] = await Promise.all([s1, s2]);
  ok(r2.ms >= HOLD - LATE - 400, `the submit did not wait for the child write (took ${r2.ms} ms)`);
  ok(/hash_mismatch/.test(r2.err), `expected hash_mismatch, got: ${r2.err.split('\n')[0]} ${r2.out.slice(0, 80)}`);
  ok(stored(f.versionId).endsWith(':false'), 'the version must remain an unfrozen draft');
  ok(owner(`select count(*) from app.version_tags where version_id = '${f.versionId}' and slug = 'c1-late';`).split('\n').pop() === '1', 'the committed child is present');
  // now the client knows the new content: submitting its hash succeeds and covers the new child
  const want = await hashHex(withTag(f.doc, 'c1-late'));
  const ok2 = await session(asMember(f.claims, `select api.submit_version('${f.versionId}', '${want}');`));
  ok(/"content_hash"/.test(ok2.out), `submit with the new hash failed: ${ok2.err.split('\n')[0]}`);
  ok(stored(f.versionId) === `${want}:true` && dbHash(f.versionId) === want, 'stored hash == hash of the committed content including the late child == recomputed hash');
  return `S2 waited ${r2.ms} ms; stale-hash submit -> hash_mismatch; fresh-hash submit froze content incl. the child; stored == recomputed`;
});

await check('C2', 'concurrent submit vs child write: a child write that races the freeze is rejected once the freeze commits (and cannot change the hash)', async () => {
  const f = await draftFor('C2 submit vs child write');
  const s1 = session(asOwner(`begin;\nselect app_content.freeze_version('${f.versionId}', '${f.userId}', decode('${f.hash}', 'hex'));\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
  const s2 = session(asOwner(`insert into app.version_tags (version_id, slug) values ('${f.versionId}', 'c2-late');`), LATE);
  const [, r2] = await Promise.all([s1, s2]);
  ok(r2.ms >= HOLD - LATE - 400, `the child write did not wait for the freeze (took ${r2.ms} ms)`);
  ok(/version_frozen/.test(r2.err), `expected version_frozen, got: ${r2.err.split('\n')[0]}`);
  ok(owner(`select count(*) from app.version_tags where version_id = '${f.versionId}' and slug = 'c2-late';`).split('\n').pop() === '0', 'the late child must not exist');
  ok(stored(f.versionId) === `${f.hash}:true` && dbHash(f.versionId) === f.hash, 'stored hash == recomputed hash');
  return `the child INSERT waited ${r2.ms} ms for the freeze, then failed with version_frozen; stored == recomputed`;
});

await check('C3', 'concurrent draft save vs submit (both through the API): serialized on the version row, hash always matches the committed draft', async () => {
  const f = await draftFor('C3 save vs submit');
  const d2 = doc('C3 saved while submitting');
  const s1 = session(asMember(f.claims, `begin;\nselect api.save_draft('${f.versionId}', '${JSON.stringify(d2).replace(/'/g, "''")}'::jsonb);\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
  const s2 = session(asMember(f.claims, `select api.submit_version('${f.versionId}', '${f.hash}');`), LATE);
  const [, r2] = await Promise.all([s1, s2]);
  ok(r2.ms >= HOLD - LATE - 400 && /hash_mismatch/.test(r2.err), `submit should have waited and then reported hash_mismatch (took ${r2.ms} ms): ${r2.err.split('\n')[0]}`);
  const h2 = await hashHex(d2);
  ok(dbHash(f.versionId) === h2, 'the committed draft is the edited one');
  const sub = await session(asMember(f.claims, `select api.submit_version('${f.versionId}', '${h2}');`));
  ok(/"content_hash"/.test(sub.out) && stored(f.versionId) === `${h2}:true`, 'submitting the edited content succeeds');
  // the reverse race: submit holds the lock, the edit must be refused
  const g = await draftFor('C3 reverse');
  const s3 = session(asMember(g.claims, `begin;\nselect api.submit_version('${g.versionId}', '${g.hash}');\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
  const s4 = session(asMember(g.claims, `select api.save_draft('${g.versionId}', '${JSON.stringify(doc('too late')).replace(/'/g, "''")}'::jsonb);`), LATE);
  const [, r4] = await Promise.all([s3, s4]);
  ok(r4.ms >= HOLD - LATE - 400 && /version_frozen/.test(r4.err), `late edit should wait then fail with version_frozen (took ${r4.ms} ms): ${r4.err.split('\n')[0]}`);
  ok(stored(g.versionId) === `${g.hash}:true` && dbHash(g.versionId) === g.hash && owner(`select title from app.hack_versions where id = '${g.versionId}';`).split('\n').pop() === 'C3 reverse', 'frozen content is exactly what was submitted');
  return `edit-then-submit: waited ${r2.ms} ms -> hash_mismatch, resubmit ok; submit-then-edit: edit waited ${r4.ms} ms -> version_frozen`;
});

await check('C4', 'child moves between versions: both parents are locked and judged; a move racing a freeze of either side is serialized', async () => {
  const a = await draftFor('C4 source');
  const b = await draftFor('C4 target');
  owner(`insert into app.version_tags (version_id, slug) values ('${a.versionId}', 'c4-move');`);
  // S1 moves the tag A -> B and holds; S2 freezes the SOURCE (A). A's hash must not contain the tag.
  const s1 = session(asOwner(`begin;\nupdate app.version_tags set version_id = '${b.versionId}' where version_id = '${a.versionId}' and slug = 'c4-move';\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
  const wantA = await hashHex(a.doc); // tag removed again => original content
  const s2 = session(asOwner(`select app_content.freeze_version('${a.versionId}', '${a.userId}', decode('${wantA}', 'hex'));`), LATE);
  const [, r2] = await Promise.all([s1, s2]);
  ok(r2.ms >= HOLD - LATE - 400, `the freeze of the source did not wait for the move (took ${r2.ms} ms)`);
  ok(/content_hash/.test(r2.out), `freeze of A after the move failed: ${r2.err.split('\n')[0]}`);
  ok(stored(a.versionId) === `${wantA}:true` && dbHash(a.versionId) === wantA, 'A froze WITHOUT the moved tag; stored == recomputed');
  ok(owner(`select count(*) from app.version_tags where version_id = '${b.versionId}' and slug = 'c4-move';`).split('\n').pop() === '1', 'the tag lives in B');
  // freeze the TARGET (B) while a move INTO it is in flight
  const c = await draftFor('C4 source 2');
  owner(`insert into app.version_tags (version_id, slug) values ('${c.versionId}', 'c4-move2');`);
  const s3 = session(asOwner(`begin;\nupdate app.version_tags set version_id = '${b.versionId}' where version_id = '${c.versionId}' and slug = 'c4-move2';\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
  const wantB = await hashHex(withTag(withTag(b.doc, 'c4-move'), 'c4-move2'));
  const s4 = session(asOwner(`select app_content.freeze_version('${b.versionId}', '${b.userId}', decode('${wantB}', 'hex'));`), LATE);
  const [, r4] = await Promise.all([s3, s4]);
  ok(/content_hash/.test(r4.out), `freeze of B after the move-in failed: ${r4.err.split('\n')[0]} ${r4.out.slice(0, 60)}`);
  ok(stored(b.versionId) === `${wantB}:true` && dbHash(b.versionId) === wantB, 'B froze WITH both moved tags; stored == recomputed');
  // a move racing a freeze that wins: the move is rejected, in both directions
  const d = await draftFor('C4 d');
  owner(`insert into app.version_tags (version_id, slug) values ('${d.versionId}', 'c4-stay');`);
  const e = await draftFor('C4 e');
  const dHash = await hashHex(withTag(d.doc, 'c4-stay'));
  const s5 = session(asOwner(`begin;\nselect app_content.freeze_version('${d.versionId}', '${d.userId}', decode('${dHash}', 'hex'));\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
  const s6 = session(asOwner(`update app.version_tags set version_id = '${e.versionId}' where version_id = '${d.versionId}' and slug = 'c4-stay';`), LATE);
  const [, r6] = await Promise.all([s5, s6]);
  ok(/version_frozen/.test(r6.err) && r6.ms >= HOLD - LATE - 400, `a move out of a version being frozen must wait and fail (took ${r6.ms} ms): ${r6.err.split('\n')[0]}`);
  ok(stored(d.versionId) === `${dHash}:true` && dbHash(d.versionId) === dHash, 'the frozen source kept its child and its hash');
  return `move vs freeze(source): waited ${r2.ms} ms, A hash excludes the tag; move vs freeze(target): B includes both; freeze vs move-out: move waited ${r6.ms} ms then version_frozen; all stored == recomputed`;
});

await check('C5', 'opposite child moves between two drafts at the same time do not deadlock (consistent lock order)', async () => {
  const a = await draftFor('C5 a');
  const b = await draftFor('C5 b');
  owner(`insert into app.version_tags (version_id, slug) values ('${a.versionId}', 'c5-a'), ('${b.versionId}', 'c5-b');`);
  const s1 = session(asOwner(`begin;\nupdate app.version_tags set version_id = '${b.versionId}' where version_id = '${a.versionId}' and slug = 'c5-a';\nselect pg_sleep(1.5);\nupdate app.version_tags set slug = 'c5-a2' where version_id = '${b.versionId}' and slug = 'c5-a';\ncommit;`));
  const s2 = session(asOwner(`begin;\nupdate app.version_tags set version_id = '${a.versionId}' where version_id = '${b.versionId}' and slug = 'c5-b';\nselect pg_sleep(1.5);\nupdate app.version_tags set slug = 'c5-b2' where version_id = '${a.versionId}' and slug = 'c5-b';\ncommit;`), 300);
  const [r1, r2] = await Promise.all([s1, s2]);
  ok(!/deadlock/i.test(r1.err + r2.err), `deadlock detected: ${(r1.err + r2.err).split('\n')[0]}`);
  ok(!/ERROR/.test(r1.err + r2.err), `unexpected error: ${(r1.err + r2.err).split('\n')[0]}`);
  const rows = owner(`select string_agg(version_id::text || ':' || slug, ',' order by slug) from app.version_tags where version_id in ('${a.versionId}', '${b.versionId}') and slug in ('c5-a2', 'c5-b2');`).split('\n').pop();
  ok(rows === `${b.versionId}:c5-a2,${a.versionId}:c5-b2`, `final rows ${rows}`);
  return `both transactions completed in ${r1.ms}/${r2.ms} ms with no deadlock; the tags swapped parents`;
});

await check('C6', 'randomized races (36 rounds): every frozen version always hashes to its stored hash; only the expected errors occur', async () => {
  const unexpected = [];
  let waited = 0, ok2 = 0;
  for (let i = 0; i < 36; i++) {
    const f = await draftFor(`C6 round ${i}`);
    const g = await draftFor(`C6 round ${i} other`);
    const kind = randomInt(0, 4);
    const delay = randomInt(0, 700), hold = randomInt(300, 1200);
    const tag = `c6-${i}`;
    let a, b;
    if (kind === 0) { // child insert vs submit
      a = session(asOwner(`begin;\ninsert into app.version_tags (version_id, slug) values ('${f.versionId}', '${tag}');\nselect pg_sleep(${hold / 1000});\ncommit;`));
      b = session(asMember(f.claims, `select api.submit_version('${f.versionId}', '${f.hash}');`), delay);
    } else if (kind === 1) { // save vs submit
      a = session(asMember(f.claims, `begin;\nselect api.save_draft('${f.versionId}', '${JSON.stringify(doc(`C6 saved ${i}`)).replace(/'/g, "''")}'::jsonb);\nselect pg_sleep(${hold / 1000});\ncommit;`));
      b = session(asMember(f.claims, `select api.submit_version('${f.versionId}', '${f.hash}');`), delay);
    } else if (kind === 2) { // move vs freeze
      owner(`insert into app.version_tags (version_id, slug) values ('${f.versionId}', '${tag}');`);
      a = session(asOwner(`begin;\nupdate app.version_tags set version_id = '${g.versionId}' where version_id = '${f.versionId}' and slug = '${tag}';\nselect pg_sleep(${hold / 1000});\ncommit;`));
      b = session(asOwner(`select app_content.freeze_version('${g.versionId}', '${g.userId}', decode('${g.hash}', 'hex'));`), delay);
    } else { // freeze both sides while moves happen in opposite directions
      owner(`insert into app.version_tags (version_id, slug) values ('${f.versionId}', '${tag}a'), ('${g.versionId}', '${tag}b');`);
      a = session(asOwner(`begin;\nupdate app.version_tags set version_id = '${g.versionId}' where version_id = '${f.versionId}' and slug = '${tag}a';\nselect pg_sleep(${hold / 1000});\ncommit;`));
      b = session(asOwner(`update app.version_tags set version_id = '${f.versionId}' where version_id = '${g.versionId}' and slug = '${tag}b';\nselect app_content.freeze_version('${f.versionId}', '${f.userId}', decode('${f.hash}', 'hex'));`), delay);
    }
    const [ra, rb] = await Promise.all([a, b]);
    for (const e of (ra.err + '\n' + rb.err).split('\n').filter((l) => /ERROR/.test(l))) {
      // "current transaction is aborted" is the harmless echo of an expected error earlier in the same session
      if (!/hash_mismatch|version_frozen|current transaction is aborted/.test(e) || /deadlock/.test(e)) unexpected.push(`round ${i} kind ${kind}: ${e.slice(0, 120)}`);
    }
    if (rb.ms > 600 + delay) waited++;
    if (/content_hash/.test(ra.out + rb.out)) ok2++;
    const bad = mismatchCount();
    if (bad !== 0) unexpected.push(`round ${i} kind ${kind}: ${bad} frozen version(s) with stored hash != recomputed hash`);
  }
  ok(unexpected.length === 0, unexpected.slice(0, 4).join(' | '));
  ok(mismatchCount() === 0, 'final invariant');
  return `36 rounds x 2 sessions, no deadlock, no unexpected error, no stored/recomputed mismatch (${waited} rounds had a blocked session, ${ok2} freezes succeeded)`;
});

await check('C7', 'global invariant over everything created in this run: stored hash == recomputed hash for every frozen version, every submission carries its version\'s hash', async () => {
  ok(mismatchCount() === 0, 'a frozen version has a stored hash different from its recomputed hash');
  const badSubmissions = Number(owner(`select count(*) from app.submissions s join app.hack_versions v on v.id = s.version_id where s.content_hash is distinct from v.content_hash or v.frozen_at is null;`).split('\n').pop());
  ok(badSubmissions === 0, `${badSubmissions} submission(s) disagree with their version`);
  const frozen = Number(owner(`select count(*) from app.hack_versions where frozen_at is not null;`).split('\n').pop());
  ok(frozen > 0, 'no frozen versions to check');
  return `${frozen} frozen versions, stored == recomputed for all; every submission row carries its version's hash`;
});

await check('R2', 'F2-B rollback script: removes every content table, function and schema, leaves F2-A intact (rehearsed in a rolled-back transaction)', async () => {
  const down = readFileSync(path.join(root, 'supabase/rollbacks/20261014090000_f2b_down.sql'), 'utf8');
  const probe = `
select 'content_tables=' || count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r' and c.relname not in ('accounts', 'staff_assignments');
select 'app_content=' || count(*) from pg_namespace where nspname = 'app_content';
select 'api_functions=' || string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api';
select 'ledger=' || count(*) from supabase_migrations.schema_migrations where version like '2026101409%';
select 'f2a=' || (to_regclass('app.accounts') is not null) || ',' || (to_regclass('app.staff_assignments') is not null) || ',' || (to_regprocedure('app_guard.require_member()') is not null) || ',' || (select count(*) from pg_roles where rolname in ('hackass_owner', 'hackass_worker'));
`;
  const before = psql(probe).out.replace(/\n/g, ' ');
  ok(/content_tables=12 app_content=1 api_functions=create_draft,delete_draft,get_version,list_my_versions,save_draft,staff_probe,submit_version,whoami ledger=4 f2a=true,true,true,2/.test(before), `before: ${before}`);
  const after = psql(down.replace(/^commit;\s*$/m, `${probe}\nrollback;`)).out.replace(/\n/g, ' ');
  ok(/content_tables=0 app_content=0 api_functions=staff_probe,whoami ledger=0 f2a=true,true,true,2/.test(after), `after rollback: ${after}`);
  const restored = psql(probe).out.replace(/\n/g, ' ');
  ok(restored === before, `the rehearsal must leave the database unchanged: ${restored}`);
  return 'after the rollback script: 0 content tables, no app_content schema, only whoami/staff_probe in api, F2-A intact; transaction rolled back, state restored';
});

const n = failed();
console.log(`\nF2-B content checks: ${n === 0 ? 'all passed' : `${n} FAILED`}`);
console.log('NOT run here (hosted only): the same checks against the hosted project and pooler.');
process.exit(n ? 1 : 0);
