#!/usr/bin/env node
// F2-E checks against the REAL local Supabase stack: the two public catalog reads through PostgREST with the anonymous key, a member's and a staff member's real
// signed JWTs (same content for all three), the exact response allowlist and a leak scan, hidden/visible lifecycle through the real staff RPCs, replacement and
// withdrawal, API pagination, the absence of any table or private-function access, reads that change nothing, GENUINE CONCURRENCY (reads racing a publication
// replacement and a withdrawal: every response is one coherent version, a hack never appears twice), and a COMMITTED rollback followed by re-application.
// Run through `npm run db:test:auth`, or with the stack up:  node --conditions=react-server scripts/local-f2e-checks.mjs
// Prints facts and PASS/FAIL only. Exit 0 all passed, 1 a check failed, 2 stack unreachable.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, PUB, SECRET, SUPABASE, confirmedSession, createRunner, decode, elevateToAal2, ok, psql, rpc, session } from './lib/local-stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, failed } = createRunner();
const api = (name, token, args) => rpc('api', name, token, args);
const msg = (r) => r.body?.message;
const owner = (sqlText) => psql(`set role hackass_owner;\n${sqlText}`).out;
const last = (t) => t.split('\n').pop();
const stamp = randomBytes(3).toString('hex');
let n = 0;
const slug = () => `f2e-${stamp}-${++n}`;
owner(`insert into app.categories (slug, name) values ('f2e-${stamp}', 'F2E ${stamp}') on conflict do nothing;`);
const doc = (title, extra = {}) => ({
  category_slug: `f2e-${stamp}`, title, summary: `Summary of ${title}.`, outcome: 'Crisp herbs for two weeks.', difficulty: 'easy', steps: [`Step for ${title}.`],
  attributions: [{ role: 'author', external_name: 'A. Cook', external_url: 'https://example.test/cook' }], source_claims: [{ kind: 'original_work' }], ...extra,
});
const richExtra = {
  time_min_minutes: 5, time_max_minutes: 15, cost_min_cents: 0, cost_max_cents: 500, currency: 'USD', estimate_basis: 'Measured once.', ai_requirement: 'helpful', limitations: 'Not for glass.',
  steps: ['Step one body.', 'Step two body.'], materials: [{ name: 'Jar', detail: 'Wide mouth' }, { name: 'Water' }],
  requirements: [{ kind: 'tool', name: 'Scissors', detail: 'Any' }, { kind: 'skill', name: 'Patience' }], tags: ['herbs', 'fridge'],
};

async function submission(title, { hackId = null, d = doc(title), member = null } = {}) {
  const m = member ?? await confirmedSession(); // a new version of a hack is created by the hack's own member
  const t = m.token ?? m.session.access_token;
  const created = await api('create_draft', t, hackId ? { p_hack_id: hackId } : {});
  ok(created.status === 200, `fixture create_draft: HTTP ${created.status} ${msg(created)}`);
  const saved = await api('save_draft', t, { p_version_id: created.body.version_id, p_content: d });
  ok(saved.status === 200, `fixture save_draft: HTTP ${saved.status} ${msg(saved)}`);
  const sub = hackId === 'draft-only' ? null : await api('submit_version', t, { p_version_id: created.body.version_id, p_expected_hash: saved.body.content_hash });
  return { ...m, token: t, hackId: created.body.hack_id, versionId: created.body.version_id, submissionId: sub?.body?.submission_id, hash: saved.body.content_hash, submitStatus: sub?.status };
}
async function draftOnly(title) {
  const m = await confirmedSession(); const t = m.session.access_token;
  const created = await api('create_draft', t, {}); const saved = await api('save_draft', t, { p_version_id: created.body.version_id, p_content: doc(title) });
  ok(created.status === 200 && saved.status === 200, 'fixture draft');
  return { hackId: created.body.hack_id };
}
async function staff(role = 'reviewer') {
  const m = await confirmedSession();
  owner(`insert into app.staff_assignments (user_id, role, granted_by) values ('${m.userId}', '${role}', 'check');`);
  const t2 = await elevateToAal2(m.c);
  return { ...m, token: t2, claims: decode(t2).claims };
}
const rev = (s, extra = {}) => ({ p_submission_id: s.submissionId, p_expected_hash: s.hash, ...extra });
const clearRights = (r, s) => api('record_rights_review', r.token, rev(s, { p_claim_no: 1, p_status: 'clear', p_basis_code: 'staff_original_check', p_evidence_note: 'EVIDENCE-NOTE-SECRET checked the original.', p_expires_on: null }));
const assess = (r, s) => api('record_risk_assessment', r.token, rev(s, { p_risk_class: 'low', p_rationale: 'RATIONALE-SECRET ordinary household tip.' }));
const decide = (r, s, decision) => api('record_decision', r.token, rev(s, { p_decision: decision, p_reason_codes: null, p_note: null, p_expected_prior_decision_id: null }));
const publish = (r, s, decisionId, sl = null) => api('publish_version', r.token, rev(s, { p_expected_decision_id: decisionId, p_slug: sl }));
const withdraw = (r, pubId) => api('withdraw_publication', r.token, { p_publication_id: pubId, p_reason_code: 'quality', p_note: null });
const approved = async (title, { reviewer = null, hackId = null, d = doc(title), member = null } = {}) => {
  const r = reviewer ?? await staff('reviewer');
  const s = await submission(title, { hackId, d, member });
  ok(s.submitStatus === 200, `fixture submit: HTTP ${s.submitStatus}`);
  ok((await api('start_review', r.token, rev(s))).status === 200 && (await assess(r, s)).status === 200 && (await clearRights(r, s)).status === 200, 'fixture review steps');
  const dd = await decide(r, s, 'PUBLISH');
  ok(dd.status === 200 && dd.body.state === 'approved', `fixture approval: HTTP ${dd.status} ${msg(dd)}`);
  return { r, s, d: dd.body.decision_id };
};
/** An approved AND published hack with a fresh slug. */
async function published(title, opts = {}) {
  const a = await approved(title, opts);
  const sl = opts.slug ?? slug();
  const p = await publish(a.r, a.s, a.d, sl);
  ok(p.status === 200, `fixture publish: HTTP ${p.status} ${msg(p)}`);
  return { ...a, slug: sl, pubId: p.body.publication_id };
}
const ANON = PUB;
const list = (token, args = {}) => api('list_public_hacks', token, args);
const detail = (token, s) => api('get_public_hack', token, { p_slug: s });
const slugsOf = (r) => (r.body?.items ?? []).map((i) => i.slug);
const counts = () => owner(`select (select count(*) from app.jobs) || '/' || (select count(*) from app.publications) || '/' || (select count(*) from app.publication_withdrawals) || '/' || (select count(*) from app.hacks);`).split('\n').pop();

const reviewer = await staff('reviewer');
const memberA = await confirmedSession();
const memberTok = memberA.session.access_token;

await check('E1', 'the same content for anonymous, a member and a staff member (real JWTs); the response holds EXACTLY the allowlisted fields and no private text', async () => {
  const h = await published('E1 rich', { reviewer, d: doc('E1 rich', richExtra) });
  const [a, m, s] = await Promise.all([detail(ANON, h.slug), detail(memberTok, h.slug), detail(reviewer.token, h.slug)]);
  ok(a.status === 200 && m.status === 200 && s.status === 200, `HTTP ${a.status}/${m.status}/${s.status} ${msg(a)}`);
  ok(JSON.stringify(a.body) === JSON.stringify(m.body) && JSON.stringify(a.body) === JSON.stringify(s.body), 'anon, member and staff details differ');
  const want = 'attributions,category,ai_requirement,cost,difficulty,estimate_basis,limitations,materials,outcome,published_at,requirements,slug,sources,steps,summary,tags,time_minutes,title,version_id'.split(',').sort().join(',');
  ok(Object.keys(a.body).sort().join(',') === want, `detail keys: ${Object.keys(a.body).sort().join(',')}`);
  ok(a.body.title === 'E1 rich' && a.body.version_id === h.s.versionId && a.body.steps.length === 2 && a.body.tags.join() === 'fridge,herbs', 'content is the published version');
  const text = JSON.stringify(a.body);
  for (const secret of ['EVIDENCE-NOTE-SECRET', 'RATIONALE-SECRET', h.s.hackId, h.pubId, h.s.submissionId, h.r.userId, h.s.userId, h.s.hash, 'snapshot', 'HACKASS-PUB-1', 'job', 'staff', 'permission_note']) ok(!text.includes(secret), `leaked: ${secret}`);
  const l = await list(ANON, { p_limit: 100 });
  const item = l.body.items.find((i) => i.slug === h.slug);
  ok(l.status === 200 && item, 'the published hack is in the list');
  ok(Object.keys(item).sort().join(',') === 'ai_requirement,category,cost,difficulty,published_at,slug,summary,time_minutes,title,version_id', `list item keys: ${Object.keys(item).sort().join(',')}`);
  const lm = await list(memberTok, { p_limit: 100 });
  ok(JSON.stringify(lm.body) === JSON.stringify(l.body), 'anon and member lists differ');
  return `detail keys ${Object.keys(a.body).length}, list item keys ${Object.keys(item).length}; anon = member = staff; 12 private strings absent`;
});

await check('E2', 'drafts, submitted-only and approved-not-published hacks are invisible; a missing slug and an ineligible slug give the SAME not_found', async () => {
  const d = await draftOnly('E2 draft');
  const sub = await submission('E2 submitted'); ok(sub.submitStatus === 200, 'fixture submitted');
  const appr = await approved('E2 approved', { reviewer });
  const l = await list(ANON, { p_limit: 100 });
  const text = JSON.stringify(l.body);
  for (const t of ['E2 draft', 'E2 submitted', 'E2 approved']) ok(!text.includes(t), `${t} is listed`);
  const attempts = [`s-${stamp}-missing`, 'Not A Slug!', '', `${d.hackId}`, `${appr.s.hackId}`];
  const outs = [];
  for (const sl of attempts) outs.push(await detail(ANON, sl));
  for (const o of outs) ok(o.status === 404 && o.body?.code === 'PT404' && o.body?.message === 'not_found', `HTTP ${o.status} ${JSON.stringify(o.body)}`);
  ok(new Set(outs.map((o) => JSON.stringify(o.body))).size === 1, 'the not_found bodies are not identical');
  return `${attempts.length} different misses -> the identical PT404 not_found body`;
});

await check('E3', 'withdrawal hides the hack from list and detail at once; a rights revocation (through the API) hides it with no worker; a replacement shows only the CURRENT version', async () => {
  const w = await published('E3 withdrawn', { reviewer });
  ok((await detail(ANON, w.slug)).status === 200, 'visible before');
  ok((await withdraw(reviewer, w.pubId)).status === 200, 'withdrawn');
  ok((await detail(ANON, w.slug)).status === 404 && !slugsOf(await list(ANON, { p_limit: 100 })).includes(w.slug), 'hidden after the withdrawal');
  const rv = await published('E3 revoked', { reviewer });
  const jobsBefore = last(owner(`select count(*) from app.jobs where status in ('running');`));
  const rr = await api('record_rights_review', reviewer.token, rev(rv.s, { p_claim_no: 1, p_status: 'revoked', p_basis_code: null, p_evidence_note: null, p_expires_on: null }));
  ok(rr.status === 200, `revoke: HTTP ${rr.status} ${msg(rr)}`);
  ok((await detail(ANON, rv.slug)).status === 404 && !slugsOf(await list(ANON, { p_limit: 100 })).includes(rv.slug), 'hidden after the revocation');
  ok(last(owner(`select count(*) from app.jobs where status in ('running');`)) === jobsBefore, 'no job was run by the reads or the revocation');
  const v1 = await published('E3 v1', { reviewer });
  const v2 = await approved('E3 v2', { reviewer, hackId: v1.s.hackId, member: v1.s });
  ok((await publish(v2.r, v2.s, v2.d, null)).status === 200, 'replacement published');
  const d = await detail(ANON, v1.slug);
  ok(d.status === 200 && d.body.title === 'E3 v2' && d.body.version_id === v2.s.versionId, `detail after replacement: ${d.body?.title}`);
  const l = await list(ANON, { p_limit: 100 });
  ok(l.body.items.filter((i) => i.slug === v1.slug).length === 1 && l.body.items.find((i) => i.slug === v1.slug).title === 'E3 v2', 'the list holds the hack once, at the new version');
  ok(!JSON.stringify(l.body).includes(v1.s.versionId) && !JSON.stringify(d.body).includes(v1.s.versionId), 'the superseded version id is nowhere');
  return 'withdrawn, revoked and superseded content hidden immediately; replacement exposes v2 only';
});

await check('E4', 'tables, private functions and write paths are unreachable for anonymous and members (the only EXECUTE for anon is the two catalog reads)', async () => {
  const grants = last(owner(`select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app','app_guard','api','worker','app_bridge','app_content','app_review','app_budget') and has_function_privilege('anon', p.oid, 'execute'))
    || '/' || (select count(*) from pg_class c where c.relnamespace in ('app'::regnamespace) and c.relkind in ('r','v','m') and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update')))
    || '/' || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app','app_guard','app_bridge','app_content','app_review','app_budget','worker') and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')));`));
  ok(grants === '2/0/0', `anon functions / table grants / private function grants: ${grants}`);
  const rest = async (token, p, headers = {}) => (await fetch(`${API}/rest/v1/${p}`, { headers: { apikey: PUB, authorization: `Bearer ${token}`, 'accept-profile': 'app', ...headers } })).status;
  const priv = async (token, schema, fn, body) => (await fetch(`${API}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: PUB, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-profile': schema, 'accept-profile': schema }, body: JSON.stringify(body) })).status;
  const statuses = [];
  for (const t of [ANON, memberTok]) {
    for (const table of ['hacks', 'publications', 'hack_versions', 'jobs', 'ai_ledger']) { const s = await rest(t, table); ok(s !== 200, `${table} readable: HTTP ${s}`); statuses.push(s); }
    for (const [schema, fn] of [['app_review', 'public_blockers'], ['app_review', 'public_hack_json'], ['api', 'public_blockers']]) { const s = await priv(t, schema, fn, { p_publication_id: '00000000-0000-0000-0000-000000000000' }); ok(s !== 200, `${schema}.${fn}: HTTP ${s}`); statuses.push(s); }
  }
  const sk = await rest(SECRET, 'hacks'); ok(sk !== 200, `service key reads a table: ${sk}`);
  return `anon EXECUTE on 2 functions only; 0 table grants; 0 private-function grants; ${statuses.length + 1} direct accesses refused (${[...new Set([...statuses, sk])].join('/')})`;
});

await check('E5', 'API pagination: pages of 2 walk every eligible hack once in (published_at desc, slug desc); invalid cursors and sizes are refused; the cap is 100', async () => {
  const ps = [];
  for (let i = 0; i < 5; i++) ps.push((await published(`E5 page ${i}`, { reviewer })).slug);
  const all = slugsOf(await list(ANON, { p_limit: 100 }));
  const seen = []; let cursor = {}; let pages = 0; let sizes = new Set();
  for (; pages < 200; pages++) {
    const r = await list(ANON, { p_limit: 2, ...cursor });
    ok(r.status === 200, `page ${pages}: HTTP ${r.status} ${msg(r)}`);
    sizes.add(r.body.items.length); seen.push(...slugsOf(r));
    if (!r.body.next_cursor) break;
    cursor = { p_after_published_at: r.body.next_cursor.published_at, p_after_slug: r.body.next_cursor.slug };
  }
  ok(new Set(seen).size === seen.length, 'a hack came back twice');
  ok(seen.join() === all.join() || (all.length > 100 && seen.slice(0, 100).join() === all.join()), `walk differs from the one-page list (${seen.length} vs ${all.length})`);
  for (const sl of ps) ok(seen.includes(sl), `${sl} missing from the walk`);
  for (const [args, what] of [[{ p_limit: 0 }, 'limit 0'], [{ p_limit: -3 }, 'limit -3'], [{ p_difficulty: 'impossible' }, 'difficulty'], [{ p_after_slug: 'x' }, 'half a cursor'], [{ p_after_published_at: '2026-01-01T00:00:00Z' }, 'half a cursor 2'], [{ p_category: 'Not A Slug!' }, 'category']]) {
    const r = await list(ANON, args); ok(r.status === 422 && r.body?.code === 'PT422', `${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
  const big = await list(ANON, { p_limit: 1000 }); ok(big.status === 200 && big.body.page_size === 100 && big.body.items.length <= 100, `limit 1000: page_size ${big.body?.page_size}`);
  const def = await list(ANON, {}); ok(def.status === 200 && def.body.page_size === 25 && def.body.items.length <= 25, `default page_size ${def.body?.page_size}`);
  const unknownCat = await list(ANON, { p_category: 'no-such-category' }); ok(unknownCat.status === 200 && unknownCat.body.items.length === 0 && unknownCat.body.next_cursor === null, 'an unknown but well-formed category is an empty page');
  const cat = await list(ANON, { p_category: `f2e-${stamp}`, p_difficulty: 'easy', p_limit: 100 }); ok(cat.status === 200 && cat.body.items.length >= 5 && cat.body.items.every((i) => i.category.slug === `f2e-${stamp}`), 'category + difficulty filters');
  return `${seen.length} hacks over ${pages + 1} pages of 2, none twice, same order as one page; 6 invalid argument shapes -> PT422; limit 1000 -> page_size 100; default 25`;
});

await check('E6', 'reads change nothing: no job, publication, withdrawal or hack row is created or altered by a burst of list and detail reads (including reads of ineligible hacks)', async () => {
  const w = await published('E6 hidden', { reviewer });
  await withdraw(reviewer, w.pubId);
  const before = counts();
  const sums = () => last(owner(`select md5((select coalesce(string_agg(h::text, '|' order by h.id), '') from app.hacks h) || (select coalesce(string_agg(p::text, '|' order by p.id), '') from app.publications p) || (select coalesce(string_agg(j::text, '|' order by j.id), '') from app.jobs j));`));
  const s0 = sums();
  await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? list(ANON, { p_limit: 100 }) : detail(i % 2 ? ANON : memberTok, w.slug))));
  ok(counts() === before && sums() === s0, `state changed: ${before} -> ${counts()}`);
  return `30 reads (incl. an ineligible slug); rows jobs/publications/withdrawals/hacks ${before} unchanged, content checksum unchanged`;
});

// ---- concurrency: reads racing a replacement and a withdrawal -----------------------------------------------------------------------------------------
const readerScript = (sl, rounds) => `set role anon;\n${Array.from({ length: rounds }, () => `select 'D|' || api.get_public_hack('${sl}')::text;\nselect 'L|' || (api.list_public_hacks(100, '${`f2e-${stamp}`}', null, null, null))::text;`).join('\n')}\nreset role;`;
const version = (title) => (/V1$/.test(title) ? 'v1' : /V2$/.test(title) ? 'v2' : '?');
function analyse(runs, h, v1Id, v2Id) {
  const seen = { v1: 0, v2: 0, gone: 0 }; let incoherent = []; let twice = 0;
  for (const r of runs) {
    for (const line of r.out.split('\n')) {
      if (line.startsWith('D|')) {
        const b = JSON.parse(line.slice(2)); const v = version(b.title);
        if (v === '?' || version(b.summary) !== v || version(b.steps[0].body) !== v || (v === 'v1' ? b.version_id !== v1Id : b.version_id !== v2Id)) incoherent.push(line.slice(0, 160));
        seen[v] += 1;
      } else if (line.startsWith('L|')) {
        const b = JSON.parse(line.slice(2)); const mine = b.items.filter((i) => i.slug === h.slug);
        if (mine.length > 1) twice += 1;
        for (const i of mine) { const v = version(i.title); if (v === '?' || version(i.summary) !== v || (v === 'v1' ? i.version_id !== v1Id : i.version_id !== v2Id)) incoherent.push(line.slice(0, 160)); }
      }
    }
    seen.gone += (r.err.match(/not_found/g) ?? []).length;
    ok(!/deadlock|syntax|permission denied/i.test(r.err), `unexpected error: ${r.err.split('\n')[0]}`);
  }
  return { seen, incoherent, twice };
}
const coherentDoc = (v) => doc(`E8 ${v.toUpperCase()}`, { summary: `Sum ${v.toUpperCase()}`, steps: [`Step ${v.toUpperCase()}`] });

await check('E7', 'reads racing a publication REPLACEMENT: every detail and list entry is one whole version (title, summary, steps, version id agree); a hack is never listed twice', async () => {
  let totals = { v1: 0, v2: 0 };
  for (let attempt = 0; attempt < 3 && (totals.v1 === 0 || totals.v2 === 0); attempt++) {
    const h = await published('E8 V1', { reviewer, d: coherentDoc('v1') });
    const next = await approved('E8 V2', { reviewer, hackId: h.s.hackId, d: coherentDoc('v2'), member: h.s });
    const readers = Array.from({ length: 4 }, () => session(readerScript(h.slug, 250), 0));
    const pub = (async () => { await new Promise((r) => setTimeout(r, 1200)); return publish(next.r, next.s, next.d, null); })();
    const [p, ...runs] = await Promise.all([pub, ...readers]);
    ok(p.status === 200, `replacement publish: HTTP ${p.status} ${msg(p)}`);
    const a = analyse(runs, h, h.s.versionId, next.s.versionId);
    ok(a.incoherent.length === 0, `incoherent responses: ${a.incoherent.slice(0, 2).join(' || ')}`);
    ok(a.twice === 0, 'a hack was listed twice');
    ok(a.seen.gone === 0, `${a.seen.gone} not_found during a replacement (the hack was never unpublished)`);
    totals = { v1: totals.v1 + a.seen.v1, v2: totals.v2 + a.seen.v2 };
  }
  ok(totals.v1 > 0 && totals.v2 > 0, `the race was not exercised: saw v1=${totals.v1}, v2=${totals.v2}`);
  return `4 reader sessions x 500 reads while v2 replaced v1: ${totals.v1} reads saw v1, ${totals.v2} saw v2, 0 mixed, 0 not_found, 0 duplicate listings`;
});

await check('E8', 'reads racing a WITHDRAWAL: every response is either the whole published version or the same not_found; nothing in between', async () => {
  let before = 0; let after = 0;
  for (let attempt = 0; attempt < 3 && (before === 0 || after === 0); attempt++) {
    const h = await published('E8 V1', { reviewer, d: coherentDoc('v1') });
    const readers = Array.from({ length: 4 }, () => session(readerScript(h.slug, 250), 0));
    const wd = (async () => { await new Promise((r) => setTimeout(r, 1200)); return withdraw(reviewer, h.pubId); })();
    const [w, ...runs] = await Promise.all([wd, ...readers]);
    ok(w.status === 200, `withdrawal: HTTP ${w.status} ${msg(w)}`);
    const a = analyse(runs, h, h.s.versionId, h.s.versionId);
    ok(a.incoherent.length === 0 && a.twice === 0, `incoherent: ${a.incoherent.slice(0, 2).join(' || ')}`);
    for (const r of runs) for (const e of r.err.split('\n').filter((x) => /ERROR/.test(x))) ok(/not_found/.test(e), `an error other than not_found: ${e}`);
    before += a.seen.v1; after += a.seen.gone;
    ok(!slugsOf(await list(ANON, { p_limit: 100 })).includes(h.slug) && (await detail(ANON, h.slug)).status === 404, 'hidden after the race');
  }
  ok(before > 0 && after > 0, `the race was not exercised: saw published=${before}, hidden=${after}`);
  return `${before} reads saw the whole published version, ${after} saw not_found, 0 partial; hidden afterwards in list and detail`;
});

await check('R8', 'rollback COMMITTED (functions only, no data lost), the migrations re-applied (supabase migration up), the reads work again with the same data', async () => {
  const h = await published('R8 survivor', { reviewer });
  const probe = () => psql(`select 'fns=' || count(*) from pg_proc where pronamespace in ('api'::regnamespace, 'app_review'::regnamespace) and proname in ('list_public_hacks', 'get_public_hack', 'public_blockers', 'public_hack_json');
select 'ledger=' || count(*) from supabase_migrations.schema_migrations where version like '20261019%';
select 'hacks=' || count(*) from app.hacks;`).out.replace(/\n/g, ' ');
  const before = probe();
  ok(/fns=4 ledger=2/.test(before), `before: ${before}`);
  // PX-3a sits above every F2 slice in the ledger, so a COMMITTED rollback goes in true reverse order: PX-3a first (otherwise `supabase migration up` finds a gap and refuses). It is re-applied by the same `migration up`.
  const downPX3a = psql(readFileSync(path.join(root, 'supabase/rollbacks/20261020090000_px3a_down.sql'), 'utf8'));
  ok(!/ERROR/.test(downPX3a.out + (downPX3a.err ?? '')), `the PX-3a rollback failed: ${(downPX3a.out + (downPX3a.err ?? '')).slice(-300)}`);
  const rolled = psql(readFileSync(path.join(root, 'supabase/rollbacks/20261019090000_f2e_down.sql'), 'utf8'));
  ok(!/ERROR/.test(rolled.out + rolled.err), `rollback failed: ${(rolled.out + rolled.err).slice(-300)}`);
  const mid = probe();
  ok(/fns=0 ledger=0/.test(mid), `after the committed rollback: ${mid}`);
  const gone = await detail(ANON, h.slug);
  ok(gone.status === 404 && gone.body?.code !== 'PT404', `the endpoint is gone: HTTP ${gone.status} ${JSON.stringify(gone.body)}`);
  const up = spawnSync(SUPABASE, ['migration', 'up', '--local'], { cwd: root, encoding: 'utf8', timeout: 240_000 });
  ok(up.status === 0, `migration up failed: ${(up.stderr + up.stdout).slice(-400)}`);
  const end = probe();
  ok(/fns=4 ledger=2/.test(end) && end.split('hacks=')[1] === before.split('hacks=')[1], `after re-application: ${end}`);
  let back; for (let i = 0; i < 10; i++) { back = await detail(ANON, h.slug); if (back.status === 200) break; await new Promise((r) => setTimeout(r, 1000)); } // PostgREST reloads its schema cache
  ok(back.status === 200 && back.body.title === 'R8 survivor', `the read works again: HTTP ${back.status} ${JSON.stringify(back.body).slice(0, 120)}`);
  return `before: ${before} | committed rollback: ${mid} (the endpoint answers ${gone.status}) | after supabase migration up: ${end}; the same hack is readable again`;
});

const failures = failed();
console.log(`\nF2-E public catalog checks: ${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
console.log('NOT run here (hosted only): the same checks against a hosted project; any UI, search, ranking or caching layer (none exists); profile/asset reference resolution (references stay blocked).');
process.exit(failures ? 1 : 0);
