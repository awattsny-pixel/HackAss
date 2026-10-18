#!/usr/bin/env node
// Authorization S8 (MUTATING): `worker-checks` = H9 (worker authentication and privileges through the pooler; read-only queries and expected refusals) and H10 (the worker job
// functions with an explicit, narrowly scoped synthetic job fixture). Needs the `fixtures` and `worker-marker` stages and the owner's worker password in the password file.
// Usage: node scripts/hosted/checks-worker.mjs --run-id=... --authorized=S8@<sha> --confirm-mutating=worker-checks [--profile=...]
import { runStage, checker, ok, EXCEPTED } from './lib/cli.mjs';
import { judgeUniformRefusal } from './lib/findings.mjs';
import { runSql, queryJson, queryText, wrongPasswordProbe } from './lib/pg.mjs';
import { signIn, steppedUp, doc, submit, approve, publish, api, errMsg } from './lib/flows.mjs';
import { PROBES, JOB_DUE_SQL } from './lib/sqlguard.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tomorrowUtc = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const SUBJECT_KEYS = ['hack_id', 'is_current', 'job_id', 'job_type', 'lease_epoch', 'next_rights_expiry', 'publication_id', 'version_id'];

const code = await runStage('worker-checks', process.argv.slice(2), async ({ ctx, run, flags, say }) => {
  const c = checker(run, say);
  const knownFinding = flags['known-finding'] ?? null; // an explicit, narrowly scoped exception (lib/findings.mjs); null = every check is strict
  const state = run.state(); const sec = run.secrets();
  let probed = null; const wrongPasswords = async () => (probed ??= await wrongPasswordProbe(ctx, run.dir));
  const ids = () => new Set(Object.values(state.fixtures.users).map((u) => u.id.toLowerCase()));

  await c.check('H9', 'the worker login authenticates through both pooler modes, has the documented defaults, can call healthcheck and is refused everything else', async () => {
    const notes = [];
    for (const ep of ['worker-txn', 'worker-session']) {
      const who = await queryText(ctx, ep, 'select current_user || \'|\' || session_user');
      ok(who === 'hackass_worker|hackass_worker', `${ep}: connected as ${who}`);
      const st = await queryText(ctx, ep, 'show statement_timeout'); const idle = await queryText(ctx, ep, 'show idle_in_transaction_session_timeout'); const sp = await queryText(ctx, ep, 'show search_path');
      ok(st === '30s' && idle === '30s' && (sp === '""' || sp === ''), `${ep}: role defaults are statement_timeout ${st}, idle_in_transaction ${idle}, search_path ${sp}`);
      const hc = await runSql(ctx, ep, 'select worker.healthcheck()', { kind: 'read' });
      ok(hc.ok && hc.stdout.length > 0, `${ep}: worker.healthcheck() failed: ${hc.stderr.split('\n')[0]}`);
      for (const p of PROBES) {
        const r = await runSql(ctx, ep, p, { kind: 'probe' });
        ok(!r.ok && /permission denied/i.test(r.stderr), `${ep}: "${p}" was not refused with permission denied (${r.ok ? 'it succeeded' : r.stderr.split('\n')[0]})`);
      }
      notes.push(`${ep}: defaults ${st}/${idle}/empty search_path, healthcheck ok, ${PROBES.length} probes refused`);
    }
    // a wrong password is refused for the worker login and for a nonexistent login (H9b below compares the two refusals). The probe has its own purpose-built function: it writes its own
    // placeholder password file and can name only exactly those two logins. It runs ONCE (2 failed connection attempts) and both checks use its result.
    const probe = await wrongPasswords();
    ok(!probe.real.ok && !probe.fake.ok, 'a wrong password was accepted');
    ok(/authentication failed|password/i.test(probe.real.stderr), `unexpected refusal text for the wrong password: ${probe.real.stderr.split('\n')[0]}`);
    return notes.join(' | ') + ' | wrong password refused for the real login and for a nonexistent login';
  });

  await c.check('H9b', 'the refusal of a wrong password is the same for the worker login and for a nonexistent login (no existence oracle)', async () => {
    const probe = await wrongPasswords();
    const v = judgeUniformRefusal({ real: probe.real, fake: probe.fake, knownFinding });
    if (v.status === 'PASS') return 'the two refusals are identical after normalisation';
    if (v.status === 'EXCEPTION') {
      c.exception('H9b', 'the refusal of a wrong password is the same for the worker login and for a nonexistent login (no existence oracle)', { finding: knownFinding, error: `the refusals differ (open finding ${knownFinding}): real login: ${v.real} | nonexistent login: ${v.fake}`, facts: { real: v.real, fake: v.fake, endpoint: 'worker-txn' } });
      return EXCEPTED;
    }
    throw new Error(`${v.error}${v.real || v.fake ? ` | real login: ${v.real} | nonexistent login: ${v.fake}` : ''}`);
  });

  await c.check('H10', 'a recheck job is made due by one scoped update and then claimed, read, extended and completed by the worker through transaction mode; replays are refused', async () => {
    const b1 = await signIn(ctx, state.fixtures.users.b1.email, sec.users.b1.password);
    const rev = await steppedUp(ctx, run, 's-rev');
    const category = state.fixtures.category;
    const s = await submit(ctx, b1.access_token, doc(category, 'H10 job fixture'));
    const decision = await approve(ctx, rev.access_token, s, { expiresOn: tomorrowUtc() });
    const slug = `stg-${run.runId}-j`;
    const pub = await publish(ctx, rev.access_token, s, decision, slug);
    ok(UUID.test(pub.publication_id), 'no publication id');
    const owner = (sql) => `set role hackass_owner;\n${sql}`;
    const jobs = await queryJson(ctx, 'migrate', owner(`select json_build_object('n', count(*), 'queued', count(*) filter (where status = 'queued'), 'future', count(*) filter (where available_at > now()), 'id', min(id::text))::text from app.jobs where target_publication_id = '${pub.publication_id}'`));
    ok(jobs.n === 1 && jobs.queued === 1 && jobs.future === 1 && UUID.test(jobs.id ?? ''), `expected exactly one queued, future job for the fixture (got ${JSON.stringify(jobs)}): a recheck job needs a rights expiry date`);
    const due0 = Number(await queryText(ctx, 'migrate', owner(`select count(*) from app.jobs where status = 'queued' and available_at <= now()`)));
    ok(due0 === 0, `${due0} other job(s) are already due; the claim could take the wrong one`);
    const upd = await runSql(ctx, 'migrate', `${owner(JOB_DUE_SQL(jobs.id, pub.publication_id))};`, { kind: 'fixture', fixtureIds: ids(), allowedJobTargets: new Set([`${jobs.id}:${pub.publication_id}`.toLowerCase()]) });
    ok(upd.ok, `the scoped job update failed: ${upd.stderr.split('\n')[0]}`);
    const due1 = await queryJson(ctx, 'migrate', owner(`select json_build_object('n', count(*), 'id', min(id::text))::text from app.jobs where status = 'queued' and available_at <= now()`));
    ok(due1.n === 1 && due1.id === jobs.id, `the fixture job is not the only due job (${JSON.stringify(due1)})`);
    const jobIds = new Set([jobs.id.toLowerCase()]);
    const claim = await queryJson(ctx, 'worker-txn', "select worker.claim_job('publication_recheck')::text", { kind: 'worker', allowedJobIds: jobIds });
    ok(claim.job_id === jobs.id && Number.isInteger(claim.lease_epoch), `the claim returned a different job: ${JSON.stringify(claim)}`);
    const e = claim.lease_epoch;
    const subject = await queryJson(ctx, 'worker-txn', `select worker.get_job_subject('${jobs.id}', ${e})::text`, { kind: 'worker', allowedJobIds: jobIds });
    ok(JSON.stringify(Object.keys(subject).sort()) === JSON.stringify(SUBJECT_KEYS), `the job subject has the keys ${Object.keys(subject).sort().join(',')}`);
    ok(subject.publication_id === pub.publication_id, 'the subject names another publication');
    const hb = await runSql(ctx, 'worker-txn', `select worker.heartbeat_job('${jobs.id}', ${e})`, { kind: 'worker', allowedJobIds: jobIds });
    ok(hb.ok, `heartbeat failed: ${hb.stderr.split('\n')[0]}`);
    const done = await queryJson(ctx, 'worker-txn', `select worker.complete_job('${jobs.id}', ${e})::text`, { kind: 'worker', allowedJobIds: jobIds });
    ok(JSON.stringify(done).includes('still_eligible'), `the recheck outcome was not still_eligible: ${JSON.stringify(done)}`);
    for (const [label, epoch] of [['same epoch again', e], ['wrong epoch', e + 5]]) {
      const r = await runSql(ctx, 'worker-txn', `select worker.complete_job('${jobs.id}', ${epoch})`, { kind: 'worker', allowedJobIds: jobIds });
      ok(!r.ok && /lease_lost/.test(r.stderr), `complete with ${label} was not refused with lease_lost (${r.ok ? 'it succeeded' : r.stderr.split('\n')[0]})`);
    }
    const listed = await api(ctx, 'get_public_hack', undefined, { p_slug: slug });
    ok(listed.status === 200, `the fixture publication is no longer public (HTTP ${listed.status} ${errMsg(listed) ?? ''})`);
    const st = run.state(); st.facts.job_fixture = { slug, publication_id: pub.publication_id, job_id: jobs.id, hack_id: s.hackId }; run.save(st);
    return `one future job made due by one scoped update; claimed ${claim.job_id.slice(0, 8)} epoch ${e}; subject keys exact; completed still_eligible; replay and wrong epoch lease_lost; publication still public`;
  });
  return c.out;
});
process.exitCode = code;
