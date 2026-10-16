// Database access through the `psql` of a container image, with the password file mounted read-only and a password-free connection string.
// The password never appears in an argument, an environment variable or an output; psql never prompts (-w). Every call is bounded: the client process group is killed at the
// deadline, the NAMED container is then removed and its absence verified, and a server-side statement timeout is a backstop for a statement that outlives its client.
// Every script passes the SQL allowlist first, and the executor wraps it by kind: reads in BEGIN READ ONLY ... ROLLBACK (the database refuses writes), probes in BEGIN ... ROLLBACK
// (a probe that unexpectedly succeeds is undone), fixture/admin/worker calls in their own transaction.
import { writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { assertContext } from './context.mjs';
import { PSQL_IMAGE, conninfo } from './config.mjs';
import { runBounded, childEnv } from './exec.mjs';
import { checkSql, splitStatements } from './sqlguard.mjs';
import { redact } from './redact.mjs';
import { assertPrivateFile } from './secretfile.mjs';

export class PgFailure extends Error { constructor(message, detail = {}) { super(message); Object.assign(this, detail); } }

/** endpoint: 'migrate' | 'session' | 'txn' (as the migration login, i.e. postgres) or 'worker-session' | 'worker-txn' (as hackass_worker). */
export function endpointInfo(ctx, endpoint) {
  const t = ctx.targets;
  switch (endpoint) {
    case 'migrate': return { host: t.migrate.host, port: t.migrate.port, user: t.migrate.user };
    case 'session': return { host: t.session.host, port: t.session.port, user: t.migrate.user };
    case 'txn': return { host: t.txn.host, port: t.txn.port, user: t.migrate.user };
    case 'worker-session': return { host: t.session.host, port: t.session.port, user: t.workerUser };
    case 'worker-txn': return { host: t.txn.host, port: t.txn.port, user: t.workerUser };
    default: throw new Error(`unknown endpoint ${endpoint}`);
  }
}
const isWorkerEndpoint = (ep) => ep === 'worker-txn' || ep === 'worker-session';
/** Which kinds may run where: role administration and fixture DML only through the migration login; worker calls and probes only as the worker. Reads anywhere. */
const KIND_ENDPOINTS = { read: () => true, admin: (ep) => ep === 'migrate', fixture: (ep) => ep === 'migrate', worker: isWorkerEndpoint, probe: isWorkerEndpoint, migration: (ep) => ep === 'migrate' };
const OPTIONS = new Set(['kind', 'fixtureIds', 'allowedJobTargets', 'allowedJobIds', 'timeoutMs']);

const inflight = new Set();
// The docker daemon may still be creating (or starting) a container whose client was killed, so one `rm -f` can find nothing and the container then appears.
// Removal is therefore repeated for a bounded time, and absence only counts once it has held for a quiet period. The quiet period is a bounded OBSERVATION, not a
// guarantee: a daemon slower than REMOVE_QUIET_MS can still create the container afterwards. So a removal ends in one of three verdicts, and only the first is proof:
//   removed          absent at every check for the whole quiet period
//   quiet-incomplete absent at the last check, but not for the whole quiet period before the window ran out
//   not-established  still present, or docker could not answer, at the last check
export const REMOVE_WINDOW_MS = 3_000; export const REMOVE_QUIET_MS = 1_000; const REMOVE_RETRY_MS = 200;
const dockerBin = () => process.env.DOCKER_BIN || 'docker';
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** One docker call may not outlast the window by more than a little: its deadline is what is left of the window (at least 500 ms, at most `cap`). */
const callTimeout = (deadline, cap) => Math.max(500, Math.min(cap, deadline - Date.now()));
const quietIncomplete = (quietMs) => `absent at the last check, but not for the whole ${quietMs} ms quiet period`;
/** Called when the process is interrupted: remove every client container still running, synchronously and bounded, so no statement outlives its stage.
 *  Returns [] when every one is proved gone, otherwise [{ name, state, detail }] for each one that is not (state: 'quiet-incomplete' | 'not-established'). */
export function reapInflightContainers({ windowMs = REMOVE_WINDOW_MS, quietMs = REMOVE_QUIET_MS } = {}) {
  const pending = [...inflight]; inflight.clear();
  const t0 = Date.now(); const deadline = t0 + windowMs; let quietSince = null; let last = new Map();
  while (pending.length) {
    for (const name of pending) spawnSync(dockerBin(), ['rm', '-f', name], { timeout: callTimeout(deadline, 10_000), killSignal: 'SIGKILL', stdio: 'ignore' });
    last = new Map();
    for (const name of pending) {
      const r = spawnSync(dockerBin(), ['ps', '-a', '-q', '--filter', `name=^${name}$`], { timeout: callTimeout(deadline, 10_000), killSignal: 'SIGKILL', encoding: 'utf8' });
      if (r.error || r.status !== 0) last.set(name, { state: 'not-established', detail: r.error?.code === 'ETIMEDOUT' ? 'docker ps timed out' : `docker ps exit ${r.status}` });
      else if (r.stdout.trim() !== '') last.set(name, { state: 'not-established', detail: 'container still present' });
    }
    const now = Date.now();
    quietSince = last.size ? null : (quietSince ?? now);
    if (quietSince !== null && now - quietSince >= quietMs) return [];
    if (now >= deadline) break;
    sleepSync(REMOVE_RETRY_MS);
  }
  return pending.map((name) => ({ name, ...(last.get(name) ?? { state: 'quiet-incomplete', detail: quietIncomplete(quietMs) }) }));
}
let seq = 0;
export const newContainerName = () => `hackass-psql-${process.pid}-${Date.now().toString(36)}-${seq++}`;

export function dockerArgs(ctx, endpoint, { passfile = ctx.targets.passfile, name, user } = {}) {
  const info = { ...endpointInfo(ctx, endpoint), profile: ctx.profile, appName: name };
  if (user) info.user = user;
  return ['run', '--rm', '-i', ...(name ? ['--name', name] : []), ...(ctx.profile === 'selftest' ? ['--add-host', 'host.docker.internal:host-gateway'] : []), '-v', `${passfile}:/pgpass:ro`, '-e', 'PGPASSFILE=/pgpass',
    PSQL_IMAGE, 'psql', conninfo(info), '-X', '-w', '-q', '-v', 'ON_ERROR_STOP=1', '-At'];
}

/** True when every statement only inspects settings (`show ...`): the role defaults are the thing being read, so no local override may be applied. */
const onlyShow = (sql) => splitStatements(sql).every((s) => /^show\s+[a-z_]+$/i.test(s.trim()));
/** The script actually sent: the checked statements inside the transaction shape their kind requires, with server-side backstops. Exported for tests. */
export function wrapScript(kind, sql, timeoutMs) {
  const body = sql.trim().replace(/;\s*$/, '');
  const backstop = Math.max(5_000, timeoutMs) + 5_000;
  const locals = `set local statement_timeout = '${backstop}ms';\nset local idle_in_transaction_session_timeout = '${backstop}ms';\nset local client_connection_check_interval = '1s';\n`;
  switch (kind) {
    case 'read': case 'migration': return onlyShow(sql) ? `begin read only;\n${body};\nrollback;\n` : `begin read only;\n${locals}${body};\nrollback;\n`;
    case 'probe': return `begin;\n${locals}${body};\nrollback;\n`;
    case 'worker': return `begin;\n${body};\ncommit;\n`; // the worker role's own 30 s statement timeout is the bound; a local override could only loosen it
    case 'admin': case 'fixture': return `begin;\n${locals}${body};\ncommit;\n`;
    default: throw new Error(`unknown kind ${kind}`);
  }
}

async function dockerBounded(args, timeoutMs = 20_000) {
  return runBounded(process.env.DOCKER_BIN || 'docker', args, { timeoutMs, env: childEnv(), maxBytes: 100_000 });
}
/** Remove the named container and PROVE it is gone (docker ps -a): `rm -f` is repeated for up to the window and absence must hold for the quiet period (see the verdicts above).
 *  Returns { removed, state, detail }; removed is true only for the verdict 'removed'. */
export async function removeContainer(name, { windowMs = REMOVE_WINDOW_MS, quietMs = REMOVE_QUIET_MS } = {}) {
  const deadline = Date.now() + windowMs; let quietSince = null; let detail = 'docker unavailable'; let absent = false;
  for (;;) {
    try { await dockerBounded(['rm', '-f', name], callTimeout(deadline, 20_000)); } catch { /* verified below */ }
    try {
      const r = await dockerBounded(['ps', '-a', '-q', '--filter', `name=^${name}$`], callTimeout(deadline, 20_000));
      absent = r.code === 0 && !r.timedOut && r.stdout.trim() === '';
      if (absent) quietSince ??= Date.now(); else { quietSince = null; detail = r.timedOut ? 'docker ps timed out' : r.stdout.trim() ? 'container still present' : `docker ps exit ${r.code}`; }
    } catch { absent = false; quietSince = null; detail = 'docker unavailable'; }
    const now = Date.now();
    if (quietSince !== null && now - quietSince >= quietMs) return { removed: true, state: 'removed', detail: 'container absent' };
    if (now >= deadline) return absent ? { removed: false, state: 'quiet-incomplete', detail: quietIncomplete(quietMs) } : { removed: false, state: 'not-established', detail };
    await new Promise((r) => setTimeout(r, REMOVE_RETRY_MS));
  }
}

async function execPsql(ctx, endpoint, script, { passfile, user, timeoutMs }) {
  assertPrivateFile(passfile, { label: 'the password file' });
  const name = newContainerName();
  inflight.add(name);
  const r = await runBounded(process.env.DOCKER_BIN || 'docker', dockerArgs(ctx, endpoint, { passfile, name, user }), { input: script, timeoutMs, env: childEnv() }).finally(() => inflight.delete(name));
  if (r.timedOut || r.truncated) {
    const gone = await removeContainer(name);
    const why = r.timedOut ? `database call exceeded ${timeoutMs}ms (${endpoint})` : `database output exceeded the size cap (${endpoint})`;
    throw new PgFailure(`${why}; ${gone.removed ? 'the client container was removed' : `the client container may survive (${name}: ${gone.state}, ${gone.detail}); check before retrying`}`, { timedOut: r.timedOut, containerRemoved: gone.removed, container: name });
  }
  return { ok: r.code === 0, code: r.code, stdout: r.stdout.trim(), stderr: redact(r.stderr.trim()) };
}

/**
 * Run a SQL script. kind: read | admin | fixture | probe | worker | migration (see sqlguard). No other option is accepted: in particular there is no password-file or login override here.
 * Resolves { ok, stdout, stderr (redacted), code }; throws PgFailure on timeout or truncation. A nonzero psql exit is returned (ok=false), because the probes EXPECT refusals.
 */
export async function runSql(ctx, endpoint, sql, opts = {}) {
  assertContext(ctx);
  for (const k of Object.keys(opts)) if (!OPTIONS.has(k)) throw new Error(`unknown database option ${k}`);
  const { kind = 'read', fixtureIds, allowedJobTargets, allowedJobIds, timeoutMs = 60_000 } = opts;
  endpointInfo(ctx, endpoint);
  if (!KIND_ENDPOINTS[kind]) throw new Error(`unknown SQL kind ${kind}`);
  if (!KIND_ENDPOINTS[kind](endpoint)) throw new Error(`SQL of kind ${kind} may not run on the ${endpoint} endpoint`);
  checkSql(sql, kind, { fixtureIds, allowedJobTargets, allowedJobIds });
  return execPsql(ctx, endpoint, wrapScript(kind, sql, timeoutMs), { passfile: ctx.targets.passfile, timeoutMs });
}
/** A read that must succeed and print one JSON document. */
export async function queryJson(ctx, endpoint, sql, opts = {}) {
  const r = await runSql(ctx, endpoint, sql, { ...opts, kind: opts.kind ?? 'read' });
  if (!r.ok) throw new PgFailure(`query failed on ${endpoint}: ${r.stderr.split('\n')[0]}`, { stderr: r.stderr });
  const lines = r.stdout.split('\n').filter((l) => l.trim().startsWith('{') || l.trim().startsWith('['));
  if (lines.length < 1) throw new PgFailure(`no JSON result from ${endpoint}`);
  return JSON.parse(lines[lines.length - 1]);
}
/** A read that must succeed and print scalar text (last non-empty line). */
export async function queryText(ctx, endpoint, sql, opts = {}) {
  const r = await runSql(ctx, endpoint, sql, { ...opts, kind: opts.kind ?? 'read' });
  if (!r.ok) throw new PgFailure(`query failed on ${endpoint}: ${r.stderr.split('\n')[0]}`, { stderr: r.stderr });
  const lines = r.stdout.split('\n').filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

/** The two logins of the wrong-password probe: exactly the worker login and the deliberately nonexistent one with the same suffix. Nothing else may be probed. */
export function probeLogins(ctx) {
  const suffix = ctx.profile === 'staging' ? `.${ctx.targets.ref}` : '';
  const real = `hackass_worker${suffix}`; const fake = `hackass_nonexistent${suffix}`;
  if (ctx.targets.workerUser !== real) throw new Error('the worker login does not have the expected exact form');
  return { real, fake };
}
/**
 * H9's wrong-password probe: a password file written for this purpose only (in the run directory, 0600) holding a placeholder, used for the transaction endpoint with exactly the worker
 * login and exactly the nonexistent login. Returns both outcomes; the file is removed whatever happens.
 */
export async function wrongPasswordProbe(ctx, runDir) {
  assertContext(ctx);
  const { real, fake } = probeLogins(ctx);
  const t = ctx.targets;
  const file = path.join(runDir, 'wrong-pgpass');
  writeFileSync(file, `${t.txn.host}:${t.txn.port}:postgres:${real}:deliberately-wrong-1\n${t.txn.host}:${t.txn.port}:postgres:${fake}:deliberately-wrong-1\n`, { mode: 0o600 });
  try {
    const script = wrapScript('read', 'select 1', 15_000);
    const a = await execPsql(ctx, 'worker-txn', script, { passfile: file, user: real, timeoutMs: 30_000 });
    const b = await execPsql(ctx, 'worker-txn', script, { passfile: file, user: fake, timeoutMs: 30_000 });
    return { real: a, fake: b };
  } finally { rmSync(file, { force: true }); }
}
