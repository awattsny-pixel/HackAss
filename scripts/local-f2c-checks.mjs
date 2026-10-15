#!/usr/bin/env node
// F2-C1 checks against the REAL local Supabase stack: the staff review RPCs through PostgREST with real signed JWTs (fresh-MFA staff, members, anon,
// service key, signed-out / disabled / de-staffed callers, self-review), the worker's lack of access, GENUINE CONCURRENCY between reviewers
// (decisions, rights revocations, risk assessments racing approval), and a rollback rehearsal.
// Run through `npm run db:test:auth`, or with the stack up:  node --conditions=react-server scripts/local-f2c-checks.mjs
// Prints facts and PASS/FAIL only. Exit 0 all passed, 1 a check failed, 2 stack unreachable.
import { randomBytes } from 'node:crypto';
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
const expectErr = (r, status, c, m, what) => ok(r.status === status && code(r) === c && msg(r) === m, `${what}: got HTTP ${r.status} ${code(r)} ${msg(r)}, expected ${status} ${c} ${m}`);

const stamp = randomBytes(3).toString('hex');
owner(`insert into app.categories (slug, name) values ('f2c-${stamp}', 'F2C ${stamp}') on conflict do nothing;`);
const doc = (title) => ({
  category_slug: `f2c-${stamp}`, title, summary: 'Store cut herbs upright in water.', outcome: 'Crisp herbs for two weeks.', difficulty: 'easy', steps: ['Trim the stems.'],
  attributions: [{ role: 'author', external_name: 'A. Cook' }], source_claims: [{ kind: 'original_work' }],
});

/** A member who has submitted a complete version through the API; returns ids and the frozen hash. */
async function submission(title, d = doc(title)) {
  const m = await confirmedSession();
  const t = m.session.access_token;
  const created = await api('create_draft', t);
  const saved = await api('save_draft', t, { p_version_id: created.body.version_id, p_content: d });
  ok(saved.status === 200, `fixture save_draft: HTTP ${saved.status} ${msg(saved)}`);
  const sub = await api('submit_version', t, { p_version_id: created.body.version_id, p_expected_hash: saved.body.content_hash });
  ok(sub.status === 200, `fixture submit: HTTP ${sub.status} ${msg(sub)}`);
  return { ...m, token: t, versionId: created.body.version_id, submissionId: sub.body.submission_id, hash: saved.body.content_hash };
}
/** A staff member (reviewer or admin) with an aal2 token; also returns the fabricated-session claims for psql sessions. */
async function staff(role = 'reviewer') {
  const m = await confirmedSession();
  owner(`insert into app.staff_assignments (user_id, role, granted_by) values ('${m.userId}', '${role}', 'check');`);
  const t2 = await elevateToAal2(m.c);
  return { ...m, token: t2, claims: decode(t2).claims, aal1: m.session.access_token };
}
const rev = (r, s, extra = {}) => ({ p_submission_id: s.submissionId, p_expected_hash: s.hash, ...extra });
const clearRights = (r, s, n = 1) => api('record_rights_review', r.token, rev(r, s, { p_claim_no: n, p_status: 'clear', p_basis_code: 'staff_original_check', p_evidence_note: 'Checked the original thoroughly.', p_expires_on: null }));
const lowRisk = (r, s) => api('record_risk_assessment', r.token, rev(r, s, { p_risk_class: 'low', p_rationale: 'Ordinary household tip, no hazard.' }));
const decide = (r, s, decision, prior = null, reasons = null) => api('record_decision', r.token, rev(r, s, { p_decision: decision, p_reason_codes: reasons, p_note: null, p_expected_prior_decision_id: prior }));

await check('V1', 'the whole review with real tokens: list -> read -> start -> assess -> clear rights -> approve; the history is bound to the frozen hash', async () => {
  const r = await staff();
  const s = await submission('V1 flow');
  const list = await api('list_submissions_for_review', r.token, { p_limit: 50 });
  ok(list.status === 200 && list.body.some((x) => x.submission_id === s.submissionId && x.state === 'submitted' && x.content_hash === s.hash), `the submission is not in the queue (HTTP ${list.status})`);
  const got = await api('get_submission_for_review', r.token, { p_submission_id: s.submissionId });
  ok(got.status === 200 && got.body.content.title === 'V1 flow' && got.body.content_hash === s.hash, 'reviewer reads the frozen content');
  ok(JSON.stringify(got.body.approval_blockers) === JSON.stringify(['assessment_missing', 'rights_not_clear:1']), `blockers: ${JSON.stringify(got.body.approval_blockers)}`);
  expectErr(await decide(r, s, 'PUBLISH'), 409, 'PT409', 'invalid_state', 'decision before the review starts');
  const st = await api('start_review', r.token, rev(r, s));
  ok(st.status === 200 && st.body.state === 'under_review', `start_review HTTP ${st.status}`);
  expectErr(await api('start_review', r.token, { p_submission_id: s.submissionId, p_expected_hash: 'a'.repeat(64) }), 409, 'PT409', 'hash_mismatch', 'wrong hash');
  const blocked = await decide(r, s, 'PUBLISH');
  ok(blocked.status === 409 && msg(blocked) === 'approval_blocked' && /assessment_missing,rights_not_clear:1/.test(JSON.stringify(blocked.body)), `blocked approval: ${JSON.stringify(blocked.body)}`);
  ok((await lowRisk(r, s)).status === 200 && (await clearRights(r, s)).status === 200, 'assessment and rights review should record');
  const d1 = await decide(r, s, 'PUBLISH');
  ok(d1.status === 200 && d1.body.seq === 1 && d1.body.supersedes_id === null && d1.body.state === 'approved', `approval: HTTP ${d1.status} ${JSON.stringify(d1.body)}`);
  expectErr(await decide(r, s, 'REJECT', null, ['quality']), 409, 'PT409', 'decision_conflict', 'deciding without knowing the latest decision');
  const d2 = await decide(r, s, 'REJECT', d1.body.decision_id, ['quality']);
  ok(d2.status === 200 && d2.body.seq === 2 && d2.body.supersedes_id === d1.body.decision_id && d2.body.state === 'rejected', `second decision: ${JSON.stringify(d2.body)}`);
  const bound = owner(`select count(*) from app.moderation_decisions d join app.submissions x on x.id = d.submission_id where d.submission_id = '${s.submissionId}' and d.content_hash = x.content_hash and d.actor_id = '${r.userId}';`);
  ok(last(bound) === '2', 'both decisions are bound to the submission hash and the real reviewer');
  return 'approval blocked -> assessment -> rights -> approved (seq 1) -> stale decision conflict -> rejected (seq 2, supersedes 1); reviewer recorded from the token';
});

await check('V2', 'direct JWT calls are refused: members, anon, service key, aal1, signed-out, disabled, de-staffed, and self-review', async () => {
  const r = await staff();
  const s = await submission('V2 guards');
  const args = rev(r, s, { p_decision: 'HOLD', p_reason_codes: ['other'], p_note: null, p_expected_prior_decision_id: null });
  expectErr(await api('record_decision', s.token, args), 403, '42501', 'not_staff', 'the author (a member)');
  for (const [who, key] of [['anon key', PUB], ['service key', SECRET]]) {
    const x = await api('record_decision', key, args);
    ok((x.status === 401 || x.status === 403) && code(x) === '42501', `${who}: HTTP ${x.status} ${code(x)}`);
  }
  expectErr(await api('record_decision', r.aal1, args), 403, '42501', 'mfa_required', 'staff at aal1 (insufficient MFA)');
  const dis = await staff();
  owner(`update app.accounts set status = 'disabled' where user_id = '${dis.userId}';`);
  expectErr(await api('record_decision', dis.token, args), 403, '42501', 'account_inactive', 'disabled account holding a valid aal2 token');
  const gone = await staff();
  ok((await api('start_review', gone.token, rev(gone, s))).status === 200, 'baseline: this reviewer works');
  owner(`update app.staff_assignments set revoked_at = now(), revoked_by = 'check' where user_id = '${gone.userId}' and revoked_at is null;`);
  expectErr(await api('record_decision', gone.token, args), 403, '42501', 'not_staff', 'staff role removed (same token, same session)');
  const out = await staff();
  await out.c.auth.signOut();
  expectErr(await api('record_decision', out.token, args), 403, '28000', 'session_invalid', 'signed-out session with an unexpired aal2 token');
  // self-review: a staff member who is also a submitter
  const own = await staff();
  const created = await api('create_draft', own.aal1);
  const saved = await api('save_draft', own.aal1, { p_version_id: created.body.version_id, p_content: doc('V2 own work') });
  const sub = await api('submit_version', own.aal1, { p_version_id: created.body.version_id, p_expected_hash: saved.body.content_hash });
  const ownS = { submissionId: sub.body.submission_id, hash: saved.body.content_hash };
  for (const [fn, a] of [['get_submission_for_review', { p_submission_id: ownS.submissionId }], ['start_review', rev(own, ownS)], ['record_risk_assessment', rev(own, ownS, { p_risk_class: 'low', p_rationale: 'Ordinary household tip, no hazard.' })],
    ['record_rights_review', rev(own, ownS, { p_claim_no: 1, p_status: 'clear', p_basis_code: 'staff_original_check', p_evidence_note: 'Checked the original thoroughly.', p_expires_on: null })],
    ['record_decision', rev(own, ownS, { p_decision: 'PUBLISH', p_reason_codes: null, p_note: null, p_expected_prior_decision_id: null })]]) {
    expectErr(await api(fn, own.token, a), 403, '42501', 'self_review', `self-review via ${fn}`);
  }
  const q = await api('list_submissions_for_review', own.token, { p_limit: 50 });
  ok(q.status === 200 && !q.body.some((x) => x.submission_id === ownS.submissionId), 'and the own submission is not in the queue');
  return 'author 403 not_staff; anon/service 401 42501; aal1 403 mfa_required; disabled 403 account_inactive; de-staffed 403 not_staff; signed-out 403 session_invalid; own work 403 self_review on all 5 functions (stale-MFA cases: fabricated claims in 050_review.test.sql, a real token cannot be 15 minutes old here)';
});

const workerPw = randomBytes(18).toString('base64url');
psql(`alter role hackass_worker password '${workerPw}'`);
const image = spawnSync(DOCKER, ['inspect', DB_CONTAINER, '--format', '{{.Config.Image}}'], { encoding: 'utf8' }).stdout.trim();
function asWorker(sqlText) {
  const r = spawnSync(DOCKER, ['run', '--rm', '-i', '-e', `PGPASSWORD=${workerPw}`, '--network', NETWORK, image, 'psql', '-h', DB_CONTAINER, '-U', 'hackass_worker', '-d', 'postgres', '-v', 'ON_ERROR_STOP=0', '-At', '-X'], { input: sqlText, encoding: 'utf8', timeout: 90_000 });
  return { out: r.stdout.trim(), err: r.stderr.trim() };
}
await check('W4', 'the worker login cannot read or write assessments, rights reviews or decisions, nor call any review function', async () => {
  const tables = ['version_assessments', 'rights_reviews', 'moderation_decisions'];
  const stmts = [...tables.flatMap((t) => [`select count(*) from app.${t};`, `insert into app.${t} default values;`, `update app.${t} set seq = 1;`, `delete from app.${t};`, `truncate app.${t};`]),
    `select api.list_submissions_for_review();`, `select api.get_submission_for_review(gen_random_uuid());`, `select api.start_review(gen_random_uuid(), '${'a'.repeat(64)}');`,
    `select api.record_decision(gen_random_uuid(), '${'a'.repeat(64)}', 'HOLD', array['other'], null, null);`, `select api.record_rights_review(gen_random_uuid(), '${'a'.repeat(64)}', 1, 'hold', null, null, null);`,
    `select api.record_risk_assessment(gen_random_uuid(), '${'a'.repeat(64)}', 'low', 'A long enough rationale.');`, `select app_review.approval_blockers(gen_random_uuid(), gen_random_uuid());`, `select app_review.lock_submission(gen_random_uuid());`];
  const r = asWorker(['select \'health=\' || worker.healthcheck();', ...stmts].join('\n'));
  const errs = r.err.split('\n').filter((l) => /ERROR/.test(l));
  ok(r.out.split('\n').includes('health=ok'), `the worker could not call its own function: ${r.err.split('\n')[0]}`);
  ok(errs.length === stmts.length && errs.every((e) => /permission denied/i.test(e)), `expected ${stmts.length} permission refusals, got ${errs.length}: ${errs.slice(0, 3).map((e) => e.slice(0, 90)).join(' | ')}`);
  return `${stmts.length} statements (5 operations on each of 3 tables, 6 api functions, 2 internal functions) refused with permission denied; worker.healthcheck() works`;
});

// ---- concurrency -------------------------------------------------------------------------------------------------------------------------
const HOLD = 3000, LATE = 1000;
async function ready(title) {   // submission under review with a low assessment and a cleared claim
  const r = await staff(); const s = await submission(title);
  ok((await api('start_review', r.token, rev(r, s))).status === 200 && (await lowRisk(r, s)).status === 200 && (await clearRights(r, s)).status === 200, 'fixture review steps');
  return { r, s };
}
const historyOk = (submissionId) => last(owner(`select (count(*) = coalesce(max(seq), 0) and coalesce(min(seq), 1) = 1 and count(*) filter (where supersedes_id is null) <= 1 and count(distinct supersedes_id) filter (where supersedes_id is not null) = count(*) filter (where supersedes_id is not null))::text from app.moderation_decisions where submission_id = '${submissionId}';`)) === 'true';

await check('X1', 'concurrent decisions by different reviewers serialize: exactly one wins, the others get decision_conflict, the history stays one chain', async () => {
  const { s } = await ready('X1 decisions');
  const reviewers = [await staff(), await staff(), await staff(), await staff()];
  const runs = await Promise.all(reviewers.flatMap((rv) => [0, 1].map(() => session(asMember(rv.claims, `select api.record_decision('${s.submissionId}', '${s.hash}', 'HOLD', array['other'], null, null);`)))));
  const won = runs.filter((x) => /"decision_id"/.test(x.out)).length;
  const lost = runs.filter((x) => /decision_conflict/.test(x.err)).length;
  ok(won === 1 && lost === runs.length - 1, `expected 1 winner and ${runs.length - 1} decision_conflicts, got ${won} and ${lost}: ${runs.map((x) => x.err.split('\n')[0]).filter(Boolean).slice(0, 2).join(' | ')}`);
  ok(last(owner(`select count(*) from app.moderation_decisions where submission_id = '${s.submissionId}';`)) === '1' && historyOk(s.submissionId), 'the history must be a single decision');
  // racing to supersede the SAME prior decision
  const prior = last(owner(`select id from app.moderation_decisions where submission_id = '${s.submissionId}';`));
  const race = await Promise.all(reviewers.map((rv) => session(asMember(rv.claims, `select api.record_decision('${s.submissionId}', '${s.hash}', 'REQUEST_CHANGES', array['quality'], null, '${prior}');`))));
  const w2 = race.filter((x) => /"decision_id"/.test(x.out)).length;
  ok(w2 === 1 && race.filter((x) => /decision_conflict/.test(x.err)).length === 3, `superseding race: ${w2} winners`);
  ok(last(owner(`select count(*) from app.moderation_decisions where submission_id = '${s.submissionId}';`)) === '2' && historyOk(s.submissionId), 'the chain must be exactly two decisions, linear');
  return `8 simultaneous decisions -> 1 recorded, 7 decision_conflict; 4 reviewers racing to supersede the same decision -> 1 recorded, 3 conflicts; chain 1 -> 2 linear`;
});

await check('X2', 'an approval racing a rights revocation (or a prohibited assessment) never approves on stale state: it waits for the in-flight review write and then sees it', async () => {
  const a = await ready('X2 revoke'); const other = await staff();
  const s1 = session(asMember(other.claims, `begin;\nselect api.record_rights_review('${a.s.submissionId}', '${a.s.hash}', 1, 'revoked', null, null, null);\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
  const s2 = session(asMember(a.r.claims, `select api.record_decision('${a.s.submissionId}', '${a.s.hash}', 'PUBLISH', null, null, null);`), LATE);
  const [, r2] = await Promise.all([s1, s2]);
  ok(/approval_blocked/.test(r2.err) && /rights_not_clear:1/.test(r2.err + r2.out) && r2.ms >= HOLD - LATE - 400, `approval should have waited and then been blocked (took ${r2.ms} ms): ${r2.err.split('\n')[0]}`);
  ok(last(owner(`select count(*) from app.moderation_decisions where submission_id = '${a.s.submissionId}';`)) === '0', 'no decision may exist');
  const b = await ready('X2 prohibited');
  const t1 = session(asMember(other.claims, `begin;\nselect api.record_risk_assessment('${b.s.submissionId}', '${b.s.hash}', 'prohibited', 'Must not be published: describes something unsafe.');\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
  const t2 = session(asMember(b.r.claims, `select api.record_decision('${b.s.submissionId}', '${b.s.hash}', 'PUBLISH', null, null, null);`), LATE);
  const [, rb] = await Promise.all([t1, t2]);
  ok(/approval_blocked/.test(rb.err) && rb.ms >= HOLD - LATE - 400, `approval vs prohibited assessment (took ${rb.ms} ms): ${rb.err.split('\n')[0]}`);
  // the other order: the approval commits first; a later revocation is just a newer record
  const c = await ready('X2 approve first');
  const u1 = session(asMember(c.r.claims, `begin;\nselect api.record_decision('${c.s.submissionId}', '${c.s.hash}', 'PUBLISH', null, null, null);\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
  const u2 = session(asMember(other.claims, `select api.record_rights_review('${c.s.submissionId}', '${c.s.hash}', 1, 'revoked', null, null, null);`), LATE);
  const [, rc] = await Promise.all([u1, u2]);
  ok(/"rights_review_id"/.test(rc.out) && rc.ms >= HOLD - LATE - 400, `the revocation should wait for the approval transaction and then record (took ${rc.ms} ms): ${rc.err.split('\n')[0]}`);
  const order = owner(`select (select max(decided_at) from app.moderation_decisions where submission_id = '${c.s.submissionId}') < (select max(reviewed_at) from app.rights_reviews where submission_id = '${c.s.submissionId}' and status = 'revoked');`);
  ok(last(order) === 't', 'the revocation is recorded AFTER the approval, as an unambiguous later fact');
  return `approval vs revocation: waited ${r2.ms} ms -> approval_blocked, no decision; approval vs prohibited: waited ${rb.ms} ms -> blocked; approval first: revocation waited ${rc.ms} ms and is the later record`;
});

await check('X3', 'many reviewers across many submissions: no deadlock, every history is one linear chain bound to its hash', async () => {
  const subs = [];
  for (let i = 0; i < 4; i++) subs.push(await ready(`X3 ${i}`));
  const extra = [await staff(), await staff()];
  const sessions = [];
  for (const { r, s } of subs) {
    for (const who of [r, ...extra]) {
      sessions.push(session(asMember(who.claims, `select api.record_risk_assessment('${s.submissionId}', '${s.hash}', 'low', 'Re-assessed during the stress run.');\nselect api.record_decision('${s.submissionId}', '${s.hash}', 'HOLD', array['other'], null, null);\nselect api.record_rights_review('${s.submissionId}', '${s.hash}', 1, 'needs_evidence', null, null, null);`), Math.floor(Math.random() * 300)));
    }
  }
  const runs = await Promise.all(sessions);
  ok(!runs.some((x) => /deadlock/i.test(x.err)), 'a deadlock occurred');
  for (const { s } of subs) {
    ok(historyOk(s.submissionId), `history of ${s.submissionId} is not a linear chain`);
    ok(last(owner(`select count(*) from app.moderation_decisions where submission_id = '${s.submissionId}';`)) === '1', 'exactly one HOLD may win per submission');
  }
  const bad = last(owner(`select count(*) from app.moderation_decisions d join app.submissions s on s.id = d.submission_id where d.content_hash <> s.content_hash;`));
  ok(bad === '0', 'a decision is bound to a different hash than its submission');
  return `${runs.length} sessions over 4 submissions: no deadlock, one decision per submission, chains linear, all bound to their hash`;
});

await check('R3', 'F2-C1 rollback script (run after the F2-C2 rollback): removes the review tables, functions and schema, restores submissions, leaves F2-A/F2-B intact (rehearsed in a rolled-back transaction)', async () => {
  // F2-C2's tables and constraints reference F2-C1's, so its rollback runs first inside the same rehearsal transaction
  const downD2 = readFileSync(path.join(root, 'supabase/rollbacks/20261018090000_f2d2_down.sql'), 'utf8').replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '');
  const downD1 = downD2 + readFileSync(path.join(root, 'supabase/rollbacks/20261017090000_f2d1_down.sql'), 'utf8').replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '');
  const downC2 = downD1 + readFileSync(path.join(root, 'supabase/rollbacks/20261016090000_f2c2_down.sql'), 'utf8').replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '');
  const down = readFileSync(path.join(root, 'supabase/rollbacks/20261015090000_f2c1_down.sql'), 'utf8').replace(/^begin;\s*$/m, () => `begin;\n${downC2}`);
  const probe = `
select 'tables=' || count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r' and c.relname in ('version_assessments', 'rights_reviews', 'moderation_decisions');
select 'app_review=' || count(*) from pg_namespace where nspname = 'app_review';
select 'api=' || coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname in ('list_submissions_for_review', 'get_submission_for_review', 'start_review', 'record_risk_assessment', 'record_rights_review', 'record_decision');
select 'binding=' || count(*) from pg_constraint where conname = 'submissions_review_binding';
select 'ledger=' || count(*) from supabase_migrations.schema_migrations where version like '20261015%';
select 'f2ab=' || (to_regclass('app.submissions') is not null) || ',' || (to_regclass('app.hack_versions') is not null) || ',' || (to_regprocedure('api.submit_version(uuid,text)') is not null) || ',' || (to_regclass('app.accounts') is not null);
`;
  const before = psql(probe).out.replace(/\n/g, ' ');
  ok(/tables=3 app_review=1 api=get_submission_for_review,list_submissions_for_review,record_decision,record_rights_review,record_risk_assessment,start_review binding=1 ledger=3 f2ab=true,true,true,true/.test(before), `before: ${before}`);
  const after = psql(down.replace(/^commit;\s*$/m, () => `${probe}\nrollback;`)).out.replace(/\n/g, ' ');
  ok(/tables=0 app_review=0 api= binding=0 ledger=0 f2ab=true,true,true,true/.test(after), `after rollback: ${after}`);
  ok(psql(probe).out.replace(/\n/g, ' ') === before, 'the rehearsal must leave the database unchanged');
  return 'after the rollback script: 0 review tables, no app_review schema, no review functions, binding constraint gone, F2-A/F2-B intact; transaction rolled back, state restored';
});

const n = failed();
console.log(`\nF2-C1 review checks: ${n === 0 ? 'all passed' : `${n} FAILED`}`);
console.log('NOT run here (hosted only): the same checks against the hosted project and pooler; stale-MFA with real 15-minute-old tokens.');
process.exit(n ? 1 : 0);
