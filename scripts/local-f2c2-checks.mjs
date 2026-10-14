#!/usr/bin/env node
// F2-C2 checks against the REAL local Supabase stack: the staff publication RPCs through PostgREST with real signed JWTs (fresh-MFA staff, members,
// anon, service key, signed-out / disabled / de-staffed callers, self-publication, high risk needing an admin), the worker's lack of access, GENUINE
// CONCURRENCY (concurrent publishes of one submission and of two versions of one hack; a publish racing a rejection, a rights revocation, a prohibited
// assessment and a withdrawal, in both orders; a mixed stress run with a deadlock check), and a rollback rehearsal.
// Run through `npm run db:test:auth`, or with the stack up:  node --conditions=react-server scripts/local-f2c2-checks.mjs
// Prints facts and PASS/FAIL only. Exit 0 all passed, 1 a check failed, 2 stack unreachable.
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_CONTAINER, DOCKER, NETWORK, PUB, SECRET, asMember, confirmedSession, createRunner, decode, elevateToAal2, ok, psql, rpc, session } from './lib/local-stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, failed } = createRunner();
const api = (name, token, args) => rpc('api', name, token, args);
const code = (r) => r.body?.code;
const msg = (r) => r.body?.message;
const owner = (sqlText) => psql(`set role hackass_owner;\n${sqlText}`).out;
const last = (t) => t.split('\n').pop();
const expectErr = (r, status, c, m, what) => ok(r.status === status && code(r) === c && msg(r) === m, `${what}: got HTTP ${r.status} ${code(r)} ${msg(r)} ${r.body?.details ?? ''}, expected ${status} ${c} ${m}`);

const stamp = randomBytes(3).toString('hex');
let slugN = 0;
const slug = () => `f2c2-${stamp}-${++slugN}`;
owner(`insert into app.categories (slug, name) values ('f2c2-${stamp}', 'F2C2 ${stamp}') on conflict do nothing;`);
const doc = (title, extra = {}) => ({
  category_slug: `f2c2-${stamp}`, title, summary: 'Store cut herbs upright in water.', outcome: 'Crisp herbs for two weeks.', difficulty: 'easy', steps: ['Trim the stems.'],
  attributions: [{ role: 'author', external_name: 'A. Cook' }], source_claims: [{ kind: 'original_work' }], ...extra,
});

/** A member who has submitted a complete version through the API (optionally a new version of an existing hack by the same member). */
async function submission(title, { member = null, hackId = null, d = doc(title) } = {}) {
  const m = member ?? await confirmedSession();
  const t = m.session?.access_token ?? m.token;
  const created = await api('create_draft', t, hackId ? { p_hack_id: hackId } : {});
  ok(created.status === 200, `fixture create_draft: HTTP ${created.status} ${msg(created)}`);
  const saved = await api('save_draft', t, { p_version_id: created.body.version_id, p_content: d });
  ok(saved.status === 200, `fixture save_draft: HTTP ${saved.status} ${msg(saved)}`);
  const sub = await api('submit_version', t, { p_version_id: created.body.version_id, p_expected_hash: saved.body.content_hash });
  ok(sub.status === 200, `fixture submit: HTTP ${sub.status} ${msg(sub)}`);
  return { ...m, token: t, hackId: created.body.hack_id, versionId: created.body.version_id, submissionId: sub.body.submission_id, hash: saved.body.content_hash };
}
async function staff(role = 'reviewer') {
  const m = await confirmedSession();
  owner(`insert into app.staff_assignments (user_id, role, granted_by) values ('${m.userId}', '${role}', 'check');`);
  const t2 = await elevateToAal2(m.c);
  return { ...m, token: t2, claims: decode(t2).claims, aal1: m.session.access_token };
}
const rev = (s, extra = {}) => ({ p_submission_id: s.submissionId, p_expected_hash: s.hash, ...extra });
const clearRights = (r, s, n = 1) => api('record_rights_review', r.token, rev(s, { p_claim_no: n, p_status: 'clear', p_basis_code: 'staff_original_check', p_evidence_note: 'Checked the original thoroughly.', p_expires_on: null }));
const assess = (r, s, risk = 'low') => api('record_risk_assessment', r.token, rev(s, { p_risk_class: risk, p_rationale: 'Ordinary household tip, no hazard.' }));
const decide = (r, s, decision, prior = null, reasons = null) => api('record_decision', r.token, rev(s, { p_decision: decision, p_reason_codes: reasons, p_note: null, p_expected_prior_decision_id: prior }));
const publish = (r, s, decisionId, sl = null) => api('publish_version', r.token, rev(s, { p_expected_decision_id: decisionId, p_slug: sl }));
const withdraw = (r, pubId, reason = 'quality', note = null) => api('withdraw_publication', r.token, { p_publication_id: pubId, p_reason_code: reason, p_note: note });
/** A submission reviewed all the way to an approving PUBLISH decision (not yet published). */
async function approved(title, { risk = 'low', reviewer = null, member = null, hackId = null } = {}) {
  const r = reviewer ?? await staff(risk === 'high' ? 'admin' : 'reviewer');
  const s = await submission(title, { member, hackId });
  ok((await api('start_review', r.token, rev(s))).status === 200 && (await assess(r, s, risk)).status === 200 && (await clearRights(r, s)).status === 200, 'fixture review steps');
  const d = await decide(r, s, 'PUBLISH');
  ok(d.status === 200 && d.body.state === 'approved', `fixture approval: HTTP ${d.status} ${msg(d)}`);
  return { r, s, d: d.body.decision_id };
}
const state = (s) => last(owner(`select state from app.version_lifecycle where version_id = '${s.versionId}';`));
const pointer = (hackId) => last(owner(`select coalesce(current_publication_id::text, 'none') from app.hacks where id = '${hackId}';`));
const nPubs = (hackId) => Number(last(owner(`select count(*) from app.publications where hack_id = '${hackId}';`)));
const withdrawal = (pubId) => last(owner(`select coalesce((select cause || '|' || coalesce(trigger_table, '-') || '|' || array_to_string(blockers, ',') from app.publication_withdrawals where publication_id = '${pubId}'), 'none');`));
const HOLD = 3000, LATE = 1000;
const holdTx = (who, call) => session(asMember(who.claims, `begin;\n${call}\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
const lateCall = (who, call) => session(asMember(who.claims, call), LATE);
const pubSql = (s, d, sl) => `select api.publish_version('${s.submissionId}', '${s.hash}', '${d}', ${sl ? `'${sl}'` : 'null'});`;

await check('P1', 'the whole publication with real tokens: approve -> publish -> read the private record -> withdraw; the snapshot is canonical and survives', async () => {
  const { r, s, d } = await approved('P1 flow');
  const sl = slug();
  expectErr(await publish(r, s, d, null), 422, 'PT422', 'invalid_content', 'first publication without a slug');
  expectErr(await api('publish_version', r.token, { p_submission_id: s.submissionId, p_expected_hash: 'a'.repeat(64), p_expected_decision_id: d, p_slug: sl }), 409, 'PT409', 'hash_mismatch', 'publishing a hash that is not the frozen one');
  ok(pointer(s.hackId) === 'none', 'nothing is current before publication');
  const p = await publish(r, s, d, sl);
  ok(p.status === 200 && p.body.hack_id === s.hackId && p.body.version_id === s.versionId && p.body.decision_id === d && p.body.superseded_publication_id === null, `publish: HTTP ${p.status} ${JSON.stringify(p.body)}`);
  ok(pointer(s.hackId) === p.body.publication_id && state(s) === 'approved', 'the pointer is set and the version stays approved');
  ok(last(owner(`select slug from app.hacks where id = '${s.hackId}';`)) === sl, 'the slug was assigned');
  const g = await api('get_publication', r.token, { p_publication_id: p.body.publication_id });
  ok(g.status === 200 && g.body.is_current === true && g.body.withdrawal === null && g.body.published_by === r.userId && g.body.publisher_role === 'reviewer', `get_publication: ${JSON.stringify(g.body).slice(0, 200)}`);
  const text = g.body.snapshot_text;
  ok(createHash('sha256').update(text, 'utf8').digest('hex') === g.body.snapshot_hash === true, 'snapshot_hash is the SHA-256 of the snapshot text');
  const lines = text.split('\n');
  const fv = (v) => (v === null ? '-:' : `${Buffer.byteLength(String(v), 'utf8')}:${v}`);
  ok(lines[0] === 'HACKASS-PUB-1' && lines.at(-1) === '', 'first line is the format tag and the text ends with a newline');
  ok(lines[1] === `target;${fv(s.hackId)};${fv(s.versionId)};${fv(s.submissionId)};${fv(s.hash)};1:1`, `target line: ${lines[1]}`);
  ok(lines[2].startsWith(`decision;${fv(d)};1:1;7:PUBLISH;${fv(r.userId)}`), `decision line: ${lines[2]}`);
  ok(lines[3].startsWith(`assessment;`) && lines[3].endsWith(';3:low'), `assessment line: ${lines[3]}`);
  ok(lines[4] === `publisher;${fv(r.userId)};8:reviewer`, `publisher line: ${lines[4]}`);
  ok(g.body.rights.length === 1 && lines[5].startsWith(`rights;1;${fv(g.body.rights[0].rights_review_id)};1:1;${fv(g.body.rights[0].claim_hash)};5:clear;`) && lines[5].endsWith(`;${fv(g.body.rights[0].evidence_note_hash)}`), `rights line: ${lines[5]}`);
  ok(lines.length === 7, 'exactly the documented lines: format, target, decision, assessment, publisher, one rights line per claim');
  expectErr(await publish(r, s, d, sl), 409, 'PT409', 'invalid_state', 'publishing the same decision again');
  const w = await withdraw(r, p.body.publication_id, 'quality', 'Taken down in the P1 check.');
  ok(w.status === 200 && w.body.state === 'withdrawn' && pointer(s.hackId) === 'none' && state(s) === 'withdrawn', `withdraw: HTTP ${w.status} ${JSON.stringify(w.body)}`);
  expectErr(await withdraw(r, p.body.publication_id), 409, 'PT409', 'invalid_state', 'withdrawing twice');
  const g2 = await api('get_publication', r.token, { p_publication_id: p.body.publication_id });
  ok(g2.body.is_current === false && g2.body.withdrawal.cause === 'staff' && g2.body.snapshot_hash === g.body.snapshot_hash && g2.body.snapshot_text === text, 'the record shows the withdrawal and the snapshot is untouched');
  return `publish -> pointer set, slug assigned; snapshot (7 lines, HACKASS-PUB-1) rebuilt field by field from the API data and its SHA-256 matches; withdraw clears the pointer, the record and snapshot stay`;
});

await check('P2', 'direct JWT calls are refused: members, anon, service key, aal1, signed-out, disabled, de-staffed; self-publication; high risk needs an admin', async () => {
  const { r, s, d } = await approved('P2 guards');
  const args = rev(s, { p_expected_decision_id: d, p_slug: slug() });
  expectErr(await api('publish_version', s.token, args), 403, '42501', 'not_staff', 'the author (a member)');
  for (const [who, key] of [['anon key', PUB], ['service key', SECRET]]) {
    for (const [fn, a] of [['publish_version', args], ['withdraw_publication', { p_publication_id: d, p_reason_code: 'other', p_note: null }], ['get_publication', { p_publication_id: d }]]) {
      const x = await api(fn, key, a);
      ok((x.status === 401 || x.status === 403) && code(x) === '42501', `${who} ${fn}: HTTP ${x.status} ${code(x)}`);
    }
  }
  expectErr(await api('publish_version', r.aal1, args), 403, '42501', 'mfa_required', 'staff at aal1 (insufficient MFA)');
  const dis = await staff();
  owner(`update app.accounts set status = 'disabled' where user_id = '${dis.userId}';`);
  expectErr(await api('publish_version', dis.token, args), 403, '42501', 'account_inactive', 'disabled account holding a valid aal2 token');
  const gone = await staff();
  owner(`update app.staff_assignments set revoked_at = now(), revoked_by = 'check' where user_id = '${gone.userId}' and revoked_at is null;`);
  expectErr(await api('publish_version', gone.token, args), 403, '42501', 'not_staff', 'staff role removed (same token, same session)');
  const out = await staff();
  await out.c.auth.signOut();
  expectErr(await api('publish_version', out.token, args), 403, '28000', 'session_invalid', 'signed-out session with an unexpired aal2 token');
  ok(pointer(s.hackId) === 'none', 'none of those published anything');
  // self-publication: a staff member publishing their own submission
  const own = await staff();
  const ownA = await approved('P2 own work', { member: { ...own, token: own.aal1 } });
  expectErr(await publish(own, ownA.s, ownA.d, slug()), 403, '42501', 'self_review', 'the submitter (a staff member) publishing their own work');
  // insufficient authority: high risk needs an admin
  const adm = await staff('admin');
  const hi = await approved('P2 high risk', { risk: 'high', reviewer: adm });
  const rv = await staff();
  const refused = await publish(rv, hi.s, hi.d, slug());
  ok(refused.status === 409 && msg(refused) === 'approval_blocked' && /risk_high_needs_admin/.test(JSON.stringify(refused.body)), `reviewer vs high risk: ${JSON.stringify(refused.body)}`);
  ok(pointer(hi.s.hackId) === 'none', 'and nothing is current');
  const okAdmin = await publish(adm, hi.s, hi.d, slug());
  ok(okAdmin.status === 200 && last(owner(`select publisher_role from app.publications where id = '${okAdmin.body.publication_id}';`)) === 'admin', `admin publishes: HTTP ${okAdmin.status}`);
  return 'author 403 not_staff; anon/service 401|403 42501 on all 3 functions; aal1 mfa_required; disabled account_inactive; de-staffed not_staff; signed-out session_invalid; own work self_review; reviewer vs high risk approval_blocked(risk_high_needs_admin), admin publishes (stale-MFA: fabricated claims in 060_publication.test.sql)';
});

const workerPw = randomBytes(18).toString('base64url');
psql(`alter role hackass_worker password '${workerPw}'`);
const image = spawnSync(DOCKER, ['inspect', DB_CONTAINER, '--format', '{{.Config.Image}}'], { encoding: 'utf8' }).stdout.trim();
function asWorker(sqlText) {
  const r = spawnSync(DOCKER, ['run', '--rm', '-i', '-e', `PGPASSWORD=${workerPw}`, '--network', NETWORK, image, 'psql', '-h', DB_CONTAINER, '-U', 'hackass_worker', '-d', 'postgres', '-v', 'ON_ERROR_STOP=0', '-At', '-X'], { input: sqlText, encoding: 'utf8', timeout: 90_000 });
  return { out: r.stdout.trim(), err: r.stderr.trim() };
}
await check('W5', 'the worker login cannot read or write publications, rights rows, withdrawals or the hack pointer, nor call any publication function', async () => {
  const tables = ['publications', 'publication_rights', 'publication_withdrawals'];
  const stmts = [...tables.flatMap((t) => [`select count(*) from app.${t};`, `insert into app.${t} default values;`, `update app.${t} set published_at = now();`, `delete from app.${t};`, `truncate app.${t};`]),
    `update app.hacks set current_publication_id = null;`, `select current_publication_id from app.hacks;`,
    `select api.publish_version(gen_random_uuid(), '${'a'.repeat(64)}', gen_random_uuid(), 'a-slug');`, `select api.withdraw_publication(gen_random_uuid(), 'other', null);`, `select api.get_publication(gen_random_uuid());`,
    `select app_review.publication_blockers(gen_random_uuid(), gen_random_uuid());`, `select app_review.withdraw_locked(null, 'staff', 'other', null, null, null, null, gen_random_uuid(), 'withdrawn');`];
  const r = asWorker(['select \'health=\' || worker.healthcheck();', ...stmts].join('\n'));
  const errs = r.err.split('\n').filter((l) => /ERROR/.test(l));
  ok(r.out.split('\n').includes('health=ok'), `the worker could not call its own function: ${r.err.split('\n')[0]}`);
  ok(errs.length === stmts.length && errs.every((e) => /permission denied/i.test(e)), `expected ${stmts.length} permission refusals, got ${errs.length}: ${errs.slice(0, 3).map((e) => e.slice(0, 90)).join(' | ')}`);
  return `${stmts.length} statements (5 operations on each of 3 tables, the pointer, 3 api functions, 2 internal functions) refused with permission denied; worker.healthcheck() works`;
});

// ---- concurrency -------------------------------------------------------------------------------------------------------------------------
await check('Y1', 'concurrent publishes of one submission: exactly one publication, one current pointer, the others refused, no deadlock', async () => {
  const { s, d } = await approved('Y1 same submission');
  const pubbers = [await staff(), await staff(), await staff(), await staff()];
  const sl = slug();
  const runs = await Promise.all(pubbers.flatMap((rv) => [0, 1].map(() => session(asMember(rv.claims, pubSql(s, d, sl))))));
  const won = runs.filter((x) => /"publication_id"/.test(x.out)).length;
  const lost = runs.filter((x) => /decision_already_published/.test(x.err)).length;
  ok(won === 1 && lost === runs.length - 1, `expected 1 winner and ${runs.length - 1} refusals, got ${won} and ${lost}: ${runs.map((x) => x.err.split('\n')[0]).filter(Boolean).slice(0, 2).join(' | ')}`);
  ok(!runs.some((x) => /deadlock/i.test(x.err)), 'a deadlock occurred');
  ok(nPubs(s.hackId) === 1 && pointer(s.hackId) !== 'none', 'one publication and a current pointer');
  return `8 simultaneous publishes by 4 staff -> 1 publication, 7 refused (decision_already_published), pointer set, no deadlock`;
});

await check('Y2', 'concurrent publishes of two versions of one hack: always exactly one current publication, and it is the newer version; no deadlock', async () => {
  const rounds = [];
  for (let i = 0; i < 3; i++) {
    const r1 = await staff();
    const v1 = await approved(`Y2 v1 round ${i}`, { reviewer: r1 });
    const v2 = await approved(`Y2 v2 round ${i}`, { reviewer: r1, member: v1.s, hackId: v1.s.hackId });
    ok(v2.s.hackId === v1.s.hackId, 'the second version belongs to the same hack');
    const sl = slug();
    const other = await staff();
    const runs = await Promise.all([session(asMember(r1.claims, pubSql(v1.s, v1.d, sl))), session(asMember(other.claims, pubSql(v2.s, v2.d, sl))), session(asMember(other.claims, pubSql(v1.s, v1.d, sl)))]);
    ok(!runs.some((x) => /deadlock/i.test(x.err)), `a deadlock occurred: ${runs.map((x) => x.err).join(' | ')}`);
    const cur = pointer(v1.s.hackId);
    const curVersion = cur === 'none' ? 'none' : last(owner(`select version_id from app.publications where id = '${cur}';`));
    ok(curVersion === v2.s.versionId, `round ${i}: the current publication must be the newer version, got ${curVersion}`);
    ok(last(owner(`select count(*) from app.hacks h join app.publication_withdrawals w on w.publication_id = h.current_publication_id where h.id = '${v1.s.hackId}';`)) === '0', 'the pointer must not target a withdrawn publication');
    const states = `${state(v1.s)}/${state(v2.s)}`;
    ok(states === 'superseded/approved' || states === 'approved/approved', `lifecycles: ${states}`);
    rounds.push(`${nPubs(v1.s.hackId)} publication(s), ${states}`);
  }
  return `3 rounds of {v1, v2, v1 again} racing: every round ends with the pointer on v2, no deadlock (${rounds.join('; ')})`;
});

await check('Y3', 'a publish racing a rejection, a rights revocation, a prohibited assessment and a withdrawal, in both orders, never leaves an ineligible publication current', async () => {
  const other = await staff();
  const done = [];
  const waited = (x) => x.ms >= HOLD - LATE - 400;
  // A. rejection
  {
    const a = await approved('Y3 A1 publish first');
    const [, rej] = await Promise.all([holdTx(a.r, pubSql(a.s, a.d, slug())), lateCall(other, `select api.record_decision('${a.s.submissionId}', '${a.s.hash}', 'REJECT', array['quality'], null, '${a.d}');`)]);
    ok(/"decision_id"/.test(rej.out) && waited(rej), `A1: the rejection should wait for the publish and then record (took ${rej.ms} ms): ${rej.err.split('\n')[0]}`);
    ok(pointer(a.s.hackId) === 'none' && state(a.s) === 'rejected' && nPubs(a.s.hackId) === 1, `A1: pointer ${pointer(a.s.hackId)} state ${state(a.s)}`);
    ok(/^review_change\|moderation_decisions\|decision_not_publish$/.test(withdrawal(last(owner(`select id from app.publications where hack_id = '${a.s.hackId}';`)))), 'A1: withdrawn by the rejection');
    const b = await approved('Y3 A2 rejection first');
    const [, pub] = await Promise.all([holdTx(other, `select api.record_decision('${b.s.submissionId}', '${b.s.hash}', 'REJECT', array['quality'], null, '${b.d}');`), lateCall(b.r, pubSql(b.s, b.d, slug()))]);
    ok(/invalid_state/.test(pub.err) && waited(pub), `A2: the publish should wait for the rejection and then be refused (took ${pub.ms} ms): ${pub.err.split('\n')[0]}`);
    ok(pointer(b.s.hackId) === 'none' && nPubs(b.s.hackId) === 0, 'A2: nothing published');
    done.push(`rejection: publish-first ${rej.ms} ms wait -> withdrawn atomically; rejection-first ${pub.ms} ms wait -> publish refused`);
  }
  // B. rights revocation
  {
    const a = await approved('Y3 B1 publish first');
    const [, rv] = await Promise.all([holdTx(a.r, pubSql(a.s, a.d, slug())), lateCall(other, `select api.record_rights_review('${a.s.submissionId}', '${a.s.hash}', 1, 'revoked', null, null, null);`)]);
    ok(/"rights_review_id"/.test(rv.out) && waited(rv), `B1: the revocation should wait and then record (took ${rv.ms} ms): ${rv.err.split('\n')[0]}`);
    const pid = last(owner(`select id from app.publications where hack_id = '${a.s.hackId}';`));
    ok(pointer(a.s.hackId) === 'none' && state(a.s) === 'under_review' && withdrawal(pid) === 'review_change|rights_reviews|rights_not_clear:1', `B1: pointer ${pointer(a.s.hackId)} state ${state(a.s)} withdrawal ${withdrawal(pid)}`);
    const b = await approved('Y3 B2 revocation first');
    const [, pub] = await Promise.all([holdTx(other, `select api.record_rights_review('${b.s.submissionId}', '${b.s.hash}', 1, 'revoked', null, null, null);`), lateCall(b.r, pubSql(b.s, b.d, slug()))]);
    ok(/approval_blocked/.test(pub.err) && /rights_not_clear:1/.test(pub.err) && waited(pub), `B2: the publish should wait and then be blocked (took ${pub.ms} ms): ${pub.err.split('\n')[0]}`);
    ok(pointer(b.s.hackId) === 'none' && nPubs(b.s.hackId) === 0, 'B2: nothing published');
    done.push(`rights revocation: publish-first ${rv.ms} ms wait -> withdrawn atomically; revocation-first ${pub.ms} ms wait -> publish blocked`);
  }
  // C. prohibited assessment
  {
    const a = await approved('Y3 C1 publish first');
    const [, as] = await Promise.all([holdTx(a.r, pubSql(a.s, a.d, slug())), lateCall(other, `select api.record_risk_assessment('${a.s.submissionId}', '${a.s.hash}', 'prohibited', 'Must not stay published: unsafe.');`)]);
    ok(/"assessment_id"/.test(as.out) && waited(as), `C1: the assessment should wait and then record (took ${as.ms} ms): ${as.err.split('\n')[0]}`);
    const pid = last(owner(`select id from app.publications where hack_id = '${a.s.hackId}';`));
    ok(pointer(a.s.hackId) === 'none' && withdrawal(pid) === 'review_change|version_assessments|risk_prohibited', `C1: pointer ${pointer(a.s.hackId)} withdrawal ${withdrawal(pid)}`);
    const b = await approved('Y3 C2 assessment first');
    const [, pub] = await Promise.all([holdTx(other, `select api.record_risk_assessment('${b.s.submissionId}', '${b.s.hash}', 'prohibited', 'Must not be published: unsafe.');`), lateCall(b.r, pubSql(b.s, b.d, slug()))]);
    ok(/approval_blocked/.test(pub.err) && /risk_prohibited/.test(pub.err) && waited(pub), `C2: the publish should wait and then be blocked (took ${pub.ms} ms): ${pub.err.split('\n')[0]}`);
    ok(pointer(b.s.hackId) === 'none' && nPubs(b.s.hackId) === 0, 'C2: nothing published');
    done.push(`prohibited assessment: publish-first ${as.ms} ms wait -> withdrawn atomically; assessment-first ${pub.ms} ms wait -> publish blocked`);
  }
  // D. publish of a newer version racing the withdrawal of the current one
  {
    const mk = async (t) => {
      const v1 = await approved(`Y3 ${t} v1`);
      const p1 = await publish(v1.r, v1.s, v1.d, slug());
      ok(p1.status === 200, `${t}: fixture publish v1`);
      const v2 = await approved(`Y3 ${t} v2`, { reviewer: v1.r, member: v1.s, hackId: v1.s.hackId });
      return { v1, v2, p1: p1.body.publication_id };
    };
    const x = await mk('D1');
    const [, wd] = await Promise.all([holdTx(x.v2.r, pubSql(x.v2.s, x.v2.d, null)), lateCall(other, `select api.withdraw_publication('${x.p1}', 'quality', null);`)]);
    ok(/invalid_state/.test(wd.err) && /not_current/.test(wd.err) && waited(wd), `D1: the withdrawal should wait and find v1 no longer current (took ${wd.ms} ms): ${wd.err.split('\n')[0]}`);
    ok(pointer(x.v1.s.hackId) !== 'none' && withdrawal(x.p1) === 'superseded|-|' && state(x.v1.s) === 'superseded', `D1: pointer ${pointer(x.v1.s.hackId)} withdrawal ${withdrawal(x.p1)} state ${state(x.v1.s)}`);
    const y = await mk('D2');
    const [, pub] = await Promise.all([holdTx(other, `select api.withdraw_publication('${y.p1}', 'quality', null);`), lateCall(y.v2.r, pubSql(y.v2.s, y.v2.d, null))]);
    ok(/"publication_id"/.test(pub.out) && /"superseded_publication_id": null/.test(pub.out) && waited(pub), `D2: the publish should wait for the withdrawal and then publish v2 (took ${pub.ms} ms): ${pub.err.split('\n')[0]} ${pub.out.slice(0, 80)}`);
    ok(pointer(y.v1.s.hackId) !== 'none' && withdrawal(y.p1) === 'staff|-|' && state(y.v1.s) === 'withdrawn', `D2: pointer ${pointer(y.v1.s.hackId)} withdrawal ${withdrawal(y.p1)} state ${state(y.v1.s)}`);
    done.push(`withdrawal vs newer publish: publish-first ${wd.ms} ms wait -> withdrawal finds v1 superseded; withdraw-first ${pub.ms} ms wait -> v2 published`);
  }
  const bad = last(owner(`select count(*) from app.hacks h where h.current_publication_id is not null and (exists (select 1 from app.publication_withdrawals w where w.publication_id = h.current_publication_id) or cardinality(app_review.publication_blockers((select submission_id from app.publications where id = h.current_publication_id), (select published_by from app.publications where id = h.current_publication_id))) > 0);`));
  ok(bad === '0', `${bad} hacks point at a withdrawn or ineligible publication`);
  return done.join(' | ');
});

await check('Y4', 'mixed stress over many hacks (publish, rights revocation, assessment, rejection, from several staff at once): no deadlock, and every publication is either current-and-eligible or withdrawn', async () => {
  const stafff = [await staff(), await staff(), await staff()];
  const hacks = [];
  for (let i = 0; i < 4; i++) {
    const v1 = await approved(`Y4 ${i} v1`, { reviewer: stafff[0] });
    const v2 = await approved(`Y4 ${i} v2`, { reviewer: stafff[0], member: v1.s, hackId: v1.s.hackId });
    hacks.push({ v1, v2, sl: slug() });
  }
  const jobs = [];
  for (const h of hacks) {
    const [a, b, c] = stafff;
    jobs.push(session(asMember(a.claims, pubSql(h.v1.s, h.v1.d, h.sl))));
    jobs.push(session(asMember(b.claims, pubSql(h.v2.s, h.v2.d, h.sl))));
    jobs.push(session(asMember(c.claims, `select api.record_rights_review('${h.v1.s.submissionId}', '${h.v1.s.hash}', 1, 'revoked', null, null, null);`)));
    jobs.push(session(asMember(c.claims, `select api.record_risk_assessment('${h.v2.s.submissionId}', '${h.v2.s.hash}', 'prohibited', 'Stress run: reassessed as prohibited.');`)));
    jobs.push(session(asMember(a.claims, `select api.record_decision('${h.v1.s.submissionId}', '${h.v1.s.hash}', 'HOLD', array['other'], null, '${h.v1.d}');`)));
    jobs.push(session(asMember(b.claims, pubSql(h.v1.s, h.v1.d, h.sl))));
  }
  const runs = await Promise.all(jobs);
  ok(!runs.some((x) => /deadlock/i.test(x.err)), `a deadlock occurred: ${runs.filter((x) => /deadlock/i.test(x.err))[0]?.err}`);
  const inv = (q) => last(owner(q));
  ok(inv(`select count(*) from app.hacks h where h.current_publication_id is not null and (exists (select 1 from app.publication_withdrawals w where w.publication_id = h.current_publication_id) or cardinality(app_review.publication_blockers((select submission_id from app.publications where id = h.current_publication_id), (select published_by from app.publications where id = h.current_publication_id))) > 0);`) === '0', 'an ineligible or withdrawn publication is current');
  ok(inv(`select count(*) from app.publications p where not exists (select 1 from app.publication_withdrawals w where w.publication_id = p.id) and not exists (select 1 from app.hacks h where h.current_publication_id = p.id);`) === '0', 'a publication is neither current nor withdrawn');
  ok(inv(`select count(*) from app.publications p join app.moderation_decisions d on d.id = p.decision_id where d.decision <> 'PUBLISH';`) === '0', 'a publication rests on a non-PUBLISH decision');
  const ended = inv(`select count(*) from app.publication_withdrawals w join app.publications p on p.id = w.publication_id where p.hack_id in (${hacks.map((h) => `'${h.v1.s.hackId}'`).join(',')});`);
  const made = inv(`select count(*) from app.publications where hack_id in (${hacks.map((h) => `'${h.v1.s.hackId}'`).join(',')});`);
  return `${runs.length} simultaneous calls over 4 hacks and 3 staff: no deadlock; ${made} publications made, ${ended} ended, every remaining current publication is eligible; every publication is current or withdrawn`;
});

await check('R4', 'F2-C2 rollback script (run after the F2-D1 rollback): removes the publication tables, the pointer, the functions and the added keys, restores the F2-C1 lock_submission, leaves F2-C1/F2-B/F2-A intact (rehearsed in a rolled-back transaction)', async () => {
  // F2-D1's jobs reference publications, so its rollback runs first inside the same rehearsal transaction
  const downD1 = readFileSync(path.join(root, 'supabase/rollbacks/20261017090000_f2d1_down.sql'), 'utf8').replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '');
  const down = readFileSync(path.join(root, 'supabase/rollbacks/20261016090000_f2c2_down.sql'), 'utf8').replace(/^begin;\s*$/m, () => `begin;\n${downD1}`);
  const probe = `
select 'tables=' || count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r' and c.relname in ('publications', 'publication_rights', 'publication_withdrawals');
select 'pointer=' || count(*) from pg_attribute where attrelid = 'app.hacks'::regclass and attname = 'current_publication_id' and not attisdropped;
select 'api=' || coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname in ('publish_version', 'withdraw_publication', 'get_publication');
select 'internals=' || count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app_review' and p.proname in ('snapshot_text', 'effective_rights', 'publication_blockers', 'withdraw_locked', 'guard_publication', 'guard_hack', 'after_review_write', 'check_publication_children', 'check_withdrawal_cleared');
select 'keys=' || count(*) from pg_constraint where conname in ('decisions_id_submission', 'assessments_id_submission', 'rights_review_binding');
select 'lock_has_hack=' || (select prosrc like '%app.hacks%' from pg_proc where oid = 'app_review.lock_submission(uuid)'::regprocedure);
select 'ledger=' || count(*) from supabase_migrations.schema_migrations where version like '20261016%';
select 'f2c1=' || (to_regclass('app.moderation_decisions') is not null) || ',' || (to_regclass('app.hacks') is not null) || ',' || (to_regprocedure('api.record_decision(uuid,text,text,text[],text,uuid)') is not null);
`;
  const before = psql(probe).out.replace(/\n/g, ' ');
  ok(/tables=3 pointer=1 api=get_publication,publish_version,withdraw_publication internals=9 keys=3 lock_has_hack=true ledger=3 f2c1=true,true,true/.test(before), `before: ${before}`);
  const after = psql(down.replace(/^commit;\s*$/m, `${probe}\nrollback;`)).out.replace(/\n/g, ' ');
  ok(/tables=0 pointer=0 api= internals=0 keys=0 lock_has_hack=false ledger=0 f2c1=true,true,true/.test(after), `after rollback: ${after}`);
  ok(psql(probe).out.replace(/\n/g, ' ') === before, 'the rehearsal must leave the database unchanged');
  return 'after the rollback script: 0 publication tables, no pointer column, no publication functions, added keys gone, F2-C1 lock_submission restored, F2-C1/B/A intact; transaction rolled back, state restored';
});

const n = failed();
console.log(`\nF2-C2 publication checks: ${n === 0 ? 'all passed' : `${n} FAILED`}`);
console.log('NOT run here (hosted only): the same checks against the hosted project and pooler; stale-MFA with real 15-minute-old tokens; rights expiring AFTER publication (no sweeper exists yet).');
process.exit(n ? 1 : 0);
