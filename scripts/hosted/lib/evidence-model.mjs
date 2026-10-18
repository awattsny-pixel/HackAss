// The outcome of a run, computed from its state and its results log. Pure. "No check failed" is never enough: a run is COMPLETE only when EVERY required check ran and passed (including
// the hosted 15-minute MFA test, H8-default), no stage failed, was interrupted (in its current state or in any earlier attempt) or raised an unexpected error, script cleanup is done, and the owner's deletion date is recorded.
// A check that did not run is NOT RUN, never silently absent.
import { REQUIRED_CHECKS } from './stages.mjs';
import { isCalendarDate } from './dates.mjs';

export const OWNER_ACTIONS = Object.freeze([
  'revoke or rotate the secret key and any other key or token created for the run',
  'delete the password file(s) and unset every exported secret in the operator shell',
  'delete the staging project (the synthetic content cannot be deleted by design); until then keep sign-ups closed and point no application at it',
]);

export function evaluateRun(state, results) {
  const last = new Map(); const failed = new Set(); const excepted = new Map(); const stageErrors = [];
  for (const r of results) {
    if (r.id === 'STAGE-ERROR') { stageErrors.push(r); continue; }
    last.set(r.id, r);
    if (r.status === 'FAIL') failed.add(r.id);
    if (r.status === 'EXCEPTION') excepted.set(r.id, r);
  }
  const rows = [];
  for (const [stage, ids] of REQUIRED_CHECKS) {
    for (const id of ids) {
      const r = last.get(id);
      const status = failed.has(id) ? 'FAIL' : !r || r.status === 'SKIP' ? 'NOT RUN' : r.status;
      rows.push({ stage, id, status, record: r ?? null });
    }
  }
  const stages = state.stages ?? {};
  const unhealthy = Object.entries(stages).filter(([k, s]) => k !== 'evidence' && ['failed', 'interrupted', 'running'].includes(s?.status)).map(([k, s]) => `${k} (${s.status})`);
  const stagesNotDone = REQUIRED_CHECKS.map(([s]) => s).filter((s) => stages[s]?.status !== 'done');
  const notRun = rows.filter((r) => r.status === 'NOT RUN').map((r) => r.id);
  const fails = rows.filter((r) => r.status === 'FAIL').map((r) => r.id);
  const date = state.facts?.owner_deletion_date ?? null;
  const dateOk = date !== null && isCalendarDate(date);
  const scriptCleanupDone = stages.cleanup?.status === 'done' && ['H13a', 'H13b', 'H13c'].every((id) => last.get(id)?.status === 'PASS');
  // Earlier attempts that failed or were interrupted stay in the outcome even if an approved retry later succeeded.
  const earlier = (state.history ?? []).filter((h) => h?.stage && h.stage !== 'evidence' && ['failed', 'interrupted', 'running'].includes(h.status));
  const failedReasons = [];
  if (fails.length) failedReasons.push(`failed checks: ${fails.join(', ')}`);
  if (excepted.size) failedReasons.push(`open finding(s) carried by an exception, not passed: ${[...excepted.values()].map((r) => `${r.id} (${r.finding})`).join(', ')}`);
  if (unhealthy.length) failedReasons.push(`unhealthy stages: ${unhealthy.join(', ')}`);
  if (earlier.length) failedReasons.push(`earlier attempts that failed or were interrupted (kept although a retry followed): ${earlier.map((h) => `${h.stage} (${h.status})`).join(', ')}`);
  if (stageErrors.length) failedReasons.push(`${stageErrors.length} unexpected stage error(s): ${[...new Set(stageErrors.map((e) => e.stage))].join(', ')}`);
  const incompleteReasons = [];
  if (notRun.length) incompleteReasons.push(`not run: ${notRun.join(', ')}`);
  if (stagesNotDone.length) incompleteReasons.push(`stages not done: ${stagesNotDone.join(', ')}`);
  if (!scriptCleanupDone) incompleteReasons.push('script cleanup (H13a to H13c) is not done');
  if (!dateOk) incompleteReasons.push(date === null ? 'the owner-confirmed deletion date is not recorded' : 'the recorded deletion date is not a valid calendar date');
  const outcome = failedReasons.length ? 'FAILED' : incompleteReasons.length ? 'INCOMPLETE' : 'COMPLETE';
  const inherited = rows.filter((r) => r.status === 'INHERITED');
  return { outcome, reasons: [...failedReasons, ...incompleteReasons], rows, inherited, excepted: [...excepted.values()], notRun, fails, unhealthy, earlier, stageErrors, scriptCleanupDone, ownerDate: dateOk ? date : null, ownerActions: OWNER_ACTIONS };
}
