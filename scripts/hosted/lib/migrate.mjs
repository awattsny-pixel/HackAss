// Running `supabase db push` with a bound on the DATABASE work, not only on the CLI process. Killing the CLI does not end its server session (measured on the pinned CLI: a blocked
// migration's session stayed for 47 s after the CLI was killed, holding its transaction). So:
//   1. SERVER-SIDE LIMITS are given as startup options of the CLI's session (lock wait, statement time, idle-in-transaction time, and a connection check that ends a session whose client
//      died); the server enforces them whatever happens to the client;
//   2. the CLI's session is IDENTIFIED narrowly (the CLI ignores a name given in the URL, so: same login, the CLI's own session name, started after a SERVER-clock mark read just before
//      launch) and, after a deadline or a failure, ended by cancel then terminate;
//   3. the end is VERIFIED: no such session, no lock held by one, and no session of the login left waiting on a lock or idle in a transaction. If that cannot be shown, the error says
//      NOT PROVEN. Either way the stage fails and a mutating stage is never retried (the run must be cleaned up).
// What this does not do: it cannot identify the CLI's session through a pooler that reuses server connections (backend_start would predate the mark) - then verification reports
// NOT PROVEN whenever a blocked session remains, which is the safe direction. The limits and the identification were verified on a direct connection to the local stack only.
import { runBounded, childEnv } from './exec.mjs';
import { cliUrl, assertDirectMigrationTarget, REPO_ROOT } from './config.mjs';
import { runSql } from './pg.mjs';
import { MIGRATION_SQL } from './sqlguard.mjs';
import { parsePushResult } from './push.mjs';

/** The documented bound. Per statement 300 s, per lock wait 30 s, idle in a transaction 60 s, a dead client is noticed within 2 s; the CLI itself gets 600 s (120 s for a dry run). */
export const MIGRATION_LIMITS = Object.freeze({
  lockTimeoutMs: 30_000, statementTimeoutMs: 300_000, idleInTxnMs: 60_000, connectionCheckMs: 2_000,
  deadlineMs: 600_000, dryRunDeadlineMs: 120_000,
  cancelWaitMs: 10_000, terminateWaitMs: 30_000,
});
/** Only the selftest may change the limits (to make a blocked migration end quickly); every other profile always gets the documented ones. */
export const effectiveLimits = (ctx, over = {}) => (ctx.profile === 'selftest' ? { ...MIGRATION_LIMITS, ...over } : { ...MIGRATION_LIMITS });

export class MigrationBoundError extends Error { constructor(message, detail = {}) { super(message); Object.assign(this, detail); } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK = /^\d{10}\.\d{6}$/;
const lastNumber = (r) => { if (!r.ok) throw new Error(`database observation failed: ${r.stderr.split('\n')[0]}`); const n = Number(r.stdout.split('\n').filter(Boolean).pop()); if (!Number.isFinite(n)) throw new Error('database observation returned no number'); return n; };

/** End the CLI's session(s) and prove it. Never throws for "not proven": it returns the facts. */
export async function endMigrationSessions(ctx, mark, L, d = {}) {
  const sql = d.sql ?? runSql; const nap = d.sleep ?? sleep;
  const q = async (text) => lastNumber(await sql(ctx, 'migrate', text, { kind: 'migration', timeoutMs: 30_000 }));
  const waitZero = async (ms) => { const until = Date.now() + ms; let n = await q(MIGRATION_SQL.count(mark)); while (n > 0 && Date.now() < until) { await nap(500); n = await q(MIGRATION_SQL.count(mark)); } return n; };
  const out = { before: null, endedBy: null, cancelled: 0, terminated: 0, sessions: null, locks: null, stuck: null, proven: false };
  try {
    out.before = await q(MIGRATION_SQL.count(mark));
    let n = out.before;
    if (n === 0) out.endedBy = 'already gone';
    if (n > 0) { n = await waitZero(2 * L.connectionCheckMs + 1_000); if (n === 0) out.endedBy = 'the server (connection check)'; }
    if (n > 0) { out.cancelled = await q(MIGRATION_SQL.cancel(mark)); n = await waitZero(L.cancelWaitMs); if (n === 0) out.endedBy = 'cancel'; }
    if (n > 0) { out.terminated = await q(MIGRATION_SQL.terminate(mark)); n = await waitZero(L.terminateWaitMs); if (n === 0) out.endedBy = 'terminate'; }
    out.sessions = n;
    out.locks = await q(MIGRATION_SQL.locks(mark));
    out.stuck = await q(MIGRATION_SQL.stuck);
    out.proven = out.sessions === 0 && out.locks === 0 && out.stuck === 0;
    if (!out.proven && !out.endedBy) out.endedBy = 'NOT ENDED';
  } catch (e) { out.error = String(e?.message ?? e); }
  return out;
}
const describe = (e) => (e.error ? `the migration session could not be examined (${e.error})`
  : `migration sessions before ${e.before}, ended by ${e.endedBy}${e.cancelled ? `, cancelled ${e.cancelled}` : ''}${e.terminated ? `, terminated ${e.terminated}` : ''}, remaining ${e.sessions}, locks held ${e.locks}, sessions left waiting or idle in a transaction ${e.stuck}: ${e.proven ? 'the migration transaction and its locks have ended' : 'NOT PROVEN that the migration transaction has ended'}`);

/**
 * One `supabase db push` (or --dry-run) with the bound above. Returns the CLI's result document; throws MigrationBoundError (with `.ended` facts) on a deadline, truncation or CLI failure.
 * `timeoutMs` and `limits` are honoured only by the selftest profile. `deps` is for unit tests.
 */
export async function pushMigrations(ctx, { dryRun = false, cli, workdir = REPO_ROOT, timeoutMs, limits, deps = {} } = {}) {
  // the guard is the FIRST thing the invocation does: a pooler (or any non-direct) migration target is refused before the database is contacted or the CLI started
  assertDirectMigrationTarget(ctx.targets.migrate, { profile: ctx.profile });
  const sql = deps.sql ?? runSql; const run = deps.run ?? runBounded;
  const L = effectiveLimits(ctx, limits);
  const deadline = ctx.profile === 'selftest' && Number.isInteger(timeoutMs) ? timeoutMs : (dryRun ? L.dryRunDeadlineMs : L.deadlineMs);
  const what = `supabase db push${dryRun ? ' --dry-run' : ''}`;
  // the server clock, read BEFORE the CLI starts: the identification of its session needs it, so without it nothing is started
  const markRes = await sql(ctx, 'migrate', MIGRATION_SQL.mark, { kind: 'migration', timeoutMs: 30_000 });
  const mark = markRes.ok ? markRes.stdout.split('\n').filter(Boolean).pop() : null;
  if (!mark || !MARK.test(mark)) throw new MigrationBoundError(`${what} was not started: the server clock could not be read, so the CLI's session could not be identified`);
  const m = ctx.targets.migrate;
  const args = ['--output-format', 'stream-json', 'db', 'push', '--db-url', cliUrl({ host: m.host, port: m.port, user: m.user, profile: ctx.profile, limits: L }), ...(dryRun ? ['--dry-run'] : [])];
  // stdin is closed (nothing can be answered at a prompt); the password comes only from the private password file; the whole process group is killed at the deadline
  const r = await run(cli, args, { cwd: workdir, timeoutMs: deadline, env: childEnv({ PGPASSFILE: ctx.targets.passfile }) });
  const unfinished = r.timedOut || r.truncated || r.code !== 0 || !!r.signal;
  const ended = unfinished ? await endMigrationSessions(ctx, mark, L, deps) : null;
  if (r.timedOut || r.truncated) {
    throw new MigrationBoundError(`${what} ${r.timedOut ? `exceeded its deadline (${deadline} ms) and its process group was killed` : 'produced more output than is kept, and was killed'}; ${describe(ended)}. The stage is failed and cannot be retried: clean up the run and start a new one.`, { ended, timedOut: !!r.timedOut });
  }
  try { return parsePushResult(r, { dryRun }); } catch (e) {
    if (!ended) throw e;
    throw new MigrationBoundError(`${e.message}; ${describe(ended)}`, { ended });
  }
}
