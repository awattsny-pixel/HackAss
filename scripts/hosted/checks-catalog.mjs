#!/usr/bin/env node
// Authorization S8 (MUTATING): `catalog-checks` = H11 (public catalog eligibility, pagination and argument errors on staging). Needs `worker-checks` (fixture J).
// The pagination fixtures P1 to P5 are synthetic, authored by b1 and published by s-rev through the real API; they cannot be deleted (append-only) and stay until the project is deleted.
// Walks are restricted to this run's category so earlier runs on the same project cannot change the page counts.
// Usage: node scripts/hosted/checks-catalog.mjs --run-id=... --authorized=S8@<sha> --confirm-mutating=catalog-checks [--profile=...]
import { runStage, checker, ok } from './lib/cli.mjs';
import { signIn, steppedUp, doc, submit, approve, publish, withdraw, revokeRights, api, errMsg } from './lib/flows.mjs';

const DETAIL_KEYS = 'ai_requirement,attributions,category,cost,difficulty,estimate_basis,limitations,materials,outcome,published_at,requirements,slug,sources,steps,summary,tags,time_minutes,title,version_id';
const ITEM_KEYS = 'ai_requirement,category,cost,difficulty,published_at,slug,summary,time_minutes,title,version_id';
const j = (x) => JSON.stringify(x);

const code = await runStage('catalog-checks', process.argv.slice(2), async ({ ctx, run, say }) => {
  const c = checker(run, say);
  const state = run.state(); const sec = run.secrets();
  const category = state.fixtures.category; const J = state.facts.job_fixture;
  ok(J?.slug, 'the worker-checks stage left no job fixture (J)');
  const list = (token, args = {}) => api(ctx, 'list_public_hacks', token, { p_category: category, ...args });
  const detail = (token, slug) => api(ctx, 'get_public_hack', token, { p_slug: slug });
  const slugsOf = (r) => (r.body?.items ?? []).map((i) => i.slug);
  const walk = async (limit) => {
    const pages = []; let cursor = {};
    for (let n = 0; n < 50; n++) {
      const r = await list(undefined, { p_limit: limit, ...cursor });
      ok(r.status === 200, `page ${n + 1}: HTTP ${r.status} ${errMsg(r) ?? ''}`);
      pages.push(r.body); if (!r.body.next_cursor) return pages;
      cursor = { p_after_published_at: r.body.next_cursor.published_at, p_after_slug: r.body.next_cursor.slug };
    }
    throw new Error('the walk did not end within 50 pages');
  };
  const ordered = (items) => items.every((it, i) => i === 0 || items[i - 1].published_at > it.published_at || (items[i - 1].published_at === it.published_at && items[i - 1].slug > it.slug));

  await c.check('H11', 'the public catalog shows exactly the eligible publications, hides withdrawn and rights-revoked ones at once, paginates in a stable order and refuses bad arguments', async () => {
    const b1 = await signIn(ctx, state.fixtures.users.b1.email, sec.users.b1.password);
    const rev = await steppedUp(ctx, run, 's-rev');
    const P = {};
    for (const n of [1, 2, 3, 4, 5]) {
      const s = await submit(ctx, b1.access_token, doc(category, `H11 fixture P${n}`));
      const d = await approve(ctx, rev.access_token, s);
      const slug = `stg-${run.runId}-p${n}`;
      const pub = await publish(ctx, rev.access_token, s, d, slug);
      P[n] = { s, slug, publicationId: pub.publication_id };
    }
    const st = run.state(); st.facts.catalog_fixtures = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, v.slug])); run.save(st);
    // private text that must never reach the public body
    // version_id is a documented public field, so it is not private text
    const priv = [...Object.values(P).flatMap((p) => [p.s.hackId, p.s.submissionId, p.publicationId, p.s.hash]), 'Synthetic fixture checked against itself', 'A synthetic, harmless household tip', 'staff_original_check'];
    // an unpublished trio for the not-found checks (no slug exists for them)
    const draft = await api(ctx, 'create_draft', b1.access_token, {}); ok(draft.status === 200, 'draft fixture');
    await submit(ctx, b1.access_token, doc(category, 'H11 submitted only'));
    const appr = await submit(ctx, b1.access_token, doc(category, 'H11 approved only')); await approve(ctx, rev.access_token, appr);

    // 1. all six visible and identical for the three callers
    const staffTok = rev.access_token;
    for (const slug of [...Object.values(P).map((p) => p.slug), J.slug]) {
      const [a, m, s] = await Promise.all([detail(undefined, slug), detail(b1.access_token, slug), detail(staffTok, slug)]);
      ok(a.status === 200 && m.status === 200 && s.status === 200, `${slug}: HTTP ${a.status}/${m.status}/${s.status}`);
      ok(j(a.body) === j(m.body) && j(a.body) === j(s.body), `${slug}: anonymous, member and staff details differ`);
      ok(Object.keys(a.body).sort().join() === DETAIL_KEYS, `${slug}: detail keys ${Object.keys(a.body).sort().join()}`);
      const text = j(a.body); for (const [i, p] of priv.entries()) ok(!text.includes(p), `private string #${i} reached the public detail of ${slug}`);
    }
    const [la, lm, ls] = await Promise.all([list(undefined, { p_limit: 100 }), list(b1.access_token, { p_limit: 100 }), list(staffTok, { p_limit: 100 })]);
    ok(la.status === 200 && j(la.body) === j(lm.body) && j(la.body) === j(ls.body), 'anonymous, member and staff lists differ');
    ok(slugsOf(la).length === 6, `the list holds ${slugsOf(la).length} items, expected 6`);
    for (const it of la.body.items) ok(Object.keys(it).sort().join() === ITEM_KEYS, `list item keys ${Object.keys(it).sort().join()}`);
    const lt = j(la.body); for (const [i, p] of priv.entries()) ok(!lt.includes(p), `private string #${i} reached the public list`);
    for (const t of ['H11 submitted only', 'H11 approved only']) ok(!lt.includes(t), `${t} is listed`);

    // 2. walk 1
    const w1 = await walk(2);
    ok(w1.length === 3 && w1.every((p) => p.items.length === 2), `walk 1 pages: ${w1.map((p) => p.items.length).join('/')}`);
    const seen1 = w1.flatMap((p) => p.items); ok(new Set(seen1.map((i) => i.slug)).size === 6, 'walk 1 repeated or missed a slug'); ok(ordered(seen1), 'walk 1 is not in (published_at desc, slug desc) order');
    ok(j(seen1.map((i) => i.slug)) === j(slugsOf(la)), 'walk 1 differs from the one-page list');

    // 3. hide two
    const w = await withdraw(ctx, rev.access_token, P[4].publicationId); ok(w.status === 200, `withdraw P4: HTTP ${w.status} ${errMsg(w) ?? ''}`);
    const rv = await revokeRights(ctx, rev.access_token, P[5].s); ok(rv.status === 200, `revoke P5: HTTP ${rv.status} ${errMsg(rv) ?? ''}`);
    const after = slugsOf(await list(undefined, { p_limit: 100 }));
    ok(after.length === 4 && !after.includes(P[4].slug) && !after.includes(P[5].slug), `after hiding two the list holds ${after.join()}`);
    const missing = await detail(undefined, `stg-${run.runId}-nothing`);
    ok(missing.status === 404 && missing.body?.code === 'PT404' && /not_found/.test(missing.body?.message ?? ''), `a missing slug answered HTTP ${missing.status} ${j(missing.body)}`);
    for (const n of [4, 5]) { const r = await detail(undefined, P[n].slug); ok(r.status === missing.status && j(r.body) === j(missing.body), `P${n} is hidden but answers differently from a missing slug (${r.status} ${j(r.body)})`); }

    // 4. walk 2
    const w2 = await walk(1); const s2 = w2.flatMap((p) => p.items);
    ok(w2.length === 4 && s2.length === 4, `walk 2 pages: ${w2.length}`); ok(ordered(s2), 'walk 2 is not in order');
    ok(j(s2.map((i) => i.slug).sort()) === j([P[1].slug, P[2].slug, P[3].slug, J.slug].sort()), 'walk 2 does not hold exactly P1, P2, P3 and J');
    const w3 = await walk(3); ok(w3.length === 2 && w3[0].items.length === 3 && w3[1].items.length === 1, `limit 3 pages: ${w3.map((p) => p.items.length).join('/')}`);

    // 5. argument errors
    const cases = [[{ p_limit: 0 }, 'limit 0'], [{ p_after_slug: 'x' }, 'half a cursor'], [{ p_after_published_at: '2026-01-01T00:00:00Z' }, 'half a cursor 2'], [{ p_difficulty: 'impossible' }, 'unknown difficulty']];
    for (const [args, what] of cases) { const r = await list(undefined, args); ok(r.status === 422 && r.body?.code === 'PT422', `${what}: HTTP ${r.status} ${j(r.body)}`); }
    return `6 visible (identical for anonymous, member, staff; keys exact; no private text); walk of 2: 3 pages in order; P4 withdrawn and P5 revoked hidden at once, answering exactly like a missing slug; walks of 1 and 3: 4 and 2 pages; ${cases.length} bad arguments -> PT422`;
  });
  return c.out;
});
process.exitCode = code;
