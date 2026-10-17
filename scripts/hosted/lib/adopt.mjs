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
import { existsSync, readFileSync } from 'node:fs';
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
  const problems = []; let plan = null; let src = null;
  const fromRun = flags['from-run'];
  if (typeof fromRun !== 'string') throw new Error('--from-run=<source run id> is required');
  if (fromRun === run.runId) problems.push('A1 the source run and the new run are the same run');
  const here = run.state();
  if (Object.keys(here.stages ?? {}).some((k) => k !== 'adopt') || (here.history ?? []).length) problems.push('A1 the new run is not fresh (it already has stages or history): adoption needs a new run id');
  try { src = deps.readSource(fromRun, profile); } catch (e) { if (e instanceof AdoptRefused) problems.push(...e.problems.map((p) => (/^A\d /.test(p) ? p : `A1 ${p}`))); else throw e; }
  if (src && !problems.length) {
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
      if (!plan) throw new Error('not evaluated because an earlier step failed');
      return id === 'A4' ? `live ledger ${deps.repoVersions().length} versions, md5 ${plan.facts.ledger_md5_after_migrate}` : id === 'A1' ? `source run ${plan.from.run} at ${plan.from.commit.slice(0, 12)}` : 'ok';
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
