#!/usr/bin/env node
// F2-D1 checks against the REAL local Supabase stack: the restricted worker LOGIN (a real connection from a sibling container) and its documented privileges,
// parallel claims, lease epochs and replaced/expired leases, the publication-eligibility recheck end to end with real staff tokens, duplicate delivery,
// races between the recheck and review writes / superseding / manual withdrawal (in both orders), a mixed stress run with a deadlock check, and a rollback
// rehearsal.
// The races drive the recheck through the owner-only app_review.job_complete from psql (instant, in-container): the worker functions are thin wrappers that
// only add the login check, which W6/J2 exercise with the real worker connection.
// Run through `npm run db:test:auth`, or with the stack up:  node --conditions=react-server scripts/local-f2d1-checks.mjs
// Prints facts and PASS/FAIL only. Exit 0 all passed, 1 a check failed, 2 stack unreachable.
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_CONTAINER, DOCKER, NETWORK, SUPABASE, asMember, asOwner, confirmedSession, createRunner, decode, elevateToAal2, ok, psql, rpc, session } from './lib/local-stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, failed } = createRunner();
const api = (name, token, args) => rpc('api', name, token, args);
const msg = (r) => r.body?.message;
const owner = (sqlText) => psql(`set role hackass_owner;\n${sqlText}`).out;
const last = (t) => t.split('\n').pop();

const stamp = randomBytes(3).toString('hex');
let slugN = 0;
const slug = () => `f2d1-${stamp}-${++slugN}`;
owner(`insert into app.categories (slug, name) values ('f2d1-${stamp}', 'F2D1 ${stamp}') on conflict do nothing;`);
const doc = (title) => ({
  category_slug: `f2d1-${stamp}`, title, summary: 'Store cut herbs upright in water.', outcome: 'Crisp herbs for two weeks.', difficulty: 'easy', steps: ['Trim the stems.'],
  attributions: [{ role: 'author', external_name: 'A. Cook' }], source_claims: [{ kind: 'original_work' }],
});
const isoDay = (plus) => new Date(Date.now() + plus * 86_400_000).toISOString().slice(0, 10);

async function submission(title, { member = null, hackId = null } = {}) {
  const m = member ?? await confirmedSession();
  const t = m.session?.access_token ?? m.token;
  const created = await api('create_draft', t, hackId ? { p_hack_id: hackId } : {});
  ok(created.status === 200, `fixture create_draft: HTTP ${created.status} ${msg(created)}`);
  const saved = await api('save_draft', t, { p_version_id: created.body.version_id, p_content: doc(title) });
  ok(saved.status === 200, `fixture save_draft: HTTP ${saved.status}`);
  const sub = await api('submit_version', t, { p_version_id: created.body.version_id, p_expected_hash: saved.body.content_hash });
  ok(sub.status === 200, `fixture submit: HTTP ${sub.status}`);
  return { ...m, token: t, hackId: created.body.hack_id, versionId: created.body.version_id, submissionId: sub.body.submission_id, hash: saved.body.content_hash };
}
async function staff(role = 'reviewer') {
  const m = await confirmedSession();
  owner(`insert into app.staff_assignments (user_id, role, granted_by) values ('${m.userId}', '${role}', 'check');`);
  const t2 = await elevateToAal2(m.c);
  return { ...m, token: t2, claims: decode(t2).claims };
}
const rev = (s, extra = {}) => ({ p_submission_id: s.submissionId, p_expected_hash: s.hash, ...extra });
/** A submission reviewed to an approving PUBLISH decision, its single claim cleared with the given expiry (default: 10 days out), then published. */
async function published(title, { reviewer = null, expiresIn = 10, member = null, hackId = null, sl = undefined } = {}) {
  const r = reviewer ?? await staff();
  const s = await submission(title, { member, hackId });
  ok((await api('start_review', r.token, rev(s))).status === 200, 'fixture start_review');
  ok((await api('record_risk_assessment', r.token, rev(s, { p_risk_class: 'low', p_rationale: 'Ordinary household tip, no hazard.' }))).status === 200, 'fixture assessment');
  ok((await api('record_rights_review', r.token, rev(s, { p_claim_no: 1, p_status: 'clear', p_basis_code: 'staff_original_check', p_evidence_note: 'Checked the original thoroughly.', p_expires_on: expiresIn === null ? null : isoDay(expiresIn) }))).status === 200, 'fixture rights review');
  const d = await api('record_decision', r.token, rev(s, { p_decision: 'PUBLISH', p_reason_codes: null, p_note: null, p_expected_prior_decision_id: null }));
  ok(d.status === 200, `fixture decision: HTTP ${d.status} ${msg(d)}`);
  const p = await api('publish_version', r.token, rev(s, { p_expected_decision_id: d.body.decision_id, p_slug: hackId ? null : (sl ?? slug()) }));
  ok(p.status === 200, `fixture publish: HTTP ${p.status} ${msg(p)} ${JSON.stringify(p.body?.details ?? '')}`);
  return { r, s, d: d.body.decision_id, pub: p.body.publication_id };
}
/** Rights lapse by the calendar alone: only time passes, no review is written. */
const lapse = (s) => owner(`alter table app.rights_reviews disable trigger rights_reviews_append_only;\nupdate app.rights_reviews set expires_on = current_date - 1 where id = any (app_review.effective_rights('${s.submissionId}'));\nalter table app.rights_reviews enable trigger rights_reviews_append_only;`);
const due = (pub) => owner(`update app.jobs set available_at = now() - interval '1 minute' where target_publication_id = '${pub}' and status = 'queued';`);
const jobOf = (pub, status = null) => last(owner(`select id from app.jobs where target_publication_id = '${pub}' ${status ? `and status = '${status}'` : ''} order by created_at desc limit 1;`));
const pointer = (hackId) => last(owner(`select coalesce(current_publication_id::text, 'none') from app.hacks where id = '${hackId}';`));
const wdRow = (pub) => last(owner(`select coalesce((select cause || '|' || coalesce(trigger_table, '-') from app.publication_withdrawals where publication_id = '${pub}'), 'none');`));
const nWd = (pub) => Number(last(owner(`select count(*) from app.publication_withdrawals where publication_id = '${pub}';`)));
const HOLD = 3000, LATE = 1000;

// ---- the real worker login -----------------------------------------------------------------------------------------------------------------
const workerPw = randomBytes(18).toString('base64url');
psql(`alter role hackass_worker password '${workerPw}'`);
const image = spawnSync(DOCKER, ['inspect', DB_CONTAINER, '--format', '{{.Config.Image}}'], { encoding: 'utf8' }).stdout.trim();
const workerArgs = ['run', '--rm', '-i', '-e', `PGPASSWORD=${workerPw}`, '--network', NETWORK, image, 'psql', '-h', DB_CONTAINER, '-U', 'hackass_worker', '-d', 'postgres', '-v', 'ON_ERROR_STOP=0', '-At', '-X'];
function asWorker(sqlText) {
  const r = spawnSync(DOCKER, workerArgs, { input: sqlText, encoding: 'utf8', timeout: 90_000 });
  return { out: r.stdout.trim(), err: r.stderr.trim() };
}
/** Asynchronous real worker session (for parallel workers). */
function workerSession(sqlText, delayMs = 0) {
  return new Promise((resolve) => setTimeout(() => {
    const t0 = Date.now(); const p = spawn(DOCKER, workerArgs, { stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => resolve({ out: out.trim(), err: err.trim(), ms: Date.now() - t0 })); p.stdin.end(sqlText);
  }, delayMs));
}
const claimSql = `select 'CLAIM:' || coalesce(worker.claim_job('publication_recheck')::text, 'none');`;
const parseClaim = (r) => { const l = r.out.split('\n').find((x) => x.startsWith('CLAIM:')); return !l || l === 'CLAIM:none' ? null : JSON.parse(l.slice(6)); };

await check('W6', 'the real worker login: EXECUTE on the five job functions and the health check, nothing else (no table, no api/guard/internal function, no role change)', async () => {
  const ok5 = [`select 'a=' || coalesce(worker.claim_job('publication_recheck')::text, 'none');`, `select 'health=' || worker.healthcheck();`];
  const denied = [
    ...['select count(*) from app.jobs;', 'insert into app.jobs default values;', 'update app.jobs set status = \'queued\';', 'delete from app.jobs;', 'truncate app.jobs;', 'select count(*) from app.publications;', 'select count(*) from app.hacks;', 'select count(*) from app.publication_withdrawals;'],
    `select app_review.job_claim('publication_recheck');`, `select app_review.job_complete(gen_random_uuid(), 1);`, `select app_review.job_ensure_recheck(null);`, `select app_review.publication_blockers(gen_random_uuid(), gen_random_uuid());`,
    `select api.publish_version(gen_random_uuid(), '${'a'.repeat(64)}', gen_random_uuid(), 'x');`, `select api.withdraw_publication(gen_random_uuid(), 'other', null);`, `select app_guard.require_member();`,
    'set role hackass_owner;', 'set role postgres;', 'create table public.zz_worker_probe (id int);',
  ];
  const bogus = [`select 'hb=' || (worker.heartbeat_job(gen_random_uuid(), 1))::text;`, `select 'sub=' || (worker.get_job_subject(gen_random_uuid(), 1))::text;`, `select 'cmp=' || (worker.complete_job(gen_random_uuid(), 1))::text;`, `select 'fail=' || (worker.fail_job(gen_random_uuid(), 1, 'transient'))::text;`];
  const r = asWorker([...ok5, ...denied, ...bogus].join('\n'));
  const errs = r.err.split('\n').filter((l) => /ERROR/.test(l));
  ok(r.out.includes('health=ok') && r.out.split('\n').some((l) => l.startsWith('a=')), `the worker could not call its documented functions: ${r.out} / ${r.err.split('\n')[0]}`);
  const priv = errs.filter((e) => /permission denied|permission to set role|must be member of role/i.test(e));
  const lost = errs.filter((e) => /lease_lost/.test(e));
  ok(priv.length === denied.length, `expected ${denied.length} privilege refusals, got ${priv.length} of ${errs.length} errors: ${errs.map((e) => e.slice(0, 70)).join(' | ')}`);
  ok(lost.length === 4 && errs.length === denied.length + 4, `the four job functions must answer lease_lost for an unknown job (got ${lost.length}); ${errs.length} errors in all`);
  const tp = last(psql(`select count(*) from information_schema.role_table_grants where grantee = 'hackass_worker';`).out);
  const fp = psql(`select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p where has_function_privilege('hackass_worker', p.oid, 'execute') and p.pronamespace::regnamespace::text in ('worker', 'api', 'app_review', 'app_guard', 'app_content', 'app_bridge');`).out;
  ok(tp === '0', `the worker holds ${tp} table grants`);
  ok(fp === 'worker.claim_job(text), worker.complete_job(uuid,bigint), worker.fail_job(uuid,bigint,text), worker.get_job_subject(uuid,bigint), worker.healthcheck(), worker.heartbeat_job(uuid,bigint)', `unexpected worker EXECUTE grants: ${fp}`);
  return `${denied.length} protected statements refused with permission denied; the 4 job functions answer lease_lost (not a privilege error) for an unknown job; 0 table grants; EXECUTE = exactly the 5 job functions + healthcheck`;
});

await check('J1', 'parallel real workers cannot claim the same active lease: 8 workers racing for 1 job, then 12 workers for 6 jobs', async () => {
  const a = await published('J1 single');
  due(a.pub);
  const runs = await Promise.all(Array.from({ length: 8 }, () => workerSession(claimSql)));
  const got = runs.map(parseClaim).filter(Boolean);
  ok(got.length === 1 && got[0].lease_epoch === 1 && got[0].job_type === 'publication_recheck', `expected exactly 1 claim at epoch 1, got ${got.length}: ${runs.map((x) => x.err.split('\n')[0] || x.out).slice(0, 3).join(' | ')}`);
  ok(last(owner(`select status || '/' || lease_epoch from app.jobs where id = '${got[0].job_id}';`)) === 'leased/1', 'the job is leased once');
  // a worker holding a claim open in a transaction must not make another worker wait: it skips the locked row and takes the next due job
  owner(`update app.jobs set available_at = now() + interval '1 day' where status = 'queued';`);
  const h1 = await published('J1 hold 1'), h2 = await published('J1 hold 2');
  due(h1.pub); due(h2.pub);
  const holdA = workerSession(`begin;\n${claimSql}\nselect pg_sleep(5);\ncommit;`);
  const claimB = workerSession(claimSql, 1800);
  const [ra, rb] = await Promise.all([holdA, claimB]);
  const ca = parseClaim(ra), cb = parseClaim(rb);
  ok(ca && cb && ca.job_id !== cb.job_id && rb.ms < 3000, `the second worker must take the other job without waiting for the first worker's open transaction (took ${rb.ms} ms): ${JSON.stringify(cb)}`);
  const skipMs = rb.ms;
  // 6 jobs, 12 workers: each job claimed exactly once. Drain anything else that is due first so the count is exact.
  owner(`update app.jobs set available_at = now() + interval '1 day' where status = 'queued';`);
  const pubs = [];
  for (let i = 0; i < 6; i++) pubs.push(await published(`J1 multi ${i}`));
  for (const x of pubs) due(x.pub);
  const runs2 = await Promise.all(Array.from({ length: 12 }, () => workerSession(claimSql)));
  const got2 = runs2.map(parseClaim).filter(Boolean);
  ok(got2.length === 6 && new Set(got2.map((g) => g.job_id)).size === 6 && got2.every((g) => g.lease_epoch === 1), `expected 6 distinct claims at epoch 1, got ${got2.length} (${new Set(got2.map((g) => g.job_id)).size} distinct)`);
  ok(last(owner(`select count(*) from app.jobs where status = 'leased' and lease_epoch > 1;`)) === '0', 'no job was leased twice');
  return `8 simultaneous worker logins -> 1 claim (epoch 1), 7 empty; a worker with an open claim transaction does not delay another (${skipMs} ms, other job taken); 12 workers over 6 due jobs -> 6 distinct claims, each epoch 1, none twice; no blocking (SKIP LOCKED)`;
});

await check('J2', 'a reclaimed job rejects every operation from the earlier epoch; an expired lease fails closed; concurrent duplicate completions apply once', async () => {
  const a = await published('J2 epoch');
  lapse(a.s);
  due(a.pub);
  owner(`update app.jobs set available_at = now() + interval '1 day' where status = 'queued' and target_publication_id <> '${a.pub}';`);
  const c1 = parseClaim(asWorker(claimSql));
  ok(c1 && c1.lease_epoch === 1, 'worker A claims at epoch 1');
  // A's subject is the allowlist
  const sub = asWorker(`select 'S=' || (worker.get_job_subject('${c1.job_id}', 1))::text;`);
  const keys = Object.keys(JSON.parse(sub.out.replace(/^S=/, ''))).sort().join(',');
  ok(keys === 'hack_id,is_current,job_id,job_type,lease_epoch,next_rights_expiry,publication_id,version_id', `subject keys: ${keys}`);
  // A's lease expires unanswered; B reclaims
  owner(`update app.jobs set lease_expires_at = now() - interval '1 second' where id = '${c1.job_id}';`);
  const lateA = asWorker(`select worker.heartbeat_job('${c1.job_id}', 1);\nselect worker.get_job_subject('${c1.job_id}', 1);\nselect worker.fail_job('${c1.job_id}', 1, 'transient');\nselect worker.complete_job('${c1.job_id}', 1);`);
  ok((lateA.err.match(/lease_lost/g) ?? []).length === 4, `an EXPIRED lease must fail closed on all four operations: ${lateA.err.slice(0, 200)}`);
  ok(pointer(a.s.hackId) === a.pub, 'and the failed completion changed nothing');
  const c2 = parseClaim(asWorker(claimSql));
  ok(c2 && c2.job_id === c1.job_id && c2.lease_epoch === 2 && c2.attempt === 2, `B reclaims at epoch 2: ${JSON.stringify(c2)}`);
  const stale = asWorker(`select worker.heartbeat_job('${c1.job_id}', 1);\nselect worker.get_job_subject('${c1.job_id}', 1);\nselect worker.fail_job('${c1.job_id}', 1, 'transient');\nselect worker.complete_job('${c1.job_id}', 1);`);
  ok((stale.err.match(/lease_lost/g) ?? []).length === 4 && pointer(a.s.hackId) === a.pub, `epoch 1 must be dead after the reclaim: ${stale.err.slice(0, 200)}`);
  ok(last(owner(`select status || '/' || lease_epoch || '/' || retry_count from app.jobs where id = '${c1.job_id}';`)) === 'leased/2/1', 'and the job is untouched by A');
  // six simultaneous completions of epoch 2: exactly one applies
  const runs = await Promise.all(Array.from({ length: 6 }, () => workerSession(`select 'DONE:' || (worker.complete_job('${c1.job_id}', 2))::text;`)));
  const done = runs.filter((x) => x.out.includes('DONE:'));
  ok(done.length === 1 && /"outcome": "withdrawn"/.test(done[0].out), `exactly one completion may apply, got ${done.length}: ${runs.map((x) => x.err.split('\n')[0]).filter(Boolean).slice(0, 2).join(' | ')}`);
  ok(runs.filter((x) => /lease_lost/.test(x.err)).length === 5, 'the other five are refused with lease_lost');
  ok(pointer(a.s.hackId) === 'none' && nWd(a.pub) === 1 && wdRow(a.pub) === 'recheck|jobs', `one withdrawal, cause recheck: ${wdRow(a.pub)} x${nWd(a.pub)}`);
  const again = asWorker(`select worker.complete_job('${c1.job_id}', 2);`);
  ok(/lease_lost/.test(again.err), 'a later replay of the finished job is refused too');
  return 'A: expired lease -> heartbeat/subject/fail/complete all lease_lost; B reclaims (epoch 2, attempt 2); A at epoch 1 -> all four lease_lost; 6 simultaneous completes at epoch 2 -> 1 applied, 5 lease_lost, exactly 1 withdrawal row (cause recheck); replay refused';
});

await check('J3', 'end to end with real tokens: rights lapse by the calendar, the worker rechecks and withdraws, history is kept, nothing restores the pointer', async () => {
  const a = await published('J3 lapse');
  const before = await api('get_publication', a.r.token, { p_publication_id: a.pub });
  ok(before.status === 200 && before.body.is_current === true, 'published and current');
  const jobId = jobOf(a.pub, 'queued');
  const sched = owner(`select (available_at = (((current_date + 11)::timestamp) at time zone 'UTC'))::text from app.jobs where id = '${jobId}';`);
  ok(last(sched) === 'true', `a recheck was scheduled for the day after the expiry when the version was published (got ${JSON.stringify(sched)} for job ${jobId})`);
  lapse(a.s);
  ok(pointer(a.s.hackId) === a.pub, 'the calendar alone does not change the publication');
  due(a.pub);
  owner(`update app.jobs set available_at = now() + interval '1 day' where status = 'queued' and target_publication_id <> '${a.pub}';`);
  const c = parseClaim(asWorker(claimSql));
  ok(c && c.job_id === jobId, 'the worker claims it');
  const done = asWorker(`select 'DONE:' || (worker.complete_job('${c.job_id}', ${c.lease_epoch}))::text;`);
  ok(/"outcome": "withdrawn"/.test(done.out), `complete: ${done.out} ${done.err.slice(0, 120)}`);
  const after = await api('get_publication', a.r.token, { p_publication_id: a.pub });
  ok(after.body.is_current === false && after.body.withdrawal.cause === 'recheck' && after.body.withdrawal.trigger_table === 'jobs' && after.body.withdrawal.trigger_id === c.job_id && after.body.withdrawal.withdrawn_by === null && after.body.withdrawal.blockers.join() === 'rights_not_clear:1', `withdrawal: ${JSON.stringify(after.body.withdrawal)}`);
  ok(after.body.snapshot_hash === before.body.snapshot_hash && after.body.snapshot_text === before.body.snapshot_text, 'the publication record and snapshot are untouched');
  ok(last(owner(`select state from app.version_lifecycle where version_id = '${a.s.versionId}';`)) === 'under_review', 'the version is back under review');
  // duplicate delivery of the same finished job and a brand-new duplicate job: both are no-ops
  const replay = asWorker(`select worker.complete_job('${c.job_id}', ${c.lease_epoch});`);
  ok(/lease_lost/.test(replay.err), 'replay of the finished job is refused');
  owner(`insert into app.jobs (job_type, target_publication_id, available_at) values ('publication_recheck', '${a.pub}', now() - interval '1 minute');`);
  const c2 = parseClaim(asWorker(claimSql));
  const dup = asWorker(`select 'DONE:' || (worker.complete_job('${c2.job_id}', ${c2.lease_epoch}))::text;`);
  ok(/"outcome": "not_current"/.test(dup.out), `duplicate job: ${dup.out}`);
  ok(pointer(a.s.hackId) === 'none' && nWd(a.pub) === 1, 'the pointer stays cleared and the history has one withdrawal');
  // the staff fix and republish; the old publication's stale jobs never touch the new one
  const ev = await api('record_rights_review', a.r.token, rev(a.s, { p_claim_no: 1, p_status: 'clear', p_basis_code: 'staff_original_check', p_evidence_note: 'Re-cleared after the lapse.', p_expires_on: isoDay(60) }));
  const dec = await api('record_decision', a.r.token, rev(a.s, { p_decision: 'PUBLISH', p_reason_codes: null, p_note: null, p_expected_prior_decision_id: a.d }));
  const p2 = await api('publish_version', a.r.token, rev(a.s, { p_expected_decision_id: dec.body.decision_id, p_slug: null }));
  ok(ev.status === 200 && dec.status === 200 && p2.status === 200 && p2.body.publication_id !== a.pub, `republish: ${ev.status}/${dec.status}/${p2.status} ${msg(p2) ?? ''}`);
  owner(`insert into app.jobs (job_type, target_publication_id, available_at) values ('publication_recheck', '${a.pub}', now() - interval '1 minute');`);
  owner(`update app.jobs set available_at = now() + interval '1 day' where status = 'queued' and target_publication_id <> '${a.pub}';`);
  const c3 = parseClaim(asWorker(claimSql));
  const stale = asWorker(`select 'DONE:' || (worker.complete_job('${c3.job_id}', ${c3.lease_epoch}))::text;`);
  ok(/"outcome": "not_current"/.test(stale.out) && pointer(a.s.hackId) === p2.body.publication_id, `stale job for the old publication: ${stale.out}; pointer ${pointer(a.s.hackId)}`);
  return 'scheduled at expiry+1d; calendar alone changes nothing; worker complete -> withdrawn (cause recheck, jobs, this job id, no staff actor, blocker rights_not_clear:1), snapshot unchanged, version under_review; replay and duplicate job -> refused / not_current, still 1 withdrawal; after a staff fix and republish, the old publication\'s job leaves the new one current';
});

await check('J4', 'the recheck racing review writes, a superseding publish and a manual withdrawal (both orders): always consistent, never a second withdrawal, never an ineligible current publication', async () => {
  const notes = [];
  const complete = (id, ep) => `select app_review.job_complete('${id}', ${ep});`;
  const lease = (pub) => { // make the job due and lease it directly as the owner (the race is about the effect, not the claim)
    due(pub);
    owner(`update app.jobs set available_at = now() + interval '1 day' where status = 'queued' and target_publication_id <> '${pub}';`);
    const c = JSON.parse(last(owner(`select app_review.job_claim('publication_recheck')::text;`)));
    ok(c && c.lease_epoch >= 1, 'fixture lease'); return c;
  };
  const other = await staff();
  // 0. someone holding only the protocol's first two locks (submission, hack) makes the recheck wait: they are what serializes it with review writes and publishes
  {
    const a = await published('J4 protocol locks'); lapse(a.s); const c = lease(a.pub);
    const hold = session(asOwner(`begin;\nselect app_review.lock_submission('${a.s.submissionId}');\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
    const late = session(asOwner(complete(c.job_id, c.lease_epoch)), LATE);
    const [, r] = await Promise.all([hold, late]);
    ok(/withdrawn/.test(r.out) && r.ms >= HOLD - LATE - 400, `the recheck must wait for the submission/hack locks (took ${r.ms} ms): ${r.out} ${r.err.split('\n')[0]}`);
    notes.push(`submission+hack lock held: recheck waited ${r.ms} ms, then withdrew`);
  }
  // 0a. the lease EXPIRES while the completion waits for a lock: the transaction began before the expiry, so now() would still call the lease good.
  // The lease is judged with the wall clock after the locks are held: lease_lost, and the lapsed publication is NOT withdrawn by this stale completion.
  {
    const a = await published('J4 expiry during lock wait'); lapse(a.s); const c = lease(a.pub);
    owner(`update app.jobs set lease_expires_at = clock_timestamp() + interval '2 seconds' where id = '${c.job_id}';`);
    const hold = session(asOwner(`begin;\nselect app_review.lock_submission('${a.s.submissionId}');\nselect pg_sleep(${HOLD / 1000 + 1});\ncommit;`));
    const late = session(asOwner(complete(c.job_id, c.lease_epoch)), 500);
    const [, r] = await Promise.all([hold, late]);
    ok(/lease_lost/.test(r.err) && !/withdrawn/.test(r.out) && r.ms >= 2500, `a completion that waited past its lease expiry must fail with lease_lost (took ${r.ms} ms): ${r.err.split('\n')[0]} ${r.out}`);
    ok(pointer(a.s.hackId) === a.pub && nWd(a.pub) === 0, 'and must have no withdrawal effect');
    // recovery: the job is reclaimed (epoch + 1) and the new lease does withdraw
    const c2 = JSON.parse(last(owner(`select app_review.job_claim('publication_recheck')::text;`)));
    ok(c2 && c2.job_id === c.job_id && c2.lease_epoch === c.lease_epoch + 1, `the expired job is reclaimable: ${JSON.stringify(c2)}`);
    ok(/withdrawn/.test(last(owner(`select app_review.job_complete('${c2.job_id}', ${c2.lease_epoch});`))) && nWd(a.pub) === 1, 'and the fresh lease withdraws it');
    notes.push(`lease expired while the completion waited ${r.ms} ms for a lock: lease_lost, no withdrawal; the reclaimed job then withdraws`);
  }
  // 0b. the protocol's ORDER matters: a publisher-style transaction takes submission+hack and only LATER the lifecycle row. A recheck that took the lifecycle row
  // first (skipping steps 1-2) would deadlock with it; with the protocol the recheck simply queues behind the first lock.
  {
    const a = await published('J4 lock order'); lapse(a.s); const c = lease(a.pub);
    const hold = session(asOwner(`begin;\nselect app_review.lock_submission('${a.s.submissionId}');\nselect pg_sleep(1.5);\nselect 1 from app.version_lifecycle where version_id = '${a.s.versionId}' for update;\nselect pg_sleep(1);\ncommit;`));
    const late = session(asOwner(complete(c.job_id, c.lease_epoch)), 500);
    const [h, r] = await Promise.all([hold, late]);
    ok(!/deadlock/i.test(h.err + r.err) && /withdrawn/.test(r.out) && !/ERROR/.test(h.err), `no deadlock, and the recheck completes after the first transaction: holder=${h.err.split('\n')[0]} recheck=${r.err.split('\n')[0]} ${r.out}`);
    notes.push(`publisher-style lock order (submission+hack, then lifecycle) vs recheck: no deadlock, recheck waited ${r.ms} ms`);
  }
  // 1. review write (rights revocation) first: the recheck waits, then finds nothing current
  {
    const a = await published('J4 revoke first'); lapse(a.s); const c = lease(a.pub);
    const hold = session(asMember(other.claims, `begin;\nselect api.record_rights_review('${a.s.submissionId}', '${a.s.hash}', 1, 'revoked', null, null, null);\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
    const late = session(asOwner(complete(c.job_id, c.lease_epoch)), LATE);
    const [, r] = await Promise.all([hold, late]);
    ok(/not_current/.test(r.out) && r.ms >= HOLD - LATE - 400, `the recheck must wait for the review write and find nothing current (took ${r.ms} ms): ${r.out} ${r.err.split('\n')[0]}`);
    ok(wdRow(a.pub) === 'review_change|rights_reviews' && nWd(a.pub) === 1, `withdrawn once, by the review write: ${wdRow(a.pub)}`);
    notes.push(`revocation first: recheck waited ${r.ms} ms -> not_current, 1 withdrawal (review_change)`);
  }
  // 2. recheck first: the review write waits, then records; the publication was already withdrawn by the recheck
  {
    const a = await published('J4 recheck first'); lapse(a.s); const c = lease(a.pub);
    const hold = session(asOwner(`begin;\n${complete(c.job_id, c.lease_epoch)}\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
    const late = session(asMember(other.claims, `select api.record_rights_review('${a.s.submissionId}', '${a.s.hash}', 1, 'revoked', null, null, null);`), LATE);
    const [, r] = await Promise.all([hold, late]);
    ok(/"rights_review_id"/.test(r.out) && r.ms >= HOLD - LATE - 400, `the review write must wait for the recheck and then record (took ${r.ms} ms): ${r.err.split('\n')[0]}`);
    ok(wdRow(a.pub) === 'recheck|jobs' && nWd(a.pub) === 1 && pointer(a.s.hackId) === 'none', `withdrawn once, by the recheck: ${wdRow(a.pub)}`);
    notes.push(`recheck first: review write waited ${r.ms} ms and recorded; 1 withdrawal (recheck)`);
  }
  // 3. manual withdrawal first / recheck first
  {
    const a = await published('J4 manual first'); lapse(a.s); const c = lease(a.pub);
    const hold = session(asMember(other.claims, `begin;\nselect api.withdraw_publication('${a.pub}', 'quality', null);\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
    const late = session(asOwner(complete(c.job_id, c.lease_epoch)), LATE);
    const [, r] = await Promise.all([hold, late]);
    ok(/not_current/.test(r.out) && r.ms >= HOLD - LATE - 400 && wdRow(a.pub) === 'staff|-' && nWd(a.pub) === 1, `manual first: ${r.ms} ms ${r.out} ${wdRow(a.pub)}`);
    const b = await published('J4 recheck before manual'); lapse(b.s); const c2 = lease(b.pub);
    const hold2 = session(asOwner(`begin;\n${complete(c2.job_id, c2.lease_epoch)}\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
    const late2 = session(asMember(other.claims, `select api.withdraw_publication('${b.pub}', 'quality', null);`), LATE);
    const [, r2] = await Promise.all([hold2, late2]);
    ok(/not_current/.test(r2.err) && r2.ms >= HOLD - LATE - 400 && wdRow(b.pub) === 'recheck|jobs' && nWd(b.pub) === 1, `recheck first: manual withdrawal must be refused as not current (took ${r2.ms} ms): ${r2.err.split('\n')[0]} ${wdRow(b.pub)}`);
    notes.push(`manual withdrawal vs recheck, both orders: ${r.ms} ms / ${r2.ms} ms waits, exactly 1 withdrawal each, no double history`);
  }
  // 4. superseding publish vs recheck: the old publication is not current once superseded; the new one is never harmed
  {
    const v1 = await published('J4 sup v1'); lapse(v1.s); const c = lease(v1.pub);
    const s2 = await submission('J4 sup v2', { member: v1.s, hackId: v1.s.hackId });
    await api('start_review', v1.r.token, rev(s2)); await api('record_risk_assessment', v1.r.token, rev(s2, { p_risk_class: 'low', p_rationale: 'Ordinary household tip, no hazard.' }));
    await api('record_rights_review', v1.r.token, rev(s2, { p_claim_no: 1, p_status: 'clear', p_basis_code: 'staff_original_check', p_evidence_note: 'Checked the original thoroughly.', p_expires_on: isoDay(40) }));
    const d2 = await api('record_decision', v1.r.token, rev(s2, { p_decision: 'PUBLISH', p_reason_codes: null, p_note: null, p_expected_prior_decision_id: null }));
    const hold = session(asMember(v1.r.claims, `begin;\nselect api.publish_version('${s2.submissionId}', '${s2.hash}', '${d2.body.decision_id}', null);\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
    const late = session(asOwner(complete(c.job_id, c.lease_epoch)), LATE);
    const [, r] = await Promise.all([hold, late]);
    const cur = pointer(v1.s.hackId);
    ok(/not_current/.test(r.out) && r.ms >= HOLD - LATE - 400 && wdRow(v1.pub) === 'superseded|-' && nWd(v1.pub) === 1 && cur !== 'none' && cur !== v1.pub, `superseding first: the recheck must find v1 not current (took ${r.ms} ms): ${r.out} ${wdRow(v1.pub)} cur=${cur}`);
    notes.push(`superseding publish first: recheck waited ${r.ms} ms -> not_current, v1 stays 'superseded', v2 current`);
    // the other order: recheck first (v1 lapsed -> withdrawn by recheck), then the publish of v2 sees no current publication to supersede
    const w1 = await published('J4 sup2 v1'); lapse(w1.s); const cc = lease(w1.pub);
    const t2 = await submission('J4 sup2 v2', { member: w1.s, hackId: w1.s.hackId });
    await api('start_review', w1.r.token, rev(t2)); await api('record_risk_assessment', w1.r.token, rev(t2, { p_risk_class: 'low', p_rationale: 'Ordinary household tip, no hazard.' }));
    await api('record_rights_review', w1.r.token, rev(t2, { p_claim_no: 1, p_status: 'clear', p_basis_code: 'staff_original_check', p_evidence_note: 'Checked the original thoroughly.', p_expires_on: isoDay(40) }));
    const e2 = await api('record_decision', w1.r.token, rev(t2, { p_decision: 'PUBLISH', p_reason_codes: null, p_note: null, p_expected_prior_decision_id: null }));
    const hold2 = session(asOwner(`begin;\n${complete(cc.job_id, cc.lease_epoch)}\nselect pg_sleep(${HOLD / 1000});\ncommit;`));
    const late2 = session(asMember(w1.r.claims, `select api.publish_version('${t2.submissionId}', '${t2.hash}', '${e2.body.decision_id}', null);`), LATE);
    const [, r2] = await Promise.all([hold2, late2]);
    ok(/"superseded_publication_id": null/.test(r2.out) && r2.ms >= HOLD - LATE - 400 && wdRow(w1.pub) === 'recheck|jobs' && nWd(w1.pub) === 1 && pointer(w1.s.hackId) !== 'none', `recheck first: the publish must wait and then supersede nothing (took ${r2.ms} ms): ${r2.out.slice(0, 120)} ${r2.err.split('\n')[0]}`);
    notes.push(`recheck first: superseding publish waited ${r2.ms} ms and superseded nothing; v1 withdrawn once (recheck), v2 current`);
  }
  const bad = last(owner(`select count(*) from app.hacks h where h.current_publication_id is not null and (exists (select 1 from app.publication_withdrawals w where w.publication_id = h.current_publication_id) or cardinality(app_review.publication_blockers((select submission_id from app.publications where id = h.current_publication_id), (select published_by from app.publications where id = h.current_publication_id))) > 0);`));
  ok(bad === '0', `${bad} hacks point at a withdrawn or ineligible publication`);
  ok(last(owner(`select count(*) from (select publication_id from app.publication_withdrawals group by 1 having count(*) > 1) x;`)) === '0', 'no publication has two withdrawals');
  return notes.join(' | ');
});

await check('J5', 'mixed stress: real workers, rechecks, staff review writes, withdrawals and republishing at once: no deadlock, every publication current-and-eligible or withdrawn exactly once', async () => {
  const other = await staff();
  const items = [];
  for (let i = 0; i < 6; i++) { const x = await published(`J5 ${i}`); lapse(x.s); due(x.pub); items.push(x); }
  owner(`update app.jobs set available_at = now() + interval '1 day' where status = 'queued' and target_publication_id not in (${items.map((x) => `'${x.pub}'`).join(',')});`);
  const jobs = [];
  for (const [i, x] of items.entries()) {
    jobs.push(workerSession(`with c as (select worker.claim_job('publication_recheck')::jsonb as j) select worker.complete_job((j ->> 'job_id')::uuid, (j ->> 'lease_epoch')::bigint) from c where j is not null;`));
    if (i % 2 === 0) jobs.push(session(asMember(other.claims, `select api.record_rights_review('${x.s.submissionId}', '${x.s.hash}', 1, 'revoked', null, null, null);`)));
    if (i % 3 === 0) jobs.push(session(asMember(other.claims, `select api.withdraw_publication('${x.pub}', 'quality', null);`)));
    jobs.push(session(asOwner(`select app_review.job_claim('publication_recheck');`)));
  }
  const runs = await Promise.all(jobs);
  ok(!runs.some((x) => /deadlock/i.test(x.err)), `a deadlock occurred: ${runs.find((x) => /deadlock/i.test(x.err))?.err}`);
  // finish whatever is leased through the owner path
  for (let k = 0; k < 4; k++) {
    owner(`do $x$ declare j record; begin for j in select id, lease_epoch from app.jobs where status = 'leased' and lease_expires_at > now() loop perform app_review.job_complete(j.id, j.lease_epoch); end loop; end $x$;`);
    owner(`update app.jobs set available_at = now() - interval '1 minute' where status = 'queued' and target_publication_id in (${items.map((x) => `'${x.pub}'`).join(',')});`);
    owner(`do $x$ declare c jsonb; begin loop c := app_review.job_claim('publication_recheck'); exit when c is null; end loop; end $x$;`);
  }
  const ids = items.map((x) => `'${x.pub}'`).join(',');
  ok(last(owner(`select count(*) from app.publications p where p.id in (${ids}) and not exists (select 1 from app.publication_withdrawals w where w.publication_id = p.id) and not exists (select 1 from app.hacks h where h.current_publication_id = p.id);`)) === '0', 'a publication is neither current nor withdrawn');
  ok(last(owner(`select count(*) from (select publication_id from app.publication_withdrawals where publication_id in (${ids}) group by 1 having count(*) > 1) x;`)) === '0', 'a publication was withdrawn twice');
  ok(last(owner(`select count(*) from app.hacks h where h.current_publication_id in (${ids});`)) === '0', 'every lapsed publication ended up withdrawn (the rights of all six lapsed)');
  ok(last(owner(`select count(*) from app.jobs j where j.status = 'succeeded' and j.outcome = 'withdrawn' and not exists (select 1 from app.publication_withdrawals w where w.trigger_id = j.id and w.cause = 'recheck');`)) === '0', 'every job that reports withdrawn has its recheck withdrawal row');
  const causes = owner(`select cause || ':' || count(*) from app.publication_withdrawals where publication_id in (${ids}) group by cause order by cause;`).replace(/\n/g, ' ');
  return `${runs.length} simultaneous operations (real workers, owner-path claims, staff revocations and withdrawals) over 6 lapsed publications: no deadlock; every publication withdrawn exactly once (${causes})`;
});

await check('T1', 'a session time zone cannot move the UTC rights-expiry boundary: input check, approval rule and the commit-time check all agree (zone chosen from the wall clock so the session date really differs from the UTC date)', async () => {
  const hour = new Date().getUTCHours();
  const ahead = hour >= 10;                                // UTC+14 is already "tomorrow" from 10:00 UTC; UTC-12 is still "yesterday" until 12:00 UTC
  const zone = ahead ? 'Pacific/Kiritimati' : 'Etc/GMT+12';
  const r = await staff();
  const s = await submission('T1 zone');
  ok((await api('start_review', r.token, rev(s))).status === 200 && (await api('record_risk_assessment', r.token, rev(s, { p_risk_class: 'low', p_rationale: 'Ordinary household tip, no hazard.' }))).status === 200, 'fixture review steps');
  const inZone = (body) => session(asMember(r.claims, `set timezone = '${zone}';\n${body}`));
  const review = (day) => `select api.record_rights_review('${s.submissionId}', '${s.hash}', 1, 'clear', 'staff_original_check', 'Checked the original thoroughly.', '${day}');`;
  let note;
  if (ahead) {
    // tomorrow (UTC) is the day AFTER the session's own idea of today: it must be accepted
    const x = await inZone(review(isoDay(1)));
    ok(/"rights_review_id"/.test(x.out), `an expiry of tomorrow (UTC) must be accepted from a UTC+14 session: ${x.err.split('\n')[0]} ${x.out}`);
    note = `session ${zone} (a day ahead): expiry tomorrow(UTC) accepted`;
  } else {
    const x = await inZone(review(isoDay(0)));
    ok(/expires_on/.test(x.err) && !/"rights_review_id"/.test(x.out), `an expiry of today (UTC) must be refused from a UTC-12 session: ${x.err.split('\n')[0]} ${x.out}`);
    ok((await inZone(review(isoDay(10)))).out.includes('rights_review_id'), 'a future expiry is accepted');
    note = `session ${zone} (a day behind): expiry today(UTC) refused`;
  }
  // the review now expires TODAY (UTC): still valid for the rest of the UTC day, whatever the session says
  owner(`alter table app.rights_reviews disable trigger rights_reviews_append_only;\nupdate app.rights_reviews set expires_on = (clock_timestamp() at time zone 'UTC')::date where id = any (app_review.effective_rights('${s.submissionId}'));\nalter table app.rights_reviews enable trigger rights_reviews_append_only;`);
  const d = await api('record_decision', r.token, rev(s, { p_decision: 'PUBLISH', p_reason_codes: null, p_note: null, p_expected_prior_decision_id: null }));
  ok(d.status === 200, `approval from a UTC session: HTTP ${d.status} ${msg(d)}`);
  // publish from the odd-zone session: its COMMIT runs the deferred snapshot check, which must also use the UTC day
  const p = await inZone(`select api.publish_version('${s.submissionId}', '${s.hash}', '${d.body.decision_id}', '${slug()}');`);
  ok(/"publication_id"/.test(p.out) && !/ERROR/.test(p.err), `publishing a review that expires today (UTC) from a ${zone} session must succeed and commit: ${p.err.split('\n')[0]} ${p.out}`);
  ok(pointer(s.hackId) !== 'none', 'and it is current');
  return `${note}; approval and publish (incl. the commit-time check) of a review expiring today(UTC) succeed from the ${zone} session`;
});

await check('R5', 'F2-D1 rollback script: removes the jobs table and the worker functions, restores the F2-C2 definitions, leaves F2-C2 and earlier intact; recheck withdrawal history is kept (rehearsed in a rolled-back transaction)', async () => {
  const down = readFileSync(path.join(root, 'supabase/rollbacks/20261017090000_f2d1_down.sql'), 'utf8');
  const probe = `
select 'jobs=' || count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relname = 'jobs';
select 'workerfns=' || coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p where p.pronamespace = 'worker'::regnamespace;
select 'jobfns=' || count(*) from pg_proc p where p.pronamespace = 'app_review'::regnamespace and p.proname like 'job\\_%' escape '\\';
select 'schedtrigger=' || count(*) from pg_trigger where tgname = 'publications_schedule_recheck';
select 'after_has_jobs=' || (select prosrc like '%job_ensure_recheck%' from pg_proc where oid = 'app_review.after_review_write()'::regprocedure);
select 'children_has_evidence=' || (select prosrc like '%evidence_note_hash is distinct from%' from pg_proc where oid = 'app_review.check_publication_children()'::regprocedure);
select 'ledger=' || count(*) from supabase_migrations.schema_migrations where version like '20261017%';
select 'c2=' || (to_regclass('app.publications') is not null) || ',' || (to_regclass('app.publication_withdrawals') is not null) || ',' || (to_regprocedure('api.publish_version(uuid,text,uuid,text)') is not null);
`;
  const before = psql(probe).out.replace(/\n/g, ' ');
  ok(/jobs=1 workerfns=claim_job,complete_job,fail_job,get_job_subject,healthcheck,heartbeat_job jobfns=9 schedtrigger=1 after_has_jobs=true children_has_evidence=true ledger=4 c2=true,true,true/.test(before), `before: ${before}`);
  const after = psql(down.replace(/^commit;\s*$/m, () => `${probe}\nrollback;`)).out.replace(/\n/g, ' ');
  ok(/jobs=0 workerfns=healthcheck jobfns=0 schedtrigger=0 after_has_jobs=false children_has_evidence=false ledger=0 c2=true,true,true/.test(after), `after rollback: ${after}`);
  ok(psql(probe).out.replace(/\n/g, ' ') === before, 'the rehearsal must leave the database unchanged');
  return 'after the rollback script: no jobs table, only worker.healthcheck, no job functions or schedule trigger, F2-C2 after_review_write and check_publication_children restored, F2-C2 intact; transaction rolled back, state restored';
});

await check('R6', 'rollback COMMITTED, then the migrations re-applied (supabase migration up) over the retained withdrawal history, then the recheck works again', async () => {
  // existing recheck-withdrawal history that the rollback must preserve
  const h = await published('R6 history'); lapse(h.s); due(h.pub);
  owner(`update app.jobs set available_at = now() + interval '1 day' where status = 'queued' and target_publication_id <> '${h.pub}';`);
  const c0 = parseClaim(asWorker(claimSql));
  ok(/"outcome": "withdrawn"/.test(asWorker(`select (worker.complete_job('${c0.job_id}', ${c0.lease_epoch}))::text;`).out), 'fixture: a recheck withdrawal exists');
  const count = () => last(owner(`select count(*) from app.publication_withdrawals where cause = 'recheck';`));
  const n0 = count(); ok(Number(n0) >= 1, 'recheck withdrawals exist');
  const snapshot = () => last(owner(`select md5(string_agg(publication_id::text || cause || coalesce(trigger_id::text, '') || array_to_string(blockers, ','), ',' order by publication_id)) from app.publication_withdrawals where cause = 'recheck';`));
  const hist0 = snapshot();
  const probe = () => psql(`select 'jobs=' || count(*) from pg_class where relname = 'jobs' and relnamespace = 'app'::regnamespace;
select 'ctr=' || (select count(*) from pg_constraint where conname in ('withdrawals_recheck_names_job', 'withdrawals_actor_unless_recheck', 'publication_withdrawals_cause_check', 'publication_withdrawals_trigger_table_check'));
select 'workerfns=' || (select count(*) from pg_proc where pronamespace = 'worker'::regnamespace);
select 'utc=' || count(*) from pg_proc where proname = 'utc_today';
select 'ledger=' || count(*) from supabase_migrations.schema_migrations where version like '20261017%';`).out.replace(/\n/g, ' ');
  ok(/jobs=1 ctr=4 workerfns=6 utc=1 ledger=4/.test(probe()), `before: ${probe()}`);
  // 1. committed rollback (psql as postgres, begin ... commit)
  const down = psql(readFileSync(path.join(root, 'supabase/rollbacks/20261017090000_f2d1_down.sql'), 'utf8'));
  ok(!/ERROR/.test(down.out + (down.err ?? '')), `rollback failed: ${down.out.slice(-300)}`);
  const mid = probe();
  ok(/jobs=0 ctr=4 workerfns=1 utc=0 ledger=0/.test(mid), `after the committed rollback the retained constraints must remain: ${mid}`);
  ok(count() === n0 && snapshot() === hist0, 'the recheck-withdrawal history is untouched by the rollback');
  // 2. re-apply with the real migration runner
  const up = spawnSync(SUPABASE, ['migration', 'up', '--local'], { cwd: root, encoding: 'utf8', timeout: 240_000 });
  ok(up.status === 0, `migration up failed (${up.status}): ${(up.stderr + up.stdout).slice(-500)}`);
  const end = probe();
  ok(/jobs=1 ctr=4 workerfns=6 utc=1 ledger=4/.test(end), `after re-application: ${end}`);
  ok(count() === n0 && snapshot() === hist0, 'the history is still exactly as it was');
  // 3. the re-applied code works: a fresh lapse is rechecked and withdrawn by the real worker
  psql(`alter role hackass_worker password '${workerPw}'`);
  const x = await published('R6 after reapply'); lapse(x.s); due(x.pub);
  owner(`update app.jobs set available_at = now() + interval '1 day' where status = 'queued' and target_publication_id <> '${x.pub}';`);
  const c1 = parseClaim(asWorker(claimSql));
  ok(c1 && /"outcome": "withdrawn"/.test(asWorker(`select (worker.complete_job('${c1.job_id}', ${c1.lease_epoch}))::text;`).out), 'the re-applied worker functions recheck and withdraw');
  ok(wdRow(x.pub) === 'recheck|jobs' && Number(count()) === Number(n0) + 1, 'with one more recheck withdrawal');
  return `${n0} recheck withdrawal(s) preserved (history hash unchanged) through a COMMITTED rollback and a supabase migration up re-application; retained constraints re-applied without error (4 present each time); worker functions, UTC helper and ledger (4) restored; a fresh recheck withdraws`;
});

const n = failed();
console.log(`\nF2-D1 job checks: ${n === 0 ? 'all passed' : `${n} FAILED`}`);
console.log('NOT run here (hosted only): the same checks against the hosted project and the pooler (worker login through Supavisor); a worker process (none exists yet: these calls are the worker contract); read-time expiry for public reads (a gate for the catalog slice).');
process.exit(n ? 1 : 0);
