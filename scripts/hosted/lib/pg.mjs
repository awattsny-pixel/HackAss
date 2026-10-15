// Database access through the `psql` of a container image, with the password file mounted read-only and a password-free connection string.
// The password never appears in an argument, an environment variable or an output. Every call is bounded and every script passes the SQL allowlist first.
import { assertContext } from './context.mjs';
import { PSQL_IMAGE, conninfo } from './config.mjs';
import { runBounded, childEnv } from './exec.mjs';
import { checkSql } from './sqlguard.mjs';
import { redact } from './redact.mjs';

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

export function dockerArgs(ctx, endpoint, { passfile = ctx.targets.passfile, login } = {}) {
  const info = { ...endpointInfo(ctx, endpoint), profile: ctx.profile };
  if (login) { // only the wrong-password probe may name another login, and only a worker-shaped or deliberately nonexistent one
    if (!/^hackass_(worker|nonexistent)(\.[a-z0-9]+)?$/.test(login)) throw new Error('refused login override');
    info.user = login;
  }
  return ['run', '--rm', '-i', ...(ctx.profile === 'selftest' ? ['--add-host', 'host.docker.internal:host-gateway'] : []), '-v', `${passfile}:/pgpass:ro`, '-e', 'PGPASSFILE=/pgpass',
    PSQL_IMAGE, 'psql', conninfo(info), '-X', '-v', 'ON_ERROR_STOP=1', '-At'];
}

/**
 * Run a SQL script. kind: read | admin | fixture | probe (see sqlguard). opts.fixtureIds / allowedJobTargets feed the guard.
 * Resolves { ok, stdout, stderr (redacted), code }; throws PgFailure on timeout, truncation or when the client cannot run. A nonzero psql exit is returned (ok=false),
 * because the privilege probes EXPECT refusals.
 */
export async function runSql(ctx, endpoint, sql, { kind = 'read', fixtureIds, allowedJobTargets, timeoutMs = 60_000, passfile, login } = {}) {
  assertContext(ctx);
  checkSql(sql, kind, { fixtureIds, allowedJobTargets });
  const r = await runBounded(process.env.DOCKER_BIN || 'docker', dockerArgs(ctx, endpoint, { passfile, login }), { input: sql, timeoutMs, env: childEnv() });
  if (r.timedOut) throw new PgFailure(`database call exceeded ${timeoutMs}ms (${endpoint})`, { timedOut: true });
  if (r.truncated) throw new PgFailure(`database output exceeded the size cap (${endpoint})`);
  return { ok: r.code === 0, code: r.code, stdout: r.stdout.trim(), stderr: redact(r.stderr.trim()) };
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
