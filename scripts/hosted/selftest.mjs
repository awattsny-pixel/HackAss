#!/usr/bin/env node
// Integration self-test against the DISPOSABLE LOCAL Supabase stack (never a hosted project). It runs
//   1. refusals that must happen before anything is contacted (wrong target, missing gates, out-of-order stage, a repeated mutating stage, wrong authorization group);
//   2. a CONCURRENCY scenario (two processes, one run), an INTERRUPTION scenario (SIGTERM, then the explicit read-only retry) and a CRASH scenario (SIGKILL in the middle of the
//      identity stage, then cleanup of the uncertain creation by its exact recorded e-mail, before any application table or worker role exists);
//   3. real-Docker DEADLINE checks: a statement that outlives its client deadline leaves no container and no running statement;
//   4. every stage in order, in one fresh run, from an empty database, with every stage a separate process (as on staging);
//   5. evidence generated in a separate process after the secrets file was deleted, and proof that no secret reached any output, file or the evidence.
// Needs: the local stack running (`supabase start`), Docker, SUPABASE_BIN. HOSTED_SELFTEST=1 is set here.  Usage: node scripts/hosted/selftest.mjs [--default-window]
// With --default-window the hosted 15-minute MFA test (H8-default, about 17 minutes) also runs and the evidence outcome must be COMPLETE; without it the outcome must be INCOMPLETE
// with exactly H8-default reported as NOT RUN.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selftestEnv, resetLocalApplication, setLocalWorkerPassword } from './lib/selftest-env.mjs';
import { gitState } from './lib/gates.mjs';
import { REPO_ROOT } from './lib/config.mjs';
import { runBase } from './lib/state.mjs';
import { createContext } from './lib/context.mjs';
import { runSql, PgFailure } from './lib/pg.mjs';
import { adminFindUsersByEmails } from './lib/flows.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FULL = process.argv.includes('--default-window');
resetLocalApplication(); // a fresh project: the first migration run applies all 21 from empty
const { env: base, workerPw, dir: pwDir } = selftestEnv({ setPassword: false });
const head = gitState().head;
const runId = `selftest-${randomBytes(3).toString('hex')}`;
const deletionDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const container = process.env.DOCKER_BIN || 'docker';
let failures = 0; const transcript = [];
const childEnv = (extra = {}) => ({ ...process.env, ...base, HOSTED_SELFTEST: '1', ...extra });
const sh = (script, args, extraEnv = {}) => {
  const r = spawnSync('node', [path.join(HERE, script), ...args], { env: childEnv(extraEnv), encoding: 'utf8', timeout: 1_800_000, cwd: REPO_ROOT });
  const out = `${r.stdout}${r.stderr}`; transcript.push(out); return { code: r.status, out };
};
const stageOn = (id, script, group, { pre = [], flags = [], env } = {}) => sh(script, [...pre, '--profile=selftest', `--run-id=${id}`, `--authorized=${group}@${head}`, ...flags], env);
const stage = (name, script, group, opt = {}) => stageOn(runId, script, group, opt);
const expect = (label, cond, detail = '') => { if (cond) console.log(`ok    ${label}`); else { failures++; console.log(`NOT OK ${label} ${detail}`); } };
const runDir = (id) => path.join(runBase('selftest'), id);
const stateOf = (id) => JSON.parse(readFileSync(path.join(runDir(id), 'state.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psqlAdmin = (sql) => spawnSync(container, ['exec', '-i', 'supabase_db_hackass-local', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-Atc', sql], { encoding: 'utf8', timeout: 30_000 }).stdout.trim();
const spawnStage = (id, script, group, { pre = [], flags = [] } = {}) => {
  const child = spawn('node', [path.join(HERE, script), ...pre, '--profile=selftest', `--run-id=${id}`, `--authorized=${group}@${head}`, ...flags], { env: childEnv(), cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const done = new Promise((r) => child.on('close', (code, signal) => { transcript.push(out); r({ code, signal, out }); }));
  return { child, done, output: () => out };
};

const chain = [
  ['preflight', 'preflight.mjs', 'S6', {}],
  ['identity', 's7-apply.mjs', 'S7', { pre: ['identity'], flags: ['--confirm-mutating=identity'] }],
  ['migrate', 's7-apply.mjs', 'S7', { pre: ['migrate'], flags: ['--confirm-mutating=migrate'] }],
  ['exposure', 's7-verify.mjs', 'S7', { pre: ['exposure'], flags: ['--owner-confirmed=exposure'] }],
  ['worker-marker', 's7-apply.mjs', 'S7', { pre: ['worker-marker'], flags: ['--confirm-mutating=worker-marker', '--owner-confirmed=exposure,worker-password'] }],
  ['rerun', 's7-apply.mjs', 'S7', { pre: ['rerun'], flags: ['--confirm-mutating=rerun'] }],
  ['inventory', 's7-verify.mjs', 'S7', { pre: ['inventory'] }],
  ['fixtures', 'fixtures.mjs', 'S8', { flags: ['--confirm-mutating=fixtures'] }],
  ['session-checks', 'checks-session.mjs', 'S8', { flags: ['--confirm-mutating=session-checks', ...(FULL ? ['--default-window'] : [])] }],
  ['worker-checks', 'checks-worker.mjs', 'S8', { flags: ['--confirm-mutating=worker-checks'] }],
  ['catalog-checks', 'checks-catalog.mjs', 'S8', { flags: ['--confirm-mutating=catalog-checks'] }],
  ['isolation', 'isolation.mjs', 'S8', { flags: ['--confirm-mutating=isolation'] }],
  ['cleanup', 'cleanup.mjs', 'S9', { flags: ['--confirm-mutating=cleanup', `--owner-deletion-date=${deletionDate}`] }],
];
console.log(`selftest run ${runId} at ${head.slice(0, 12)}${FULL ? ' (with the 15-minute MFA test)' : ''}`);

// ---- 1. refusals: nothing may be contacted or changed
{
  const noAuth = sh('preflight.mjs', ['--profile=selftest', `--run-id=${runId}-n1`]); expect('no --authorized: refused', noAuth.code === 2 && /authorized/.test(noAuth.out), noAuth.out.slice(0, 200));
  const badSha = sh('preflight.mjs', ['--profile=selftest', `--run-id=${runId}-n2`, `--authorized=S6@${'0'.repeat(40)}`]); expect('wrong commit: refused', badSha.code === 2, badSha.out.slice(0, 200));
  const wrongGroup = sh('preflight.mjs', ['--profile=selftest', `--run-id=${runId}-n3`, `--authorized=S7@${head}`]); expect('wrong group: refused', wrongGroup.code === 2, wrongGroup.out.slice(0, 200));
  const noConfirm = sh('s7-apply.mjs', ['migrate', '--profile=selftest', `--run-id=${runId}-n4`, `--authorized=S7@${head}`]); expect('mutating without --confirm-mutating: refused', noConfirm.code === 2 && /confirm-mutating/.test(noConfirm.out), noConfirm.out.slice(0, 200));
  const ooo = sh('s7-apply.mjs', ['migrate', '--profile=selftest', `--run-id=${runId}-n5`, `--authorized=S7@${head}`, '--confirm-mutating=migrate']); expect('out-of-order stage: refused', ooo.code === 2 && /has not been started|must be completed/.test(ooo.out), ooo.out.slice(0, 200));
  const noSelf = sh('preflight.mjs', ['--profile=selftest', `--run-id=${runId}-n6`, `--authorized=S6@${head}`], { HOSTED_SELFTEST: '' }); expect('selftest profile without HOSTED_SELFTEST: refused', noSelf.code === 2, noSelf.out.slice(0, 200));
  const wrongRef = sh('preflight.mjs', ['--profile=staging', `--run-id=${runId}-n7`, `--authorized=S6@${head}`]); expect('staging profile with local targets: refused before contact', wrongRef.code === 2 && /REFUSED/.test(wrongRef.out), wrongRef.out.slice(0, 300));
  const hostMix = sh('preflight.mjs', ['--profile=selftest', `--run-id=${runId}-n8`, `--authorized=S6@${head}`], { STAGING_POOLER_TXN_HOST: 'aws-0-us-east-1.pooler.supabase.com' }); expect('selftest profile with a hosted pooler host: refused', hostMix.code === 2 && /REFUSED/.test(hostMix.out), hostMix.out.slice(0, 300));
  const noIso = sh('isolation.mjs', ['--profile=selftest', `--run-id=${runId}-n9`, `--authorized=S8@${head}`]); expect('isolation without its mutating confirmation: refused', noIso.code === 2 && /confirm-mutating=isolation/.test(noIso.out), noIso.out.slice(0, 200));
  const badDate = sh('cleanup.mjs', ['--profile=selftest', `--run-id=${runId}-n10`, `--authorized=S9@${head}`, '--confirm-mutating=cleanup', '--owner-deletion-date=2026-02-30']); expect('an impossible deletion date: refused', badDate.code === 2 && /deletion date/.test(badDate.out), badDate.out.slice(0, 200));
}

// ---- 2a. concurrency: two processes, one run
{
  const id = `${runId}-conc`;
  const a = spawnStage(id, 'preflight.mjs', 'S6'); await sleep(150); const b = spawnStage(id, 'preflight.mjs', 'S6');
  const [ra, rb] = await Promise.all([a.done, b.done]);
  const codes = [ra.code, rb.code].sort();
  expect('two concurrent invocations of one run: exactly one runs, the other is refused', codes.join() === '0,2' && (/another process/.test(ra.out) || /another process/.test(rb.out)), `${codes} ${ra.out.slice(0, 120)} ${rb.out.slice(0, 120)}`);
  expect('the lock is released afterwards', !existsSync(path.join(runDir(id), 'lock')));
}
// ---- 2b. interruption: SIGTERM records the stage as interrupted; it is not restarted; the read-only retry is an explicit, recorded decision
{
  const id = `${runId}-sigterm`;
  const p = spawnStage(id, 'preflight.mjs', 'S6');
  for (let i = 0; i < 100 && !(existsSync(path.join(runDir(id), 'state.json')) && stateOf(id).stages?.preflight?.status === 'running'); i++) await sleep(50);
  p.child.kill('SIGTERM'); const r = await p.done;
  expect('SIGTERM during a stage: exit 130 and the stage is recorded as interrupted', r.code === 130 && stateOf(id).stages.preflight.status === 'interrupted', `${r.code} ${JSON.stringify(stateOf(id).stages)}`);
  expect('the lock is released after SIGTERM', !existsSync(path.join(runDir(id), 'lock')));
  const again = stageOn(id, 'preflight.mjs', 'S6'); expect('an interrupted stage does not restart by itself', again.code === 2 && /not healthy/.test(again.out), again.out.slice(0, 200));
  const retry = stageOn(id, 'preflight.mjs', 'S6', { flags: ['--retry-after-review'] }); expect('a read-only stage can be re-attempted with --retry-after-review', retry.code === 0, retry.out.slice(0, 300));
}
// ---- 2c. crash: SIGKILL in the middle of the identity stage; cleanup recovers the uncertain creation by exact e-mail, before any application table exists
{
  const id = `${runId}-crash`;
  expect('crash scenario: preflight', stageOn(id, 'preflight.mjs', 'S6').code === 0);
  const p = spawnStage(id, 's7-apply.mjs', 'S7', { pre: ['identity'], flags: ['--confirm-mutating=identity'] });
  let email = null;
  for (let i = 0; i < 400 && !email; i++) { await sleep(25); try { email = stateOf(id).intents?.[0]?.email ?? null; } catch { /* not yet */ } }
  p.child.kill('SIGKILL'); await p.done;
  expect('the creation intent was recorded before the Auth request', !!email, 'no intent in the state');
  expect('SIGKILL leaves the stage unfinished (running)', stateOf(id).stages.identity.status === 'running');
  const re = stageOn(id, 's7-apply.mjs', 'S7', { pre: ['identity'], flags: ['--confirm-mutating=identity'] }); expect('the killed stage does not restart', re.code === 2 && /died without finishing/.test(re.out), re.out.slice(0, 200));
  const mig = stageOn(id, 's7-apply.mjs', 'S7', { pre: ['migrate'], flags: ['--confirm-mutating=migrate'] }); expect('no later stage runs on a run with an unfinished stage', mig.code === 2, mig.out.slice(0, 200));
  const cl = stageOn(id, 'cleanup.mjs', 'S9', { flags: ['--confirm-mutating=cleanup', `--owner-deletion-date=${deletionDate}`] });
  expect('cleanup recovers the interrupted creation (no application tables, no worker role yet)', cl.code === 0 && /already exist|does not exist yet|application tables not present/.test(cl.out), cl.out.slice(-600));
  const probeCtx = createContext(base, { profile: 'selftest' });
  const left = await adminFindUsersByEmails(probeCtx, [email]);
  expect('no user with the recorded e-mail remains in Auth', left.size === 0);
  expect('the closed run refuses further fixture creation', stageOn(id, 'fixtures.mjs', 'S8', { flags: ['--confirm-mutating=fixtures'] }).code === 2);
  const ev = stageOn(id, 'evidence.mjs', 'S9'); const evFile = readdirSync(runDir(id)).find((f) => f.endsWith('.md'));
  expect('evidence for a run that crashed: FAILED, with the unfinished stage named', ev.code === 0 && /\*\*Outcome: FAILED\*\*/.test(readFileSync(path.join(runDir(id), evFile ?? 'none'), 'utf8')) && /identity \(interrupted\)/.test(readFileSync(path.join(runDir(id), evFile ?? 'none'), 'utf8')), ev.out.slice(0, 300));
}

// ---- 3. real deadlines: no surviving container, no running statement
{
  const ctx = createContext(base, { profile: 'selftest' });
  const t0 = Date.now();
  let err = null;
  try { await runSql(ctx, 'migrate', 'select pg_sleep(120)', { kind: 'read', timeoutMs: 2_500 }); } catch (e) { err = e; }
  expect('a statement past its client deadline fails with a bounded timeout', err instanceof PgFailure && err.timedOut === true && Date.now() - t0 < 20_000, String(err));
  expect('the client container was removed and its absence verified', err?.containerRemoved === true);
  const left = spawnSync(container, ['ps', '-a', '-q', '--filter', 'name=hackass-psql-'], { encoding: 'utf8' }).stdout.trim();
  expect('no hackass-psql container survives', left === '', left);
  let active = '?';
  for (let i = 0; i < 40; i++) { active = psqlAdmin("select count(*) from pg_stat_activity where application_name like 'hackass-psql-%' and state = 'active'"); if (active === '0') break; await sleep(500); }
  expect('no statement of the abandoned client keeps running in the database', active === '0', `active statements: ${active}`);
}

// ---- 4. the full chain
for (const [name, script, group, opt] of chain) {
  const r = stage(name, script, group, opt);
  expect(`stage ${name}`, r.code === 0, `\n${r.out.split('\n').filter((l) => /FAIL|REFUSED|ERROR/.test(l)).join('\n')}`);
  if (r.code !== 0) break;
  if (name === 'preflight') { const again = stage(name, script, group, opt); expect('read-only stage may be repeated', again.code === 0); }
  if (name === 'exposure') setLocalWorkerPassword(workerPw); // the owner action between exposure and worker-marker
  if (name === 'migrate') { const again = stage(name, script, group, opt); expect('mutating stage cannot be repeated', again.code === 2 && /not repeatable/.test(again.out), again.out.slice(0, 200)); }
}
const final = existsSync(path.join(runDir(runId), 'state.json')) ? stateOf(runId) : { stages: {} };
expect('every stage recorded done, under the one reviewed commit', Object.keys(final.stages).length === chain.length && Object.values(final.stages).every((s) => s.status === 'done' && s.commit === head) && final.binding?.commit === head && final.closed === true);
expect('the secrets file is gone but the redaction hashes remain', !existsSync(path.join(runDir(runId), 'secrets.json')) && existsSync(path.join(runDir(runId), 'redaction.hashes')));

// ---- 5. evidence, in a separate process, after the secrets file was deleted
const ev = stage('evidence', 'evidence.mjs', 'S9', {}); expect('evidence written', ev.code === 0, ev.out.slice(0, 300));
const evFile = readdirSync(runDir(runId)).find((f) => f.endsWith('-selftest-' + runId + '.md'));
const evText = evFile ? readFileSync(path.join(runDir(runId), evFile), 'utf8') : '';
if (FULL) expect('the evidence outcome is COMPLETE with the 15-minute MFA test run', /\*\*Outcome: COMPLETE\*\*/.test(evText) && /\| H8-default \| PASS \|/.test(evText), evText.slice(0, 600));
else expect('the evidence outcome is INCOMPLETE and names exactly H8-default as NOT RUN', /\*\*Outcome: INCOMPLETE\*\*/.test(evText) && /not run: H8-default\b/.test(evText) && /\| H8-default \| NOT RUN \|/.test(evText) && !/\| [A-Za-z0-9-]+ \| FAIL \|/.test(evText), evText.slice(0, 600));
expect('the evidence lists script cleanup separately from outstanding owner cleanup', /Script cleanup \(H13a to H13c\): DONE/.test(evText) && /Owner cleanup outstanding/.test(evText) && evText.includes(deletionDate));
const everything = [transcript.join('\n'), evText, ...readdirSync(runDir(runId)).filter((f) => !f.endsWith('.hashes') && !f.endsWith('.salt')).map((f) => { try { return readFileSync(path.join(runDir(runId), f), 'utf8'); } catch { return ''; } })].join('\n');
const leaked = [workerPw, base.STAGING_SECRET_KEY, base.STAGING_PUBLISHABLE_KEY].filter((s) => s && everything.includes(s));
expect('no password or key reached any stage output, any file of the run, or the evidence', leaked.length === 0, `${leaked.length} leaked`);
expect('no password or JWT shape in the evidence', !/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(evText) && !/Pw-[A-Za-z0-9_-]{20}/.test(evText));
expect('no psql client container is left after the whole run', spawnSync(container, ['ps', '-a', '-q', '--filter', 'name=hackass-psql-'], { encoding: 'utf8' }).stdout.trim() === '');

console.log(failures === 0 ? `selftest: all passed (${runId}; evidence ${evFile ?? '?'})` : `selftest: ${failures} failure(s)`);
if (failures === 0) {
  rmSync(pwDir, { recursive: true, force: true });
  for (const d of readdirSync(runBase('selftest'))) if (d.startsWith(runId)) rmSync(path.join(runBase('selftest'), d), { recursive: true, force: true });
}
process.exitCode = failures === 0 ? 0 : 1;
