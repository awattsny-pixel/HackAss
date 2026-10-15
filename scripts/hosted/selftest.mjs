#!/usr/bin/env node
// Integration self-test against the DISPOSABLE LOCAL Supabase stack (never a hosted project): runs every stage in order in one fresh run with the selftest profile, then proves the refusals
// (wrong target, missing gates, out-of-order stage, a repeated mutating stage, wrong authorization group) and that no secret reached any output or the redacted evidence.
// Needs: the local stack running (`supabase start`), Docker, HOSTED_SELFTEST=1 is set here.  Usage: node scripts/hosted/selftest.mjs [--default-window]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selftestEnv, resetLocalApplication, setLocalWorkerPassword } from './lib/selftest-env.mjs';
import { gitState } from './lib/gates.mjs';
import { REPO_ROOT } from './lib/config.mjs';
import { runBase } from './lib/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
resetLocalApplication(); // a fresh project: the first migration run applies all 21 from empty
const { env: base, workerPw, dir: pwDir } = selftestEnv({ setPassword: false });
const head = gitState().head;
const runId = `selftest-${randomBytes(3).toString('hex')}`;
let failures = 0; const transcript = [];
const sh = (script, args, extraEnv = {}) => {
  const r = spawnSync('node', [path.join(HERE, script), ...args], { env: { ...process.env, ...base, HOSTED_SELFTEST: '1', ...extraEnv }, encoding: 'utf8', timeout: 1_200_000, cwd: REPO_ROOT });
  const out = `${r.stdout}${r.stderr}`; transcript.push(out); return { code: r.status, out };
};
const stage = (name, script, group, { pre = [], flags = [], env } = {}) => sh(script, [...pre, '--profile=selftest', `--run-id=${runId}`, `--authorized=${group}@${head}`, ...flags], env);
const expect = (label, cond, detail = '') => { if (cond) console.log(`ok    ${label}`); else { failures++; console.log(`NOT OK ${label} ${detail}`); } };

const chain = [
  ['preflight', 'preflight.mjs', 'S6', {}],
  ['identity', 's7-apply.mjs', 'S7', { pre: ['identity'], flags: ['--confirm-mutating=identity'] }],
  ['migrate', 's7-apply.mjs', 'S7', { pre: ['migrate'], flags: ['--confirm-mutating=migrate'] }],
  ['exposure', 's7-verify.mjs', 'S7', { pre: ['exposure'], flags: ['--owner-confirmed=exposure'] }],
  ['worker-marker', 's7-apply.mjs', 'S7', { pre: ['worker-marker'], flags: ['--confirm-mutating=worker-marker', '--owner-confirmed=exposure,worker-password'] }],
  ['rerun', 's7-apply.mjs', 'S7', { pre: ['rerun'], flags: ['--confirm-mutating=rerun'] }],
  ['inventory', 's7-verify.mjs', 'S7', { pre: ['inventory'] }],
  ['fixtures', 'fixtures.mjs', 'S8', { flags: ['--confirm-mutating=fixtures'] }],
  ['session-checks', 'checks-session.mjs', 'S8', { flags: ['--confirm-mutating=session-checks', ...(process.argv.includes('--default-window') ? ['--default-window'] : [])] }],
  ['worker-checks', 'checks-worker.mjs', 'S8', { flags: ['--confirm-mutating=worker-checks'] }],
  ['catalog-checks', 'checks-catalog.mjs', 'S8', { flags: ['--confirm-mutating=catalog-checks'] }],
  ['isolation', 'isolation.mjs', 'S8', {}],
  ['cleanup', 'cleanup.mjs', 'S9', { flags: ['--confirm-mutating=cleanup', '--owner-deletion-date=2099-01-01'] }],
];
console.log(`selftest run ${runId} at ${head.slice(0, 12)}`);

// negative cases first: nothing may be contacted or changed
{
  const noAuth = sh('preflight.mjs', ['--profile=selftest', `--run-id=${runId}-n1`]); expect('no --authorized: refused', noAuth.code === 2 && /authorized/.test(noAuth.out), noAuth.out.slice(0, 200));
  const badSha = sh('preflight.mjs', ['--profile=selftest', `--run-id=${runId}-n2`, `--authorized=S6@${'0'.repeat(40)}`]); expect('wrong commit: refused', badSha.code === 2, badSha.out.slice(0, 200));
  const wrongGroup = sh('preflight.mjs', ['--profile=selftest', `--run-id=${runId}-n3`, `--authorized=S7@${head}`]); expect('wrong group: refused', wrongGroup.code === 2, wrongGroup.out.slice(0, 200));
  const noConfirm = sh('s7-apply.mjs', ['migrate', '--profile=selftest', `--run-id=${runId}-n4`, `--authorized=S7@${head}`]); expect('mutating without --confirm-mutating: refused', noConfirm.code === 2 && /confirm-mutating/.test(noConfirm.out), noConfirm.out.slice(0, 200));
  const ooo = sh('s7-apply.mjs', ['migrate', '--profile=selftest', `--run-id=${runId}-n5`, `--authorized=S7@${head}`, '--confirm-mutating=migrate']); expect('out-of-order stage: refused', ooo.code === 2 && /must be completed/.test(ooo.out), ooo.out.slice(0, 200));
  const noSelf = sh('preflight.mjs', ['--profile=selftest', `--run-id=${runId}-n6`, `--authorized=S6@${head}`], { HOSTED_SELFTEST: '' }); expect('selftest profile without HOSTED_SELFTEST: refused', noSelf.code === 2, noSelf.out.slice(0, 200));
  const wrongRef = sh('preflight.mjs', ['--profile=staging', `--run-id=${runId}-n7`, `--authorized=S6@${head}`]); expect('staging profile with local targets: refused before contact', wrongRef.code === 2 && /REFUSED/.test(wrongRef.out), wrongRef.out.slice(0, 300));
  const hostMix = sh('preflight.mjs', ['--profile=selftest', `--run-id=${runId}-n8`, `--authorized=S6@${head}`], { STAGING_POOLER_TXN_HOST: 'aws-0-us-east-1.pooler.supabase.com' }); expect('selftest profile with a hosted pooler host: refused', hostMix.code === 2 && /REFUSED/.test(hostMix.out), hostMix.out.slice(0, 300));
}

for (const [name, script, group, opt] of chain) {
  const r = stage(name, script, group, opt);
  expect(`stage ${name}`, r.code === 0, `\n${r.out.split('\n').filter((l) => /FAIL|REFUSED|ERROR/.test(l)).join('\n')}`);
  if (r.code !== 0) break;
  if (name === 'preflight') { const again = stage(name, script, group, opt); expect('read-only stage may be repeated', again.code === 0); }
  if (name === 'exposure') setLocalWorkerPassword(workerPw); // the owner action between exposure and worker-marker
  if (name === 'migrate') { const again = stage(name, script, group, opt); expect('mutating stage cannot be repeated', again.code === 2 && /not repeatable/.test(again.out), again.out.slice(0, 200)); }
}
const stateFile = path.join(runBase('selftest'), runId, 'state.json');
expect('every stage recorded done', existsSync(stateFile) && Object.values(JSON.parse(readFileSync(stateFile, 'utf8')).stages).length === chain.length && Object.values(JSON.parse(readFileSync(stateFile, 'utf8')).stages).every((s) => s.status === 'done'));

const ev = stage('evidence', 'evidence.mjs', 'S9', {}); expect('evidence written', ev.code === 0, ev.out.slice(0, 300));
const evFile = readdirSync(path.join(runBase('selftest'), runId)).find((f) => f.endsWith('-selftest.md'));
const evText = evFile ? readFileSync(path.join(runBase('selftest'), runId, evFile), 'utf8') : '';
const all = transcript.join('\n') + evText;
const leaked = [workerPw, base.STAGING_SECRET_KEY, base.STAGING_PUBLISHABLE_KEY].filter((s) => s && all.includes(s));
expect('no password or key reached any stage output or the evidence', leaked.length === 0, `${leaked.length} leaked`);
expect('no password or JWT shape in the evidence', !/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(evText) && !/Pw-[A-Za-z0-9_-]{20}/.test(evText));
expect('the evidence has no failed check', /No check failed/.test(evText));
console.log(failures === 0 ? `selftest: all passed (${runId}; evidence ${evFile ?? '?'}; password dir ${pwDir})` : `selftest: ${failures} failure(s)`);
process.exitCode = failures === 0 ? 0 : 1;
