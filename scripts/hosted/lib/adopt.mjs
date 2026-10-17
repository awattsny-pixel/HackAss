// ADOPT: carry the proven part of an earlier run into a NEW run at a NEW commit, without repeating it. Used when the scripts were corrected after S7 had already installed the foundation
// (identity and migrate passed), so the run bound to the old commit can no longer continue (a run is bound to one commit) and the installed migrations must not be applied again.
//
// What it does, in this order, all of it READ-ONLY against the target and against the source run:
//   A1 the source run is a valid, finished-so-far run: same profile, not closed, no lock held, bound to an EARLIER commit, preflight / identity / migrate done and passed under that commit, no other
//      stage (except a failed `exposure`), the recorded ledger md5 present, and the source check results present
//   A2 the same project and the same validated target binding (the hash of the targets), and the staging project reference
//   A3 the migration files are unchanged between the source commit and this commit
//   A4 the LIVE migration ledger equals the repository's migration list exactly (count, versions, md5) and equals the md5 the source run recorded
// Only then is the new run's state written: the three stages as `done` with an `inherited` marker (the evidence says "inherited, not executed at this commit"), the source results copied with status
// INHERITED (never PASS), the facts, and the source's failed `exposure` attempt kept in the history (it is not cleared). The source run is never written; its files are compared before and after.
// This module never applies a migration and never writes to the target: it imports neither lib/migrate.mjs nor lib/push.mjs, and its only database calls are two read queries.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { RUN_ID, runBase } from './state.mjs';
import { checker } from './cli.mjs';

export class AdoptRefused extends Error { constructor(problems) { super(`adoption refused (${problems.length}): ${problems.join('; ')}`); this.problems = problems; } }

export const INHERITED_STAGES = Object.freeze({ preflight: ['H0', 'H1a'], identity: ['H1b'], migrate: ['H2a'] });
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

/** The source run, read WITHOUT opening it (no lock, no write). Returns { runId, dir, state, results, digest } or throws AdoptRefused. */
export function readSourceRun(runId, profile, { base = runBase(profile) } = {}) {
  if (!RUN_ID.test(runId ?? '')) throw new AdoptRefused(['--from-run must be a run id']);
  const dir = path.join(base, runId);
  const sf = path.join(dir, 'state.json'); const rf = path.join(dir, 'results.jsonl');
  if (!existsSync(sf)) throw new AdoptRefused([`source run ${runId} has no state.json`]);
  if (existsSync(path.join(dir, 'lock'))) {
    let pid = null; try { pid = JSON.parse(readFileSync(path.join(dir, 'lock', 'owner.json'), 'utf8')).pid; } catch { /* unreadable */ }
    throw new AdoptRefused([pid && alive(pid) ? `source run ${runId} is locked by a running process (pid ${pid})` : `source run ${runId} holds a lock (a process died or is running): it is not a finished run`]);
  }
  const sb = readFileSync(sf); const rb = existsSync(rf) ? readFileSync(rf) : Buffer.alloc(0);
  let state; try { state = JSON.parse(sb.toString('utf8')); } catch { throw new AdoptRefused([`source run ${runId}: state.json is not valid JSON`]); }
  const results = []; for (const l of rb.toString('utf8').split('\n').filter(Boolean)) { try { results.push(JSON.parse(l)); } catch { throw new AdoptRefused([`source run ${runId}: results.jsonl has an unreadable line`]); } }
  return { runId, dir, state, results, digest: { state: sha256(sb), results: sha256(rb) } };
}
/** True when the source run's files are byte-for-byte what they were when read. */
export const sourceUnchanged = (src) => { const sb = readFileSync(path.join(src.dir, 'state.json')); const rf = path.join(src.dir, 'results.jsonl'); return sha256(sb) === src.digest.state && sha256(existsSync(rf) ? readFileSync(rf) : Buffer.alloc(0)) === src.digest.results; };

/** Names of changed files under supabase/migrations between `from` and HEAD (bounded git, no prompt). Throws AdoptRefused if the source commit cannot be resolved or git fails. */
export function migrationChanges(repoRoot, from, { timeoutMs = 10_000 } = {}) {
  if (!/^[0-9a-f]{40}$/.test(from ?? '')) throw new AdoptRefused(['the source commit is not a full commit SHA']);
  const opts = { cwd: repoRoot, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } };
  const known = spawnSync('git', ['cat-file', '-e', `${from}^{commit}`], opts);
  if (known.error || known.status !== 0) throw new AdoptRefused([`the source commit ${from.slice(0, 12)} is not in this repository`]);
  const d = spawnSync('git', ['diff', '--name-only', from, 'HEAD', '--', 'supabase/migrations'], opts);
  if (d.error || d.status !== 0) throw new AdoptRefused(['git could not compare the migration files']);
  return d.stdout.split('\n').filter(Boolean);
}

/**
 * Decide whether the source run may be adopted. Pure: everything it needs is passed in. Returns the state to write, or throws AdoptRefused listing EVERY problem found.
 * input: { source: {runId,state,results}, profile, targetsHash, head, projectRef, expectedRef, migrationChanges: string[], repoVersions: string[], live: {count,versions,md5} | null }
 */
export function planAdoption({ source, profile, targetsHash, head, projectRef, expectedRef, migrationChanges: changed, repoVersions, live }) {
  const bad = [];
  const st = source?.state ?? {}; const stages = st.stages ?? {}; const b = st.binding ?? null;
  // A1 the source run
  if (st.runId !== source?.runId) bad.push(`A1 source state names run ${st.runId ?? 'none'}, not ${source?.runId}`);
  if (st.profile !== profile) bad.push(`A1 source run profile is ${st.profile ?? 'none'}, not ${profile}`);
  if (st.closed) bad.push('A1 source run is closed');
  if (!b || !/^[0-9a-f]{40}$/.test(b.commit ?? '')) bad.push('A1 source run has no valid commit binding');
  else if (b.commit === head) bad.push('A1 source run is bound to this same commit: continue that run instead of adopting it');
  for (const [stage, ids] of Object.entries(INHERITED_STAGES)) {
    const s = stages[stage];
    if (!s || s.status !== 'done') bad.push(`A1 source stage ${stage} is not done (${s?.status ?? 'absent'})`);
    else {
      if (s.commit !== b?.commit) bad.push(`A1 source stage ${stage} was recorded under ${String(s.commit).slice(0, 12)}, not the run's commit`);
      if (!(s.passed >= 1) || s.failed !== 0) bad.push(`A1 source stage ${stage} did not pass cleanly (${s.passed} passed, ${s.failed} failed)`);
      for (const id of ids) if (!(source.results ?? []).some((r) => r.id === id && r.status === 'PASS')) bad.push(`A1 source results have no PASS for ${id}`);
    }
  }
  for (const [k, s] of Object.entries(stages)) {
    if (k in INHERITED_STAGES) continue;
    if (k === 'exposure' && s?.status === 'failed') continue; // the failed attempt is carried into the history below
    bad.push(`A1 source run has an unexpected stage ${k} (${s?.status}): only a failed exposure attempt may follow migrate`);
  }
  const md5 = st.facts?.ledger_md5_after_migrate;
  if (!/^[0-9a-f]{32}$/.test(md5 ?? '')) bad.push('A1 source run recorded no ledger md5');
  if ((st.fixtures && Object.keys(st.fixtures).length) || (st.history ?? []).length) bad.push('A1 source run has fixtures or earlier attempts: it is not a clean S6/S7 run');
  // A2 same project and target binding
  if (!b || b.profile !== profile) bad.push(`A2 source run is bound to the ${b?.profile ?? 'unknown'} profile, not ${profile}`);
  if (!b || b.targets !== targetsHash) bad.push('A2 the validated target configuration differs from the one the source run was bound to');
  if (projectRef !== expectedRef) bad.push(`A2 the project reference ${projectRef} is not the expected ${expectedRef}`);
  // A3 migration files
  if (!Array.isArray(changed)) bad.push('A3 the migration comparison was not made');
  else if (changed.length) bad.push(`A3 migration files changed since the source commit: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ' ...' : ''}`);
  // A4 live ledger
  if (!live) bad.push('A4 the live ledger was not read');
  else {
    const same = Array.isArray(live.versions) && live.versions.length === repoVersions.length && live.versions.every((v, i) => v === repoVersions[i]);
    if (!same) bad.push(`A4 the live ledger (${live.count} versions) is not exactly the repository's ${repoVersions.length} migrations`);
    if (live.count !== repoVersions.length) bad.push(`A4 the live ledger count is ${live.count}, expected ${repoVersions.length}`);
    if (live.md5 !== md5) bad.push('A4 the live ledger md5 differs from the one the source run recorded');
  }
  if (bad.length) throw new AdoptRefused(bad);

  // the state to write: inherited stages, inherited results, facts, the kept failure
  const from = { run: source.runId, commit: b.commit, adoptedAtCommit: head };
  const newStages = {};
  for (const stage of Object.keys(INHERITED_STAGES)) {
    const s = stages[stage];
    newStages[stage] = { status: 'done', at: s.at, commit: s.commit, passed: s.passed, failed: s.failed, inherited: { ...from, note: 'inherited from the source run; not executed at this commit' } };
  }
  const results = [];
  for (const [stage, ids] of Object.entries(INHERITED_STAGES)) for (const id of ids) {
    const r = source.results.filter((x) => x.id === id && x.status === 'PASS').at(-1);
    results.push({ id, status: 'INHERITED', stage, title: r.title, facts: r.facts ?? null, ms: r.ms ?? null, inherited: { ...from, originalStatus: 'PASS' } });
  }
  const history = [];
  if (stages.exposure) {
    const fail = source.results.filter((x) => x.id === 'H2b' && x.status === 'FAIL').at(-1);
    history.push({ stage: 'exposure', status: 'failed', at: stages.exposure.at, commit: stages.exposure.commit, passed: stages.exposure.passed ?? 0, failed: stages.exposure.failed ?? 1,
      error: `${fail?.error ?? 'H2b failed'} [inherited from run ${source.runId} at commit ${String(stages.exposure.commit).slice(0, 12)}; kept, not cleared]`, inherited: { ...from } });
  }
  const facts = { ...Object.fromEntries(['public_objects_before', 'server_version', 'jwks', 'ledger_md5_after_migrate'].filter((k) => st.facts?.[k] !== undefined).map((k) => [k, st.facts[k]])), inherited_from_run: source.runId, inherited_from_commit: b.commit };
  return { stages: newStages, results, facts, history, from };
}

/**
 * The stage body (called by scripts/hosted/adopt.mjs through runStage). `deps` exist so tests can run it without a database or git:
 * { readSource(runId, profile), changes(repoRoot, fromCommit), queryLedger(ctx) -> {count,versions,md5}, repoVersions() }.
 */
export async function runAdoption({ ctx, run, flags, profile, git, repoRoot, expectedRef, say, targetsHash, deps }) {
  const c = checker(run, say, { continueOnFail: true });
  const problems = []; let plan = null; let src = null; let evaluated = false;
  const fromRun = flags['from-run'];
  if (typeof fromRun !== 'string') throw new Error('--from-run=<source run id> is required');
  if (fromRun === run.runId) problems.push('A1 the source run and the new run are the same run');
  const here = run.state();
  if (Object.keys(here.stages ?? {}).some((k) => k !== 'adopt') || (here.history ?? []).length) problems.push('A1 the new run is not fresh (it already has stages or history): adoption needs a new run id');
  try { src = deps.readSource(fromRun, profile); } catch (e) { if (e instanceof AdoptRefused) problems.push(...e.problems.map((p) => (/^A\d /.test(p) ? p : `A1 ${p}`))); else throw e; }
  if (src && !problems.length) {
    evaluated = true; // from here every rule is evaluated, so a rule with no problem of its own passed
    let changed = null; let live = null;
    try { changed = deps.changes(repoRoot, src.state.binding?.commit); } catch (e) { problems.push(`A3 ${e instanceof AdoptRefused ? e.problems.join('; ') : `the migration comparison failed: ${e?.message ?? e}`}`); }
    try { live = await deps.queryLedger(ctx); } catch (e) { problems.push(`A4 the live ledger could not be read: ${e?.message ?? e}`); }
    try {
      plan = planAdoption({ source: src, profile, targetsHash, head: git.head, projectRef: ctx.targets.ref, expectedRef, migrationChanges: changed, repoVersions: deps.repoVersions(), live });
    } catch (e) { if (e instanceof AdoptRefused) problems.push(...e.problems.filter((p) => !problems.includes(p))); else throw e; }
    if (plan && !sourceUnchanged(src)) { plan = null; problems.push('A1 the source run changed while it was being read'); }
  }
  const titles = { A1: 'the source run is a valid earlier run at an earlier commit (preflight, identity, migrate done and passed; nothing else but a failed exposure attempt)', A2: 'the same project and the same validated target binding',
    A3: 'the migration files are unchanged since the source commit', A4: 'the live migration ledger equals the repository and the source run\'s recorded ledger' };
  for (const id of ['A1', 'A2', 'A3', 'A4']) {
    const mine = problems.filter((p) => p.startsWith(`${id} `));
    await c.check(id, titles[id], async () => {
      if (mine.length) throw new Error(mine.map((p) => p.slice(3)).join('; '));
      if (!evaluated) throw new Error('not evaluated because the source run could not be read');
      return plan ? (id === 'A4' ? `live ledger ${deps.repoVersions().length} versions, md5 ${plan.facts.ledger_md5_after_migrate}` : id === 'A1' ? `source run ${plan.from.run} at ${plan.from.commit.slice(0, 12)}` : 'ok') : 'ok';
    });
  }
  if (!plan || problems.length) return c.out;
  // write the new run: inherited stages and results (marked INHERITED), facts, and the kept failure; the source run is untouched
  const st = run.state();
  st.stages = { ...st.stages, ...plan.stages };
  st.facts = { ...st.facts, ...plan.facts };
  st.history = [...(st.history ?? []), ...plan.history];
  run.save(st);
  for (const r of plan.results) run.log(r);
  say(`adopted from run ${plan.from.run} (commit ${plan.from.commit.slice(0, 12)}): preflight, identity and migrate are INHERITED, not re-executed at ${git.head.slice(0, 12)}${plan.history.length ? '; the earlier failed exposure attempt is kept in the history' : ''}`);
  return c.out;
}


// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// adopt --through=s8: carry the S7 AND S8 progress of a blocked run into a NEW run at a new commit (used while finding F-H9-1 is open, so the checks that remain can run). Read-only against the
// target (ledger and fixture inspection are reads); the source run is never written; the fixtures' private secrets are copied with integrity checks. Rules, in addition to A1 to A4:
//   A5 each recorded fixture user's Auth presence, account status and ACTIVE STAFF ASSIGNMENTS match the EXPECTED POST-TEST state (not "every user exists": b2 was deleted on purpose, s-rm de-staffed, s-mfa and s-rev still staffed). That s-sess was signed out is NOT freshly verified here (an Auth session cannot be read back): it is inherited evidence (H6). Nothing is recreated or reset.
//   A6 the fixtures' secrets file is copied (mode 0600), read back, and equal to the source by canonical content digest, before anything is recorded.
// Provenance is preserved, not flattened: a stage that was already inherited keeps its earlier adoption as `previous`; every earlier failed attempt stays in the history; completed checks (including
// the MFA evidence H6, H7, H8, H8-default) are recorded INHERITED with their original facts, never PASS.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export const S8_REQUIRED_STAGES = Object.freeze({ ...INHERITED_STAGES, exposure: ['H2b'], 'worker-marker': ['H2c'], rerun: ['H3'], inventory: ['H4', 'H5a'], fixtures: ['FX0', 'H5b', 'FX1'], 'session-checks': ['H6', 'H7', 'H8', 'H8-default'] });
const S8_TOLERATED = new Set([...Object.keys(S8_REQUIRED_STAGES), 'adopt', 'worker-checks']);
export const FIXTURE_USERS = Object.freeze(['b1', 'b2', 's-sess', 's-rm', 's-mfa', 's-rev']);
/** The expected state of each fixture user after S8's fixtures and session-checks have completed. auth: the Auth user exists / is gone; assignments: ACTIVE staff assignments. */
export const EXPECTED_AFTER_SESSION_CHECKS = Object.freeze({
  b1: { auth: 'present', assignments: 0 }, b2: { auth: 'absent', accountStatus: 'deleted', assignments: 0 }, 's-sess': { auth: 'present', assignments: 0 },
  's-rm': { auth: 'present', assignments: 0 }, 's-mfa': { auth: 'present', assignments: 1 }, 's-rev': { auth: 'present', assignments: 1 },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
export const secretsDigest = (obj) => sha256(Buffer.from(canonical(obj)));

/** The source run's private secrets file, checked WITHOUT printing anything: present, a regular file, mode 0600, valid JSON, a password for every fixture user and TOTP material for the staff users. */
export function inspectSecrets(dir, users = FIXTURE_USERS) {
  const f = path.join(dir, 'secrets.json'); const problems = [];
  if (!existsSync(f)) return { problems: ['the source run has no secrets.json'], parsed: null };
  const st = statSync(f);
  if (!st.isFile()) problems.push('secrets.json is not a regular file');
  if ((st.mode & 0o077) !== 0) problems.push('secrets.json is readable by group or others (mode must be 0600)');
  let parsed = null; let readable = false;
  try { parsed = JSON.parse(readFileSync(f, 'utf8')); readable = true; } catch { problems.push('secrets.json is not valid JSON'); } // fixed text: a parse error can quote the file
  if (readable && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) { problems.push('secrets.json is not a JSON object (null, an array or a plain value is refused)'); parsed = null; }
  if (parsed) {
    for (const u of users) { if (typeof parsed.users?.[u]?.password !== 'string' || !parsed.users[u].password) problems.push(`secrets.json has no password for ${u}`); }
    for (const u of ['s-rm', 's-mfa', 's-rev']) if (typeof parsed.users?.[u]?.totpSecret !== 'string' || typeof parsed.users?.[u]?.factorId !== 'string') problems.push(`secrets.json has no TOTP material for ${u}`);
  }
  return { problems, parsed, digest: parsed ? secretsDigest(parsed) : null };
}
/** Copy the source secrets into the NEW run through run.saveSecrets (mode 0600, registered for redaction), read the copy back and compare by canonical digest. Returns { digest12 } or throws AdoptRefused (and removes the copy). */
export function copySecrets(src, run, expectedDigest) {
  const now = inspectSecrets(src.dir); // re-read: the copy is made from what is on disk now, and must still be what was validated
  if (now.problems.length || now.digest !== expectedDigest) throw new AdoptRefused(['A6 the source secrets changed or became invalid while the adoption ran']);
  const dest = path.join(run.dir, 'secrets.json');
  try { run.saveSecrets(now.parsed); } catch { rmSync(dest, { force: true }); throw new AdoptRefused(['A6 the secrets copy failed its integrity check (the copy could not be written); the copy was removed and nothing was recorded']); }
  // Every failure below maps to a FIXED message: an exception message (for example a JSON parse error) can quote text of the secrets file and must never be recorded or printed.
  let why = null;
  try {
    if ((statSync(dest).mode & 0o777) !== 0o600) why = 'the copy has the wrong file mode';
    else {
      let back = null; try { back = JSON.parse(readFileSync(dest, 'utf8')); } catch { why = 'the copy could not be read back as valid JSON'; }
      if (!why && secretsDigest(back) !== expectedDigest) why = 'the copy differs from the source';
      if (!why && inspectSecrets(src.dir).digest !== expectedDigest) why = 'the source changed while it was copied';
    }
  } catch { why = 'the copy could not be verified'; }
  if (why) { rmSync(dest, { force: true }); throw new AdoptRefused([`A6 the secrets copy failed its integrity check (${why}); the copy was removed and nothing was recorded`]); }
  return { digest12: expectedDigest.slice(0, 12), users: Object.keys(now.parsed.users ?? {}).length };
}

/** Pure decision for --through=s8. Throws AdoptRefused listing every problem, or returns the state to write. input as planAdoption plus { fixtures: {name -> {auth,accountStatus,assignments}} | null, secretsProblems: string[], secretsDigest }. */
export function planAdoptionS8({ source, profile, targetsHash, head, projectRef, expectedRef, migrationChanges: changed, repoVersions, live, fixtures, secretsProblems }) {
  const bad = [];
  const st = source?.state ?? {}; const stages = st.stages ?? {}; const b = st.binding ?? null;
  // A1 the source run
  if (st.runId !== source?.runId) bad.push(`A1 source state names run ${st.runId ?? 'none'}, not ${source?.runId}`);
  if (st.profile !== profile) bad.push(`A1 source run profile is ${st.profile ?? 'none'}, not ${profile}`);
  if (st.closed) bad.push('A1 source run is closed');
  if (!b || !/^[0-9a-f]{40}$/.test(b.commit ?? '')) bad.push('A1 source run has no valid commit binding');
  else if (b.commit === head) bad.push('A1 source run is bound to this same commit: continue that run instead of adopting it');
  for (const [stage, ids] of Object.entries(S8_REQUIRED_STAGES)) {
    const s = stages[stage];
    if (!s || s.status !== 'done') { bad.push(`A1 source stage ${stage} is not done (${s?.status ?? 'absent'})`); continue; }
    if (!(s.passed >= 1) || s.failed !== 0) bad.push(`A1 source stage ${stage} did not pass cleanly (${s.passed} passed, ${s.failed} failed)`);
    if (s.inherited) { if (s.inherited.adoptedAtCommit !== b?.commit) bad.push(`A1 source stage ${stage} was adopted at ${String(s.inherited.adoptedAtCommit).slice(0, 12)}, not at the run's commit`); } else if (s.commit !== b?.commit) bad.push(`A1 source stage ${stage} was recorded under ${String(s.commit).slice(0, 12)}, not the run's commit`);
    for (const id of ids) if (!(source.results ?? []).some((r) => r.id === id && (r.status === 'PASS' || r.status === 'INHERITED'))) bad.push(`A1 source results have no PASS or INHERITED for ${id}`);
  }
  const wc = stages['worker-checks'];
  if (!wc || wc.status !== 'failed') bad.push(`A1 source stage worker-checks must be the failed attempt to carry (${wc?.status ?? 'absent'})`);
  else if (wc.commit !== b?.commit) bad.push('A1 source worker-checks was recorded under another commit');
  const h9 = (source?.results ?? []).filter((r) => r.id === 'H9' && r.status === 'FAIL').at(-1);
  if (wc && !h9) bad.push('A1 source results hold no H9 failure to keep');
  for (const k of Object.keys(stages)) if (!S8_TOLERATED.has(k)) bad.push(`A1 source run has a stage beyond worker-checks: ${k} (${stages[k]?.status})`);
  if (stages.adopt && stages.adopt.status !== 'done') bad.push('A1 the source adopt stage is not done');
  const md5 = st.facts?.ledger_md5_after_migrate;
  if (!/^[0-9a-f]{32}$/.test(md5 ?? '')) bad.push('A1 source run recorded no ledger md5');
  for (const k of ['worker_marker', 'catalog_fingerprint']) if (!st.facts?.[k]) bad.push(`A1 source run recorded no ${k}`);
  const users = st.fixtures?.users ?? {};
  for (const u of FIXTURE_USERS) { if (!UUID.test(users[u]?.id ?? '') || !users[u]?.email) bad.push(`A1 source run has no recorded fixture user ${u}`); }
  if (!st.fixtures?.category) bad.push('A1 source run has no recorded fixture category');
  for (const u of FIXTURE_USERS) if (users[u]?.email && !(st.intents ?? []).some((i) => i.email === users[u].email && i.id === users[u].id)) bad.push(`A1 the creation intent of ${u} is missing or incomplete (cleanup finds users by it)`);
  // A2 same project and target binding
  if (!b || b.profile !== profile) bad.push(`A2 source run is bound to the ${b?.profile ?? 'unknown'} profile, not ${profile}`);
  if (!b || b.targets !== targetsHash) bad.push('A2 the validated target configuration differs from the one the source run was bound to');
  if (projectRef !== expectedRef) bad.push(`A2 the project reference ${projectRef} is not the expected ${expectedRef}`);
  // A3 migration files
  if (!Array.isArray(changed)) bad.push('A3 the migration comparison was not made');
  else if (changed.length) bad.push(`A3 migration files changed since the source commit: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ' ...' : ''}`);
  // A4 live ledger
  if (!live) bad.push('A4 the live ledger was not read');
  else {
    const same = Array.isArray(live.versions) && live.versions.length === repoVersions.length && live.versions.every((v, i) => v === repoVersions[i]);
    if (!same || live.count !== repoVersions.length) bad.push(`A4 the live ledger (${live.count} versions) is not exactly the repository's ${repoVersions.length} migrations`);
    if (live.md5 !== md5) bad.push('A4 the live ledger md5 differs from the one the source run recorded');
  }
  // A5 fixtures in their expected post-test state (inspected read-only by the caller)
  if (!fixtures) bad.push('A5 the fixture users were not inspected');
  else for (const u of FIXTURE_USERS) {
    const want = EXPECTED_AFTER_SESSION_CHECKS[u]; const got = fixtures[u];
    if (!got) { bad.push(`A5 fixture ${u} was not inspected`); continue; }
    if (got.auth !== want.auth) bad.push(`A5 fixture ${u}: Auth user is ${got.auth}, expected ${want.auth}`);
    if (want.accountStatus && got.accountStatus !== want.accountStatus) bad.push(`A5 fixture ${u}: account status is ${got.accountStatus}, expected ${want.accountStatus}`);
    if (got.assignments !== want.assignments) bad.push(`A5 fixture ${u}: ${got.assignments} active staff assignment(s), expected ${want.assignments}`);
  }
  // A6 (first part) the secrets are present and valid
  for (const p of secretsProblems ?? ['the secrets were not inspected']) bad.push(`A6 ${p}`);
  if (bad.length) throw new AdoptRefused(bad);

  // the state to write
  const from = (stageCommit, previous) => ({ run: source.runId, commit: stageCommit, adoptedAtCommit: head, note: 'inherited from the source run; not executed at this commit', ...(previous ? { previous } : {}) });
  const newStages = {}; const results = [];
  for (const [stage, ids] of Object.entries(S8_REQUIRED_STAGES)) {
    const s = stages[stage];
    newStages[stage] = { status: 'done', at: s.at, commit: s.commit, passed: s.passed, failed: s.failed, inherited: from(s.commit, s.inherited ?? null) };
    for (const id of ids) {
      const r = source.results.filter((x) => x.id === id && (x.status === 'PASS' || x.status === 'INHERITED')).at(-1);
      results.push({ id, status: 'INHERITED', stage, title: r.title, facts: r.facts ?? null, ms: r.ms ?? null, inherited: { run: source.runId, commit: s.commit, adoptedAtCommit: head, originalStatus: r.status === 'INHERITED' ? (r.inherited?.originalStatus ?? 'PASS') : 'PASS', ...(r.inherited ? { previous: r.inherited } : {}) } });
    }
  }
  const history = [...(st.history ?? []), { stage: 'worker-checks', status: 'failed', at: wc.at, commit: wc.commit, passed: wc.passed ?? 0, failed: wc.failed ?? 1,
    error: `${h9.error} [inherited from run ${source.runId} at commit ${String(wc.commit).slice(0, 12)}; kept, not cleared]`, inherited: { run: source.runId, commit: wc.commit, adoptedAtCommit: head } }];
  const prevChain = st.facts?.inherited_chain ?? (st.facts?.inherited_from_run ? [{ run: st.facts.inherited_from_run, commit: st.facts.inherited_from_commit }] : []);
  const facts = { ...st.facts, inherited_from_run: source.runId, inherited_from_commit: b.commit, inherited_chain: [...prevChain, { run: source.runId, commit: b.commit }] };
  return { stages: newStages, results, facts, history, fixtures: st.fixtures, intents: st.intents, from: { run: source.runId, commit: b.commit, adoptedAtCommit: head } };
}

/** The stage body for --through=s8 (called by runAdoption). deps: { readSource, changes, repoVersions, queryLedger, inspectFixtures(ctx, users) }. */
export async function runAdoptionS8({ ctx, run, flags, profile, git, repoRoot, expectedRef, say, targetsHash, deps }) {
  const c = checker(run, say, { continueOnFail: true });
  const problems = []; let plan = null; let src = null; let evaluated = false; let sec = null; let copied = null;
  const fromRun = flags['from-run'];
  if (typeof fromRun !== 'string') throw new Error('--from-run=<source run id> is required');
  if (fromRun === run.runId) problems.push('A1 the source run and the new run are the same run');
  const here = run.state();
  if (Object.keys(here.stages ?? {}).some((k) => k !== 'adopt') || (here.history ?? []).length) problems.push('A1 the new run is not fresh (it already has stages or history): adoption needs a new run id');
  try { src = deps.readSource(fromRun, profile); } catch (e) { if (e instanceof AdoptRefused) problems.push(...e.problems.map((p) => (/^A\d /.test(p) ? p : `A1 ${p}`))); else throw e; }
  if (src && !problems.length) {
    evaluated = true;
    let changed = null; let live = null; let fixtures = null;
    sec = inspectSecrets(src.dir); // first: the copy is later checked against exactly what was validated here
    try { changed = deps.changes(repoRoot, src.state.binding?.commit); } catch (e) { problems.push(`A3 ${e instanceof AdoptRefused ? e.problems.join('; ') : `the migration comparison failed: ${e?.message ?? e}`}`); }
    try { live = await deps.queryLedger(ctx); } catch (e) { problems.push(`A4 the live ledger could not be read: ${e?.message ?? e}`); }
    try { fixtures = await deps.inspectFixtures(ctx, src.state.fixtures?.users ?? {}); } catch (e) { problems.push(`A5 the fixture users could not be inspected: ${e?.message ?? e}`); }
    try {
      plan = planAdoptionS8({ source: src, profile, targetsHash, head: git.head, projectRef: ctx.targets.ref, expectedRef, migrationChanges: changed, repoVersions: deps.repoVersions(), live, fixtures, secretsProblems: sec.problems });
    } catch (e) { if (e instanceof AdoptRefused) problems.push(...e.problems.filter((p) => !problems.includes(p))); else throw e; }
    if (plan) {
      try { copied = copySecrets(src, run, sec.digest); } catch (e) { if (e instanceof AdoptRefused) { plan = null; problems.push(...e.problems); } else throw e; }
    }
    if (plan && !sourceUnchanged(src)) { plan = null; rmSync(path.join(run.dir, 'secrets.json'), { force: true }); problems.push('A1 the source run changed while it was being read'); }
  }
  const titles = { A1: 'the source run is a valid blocked run: S7 and S8 stages done through session-checks, worker-checks the only failed stage, nothing beyond it', A2: 'the same project and the same validated target binding',
    A3: 'the migration files are unchanged since the source commit', A4: "the live migration ledger equals the repository and the source run's recorded ledger", A5: "each fixture user's Auth presence, account status and active staff assignments match the expected post-test state (b2 absent and deleted, s-rm de-staffed, s-mfa and s-rev still staffed); that s-sess stays signed out is inherited evidence (H6), not freshly verified",
    A6: "the fixtures' private secrets were copied (mode 0600) and verified equal to the source by content digest" };
  for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) {
    const mine = problems.filter((p) => p.startsWith(`${id} `));
    await c.check(id, titles[id], async () => {
      if (mine.length) throw new Error(mine.map((p) => p.slice(3)).join('; '));
      if (!evaluated) throw new Error('not evaluated because the source run could not be read');
      if (id === 'A6') { if (!copied) throw new Error('not evaluated because an earlier rule failed'); return `${copied.users} users, content digest ${copied.digest12}…, mode 600`; }
      return plan ? (id === 'A4' ? `live ledger ${deps.repoVersions().length} versions, md5 ${plan.facts.ledger_md5_after_migrate}` : id === 'A1' ? `source run ${plan.from.run} at ${plan.from.commit.slice(0, 12)}` : 'ok') : 'ok';
    });
  }
  if (!plan || problems.length) { if (!plan) rmSync(path.join(run.dir, 'secrets.json'), { force: true }); return c.out; }
  const st = run.state();
  st.stages = { ...st.stages, ...plan.stages }; st.facts = { ...st.facts, ...plan.facts }; st.history = [...(st.history ?? []), ...plan.history];
  st.fixtures = plan.fixtures; st.intents = plan.intents; run.save(st);
  for (const r of plan.results) run.log(r);
  say(`adopted through S8 from run ${plan.from.run} (commit ${plan.from.commit.slice(0, 12)}): ${Object.keys(plan.stages).length} stages INHERITED, not re-executed at ${git.head.slice(0, 12)}; the failed worker-checks attempt and every earlier failed attempt are kept in the history`);
  return c.out;
}
