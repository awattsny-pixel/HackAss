// Constants and target validation for the hosted verification scripts (docs/hosted/verification-procedure.md, H0).
// Everything here is pure: no network, no child process, no secret is read except to inspect a key's `ref` claim, and nothing is printed.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePassfileEntries } from './passfile.mjs';
import { privateFileProblems } from './secretfile.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The one hosted project these scripts may ever mutate (named by the owner on 2026-10-15). */
export const STAGING = Object.freeze({ name: 'hackass-staging', ref: 'foptxhdnhudburqtnflt', region: 'us-east-1', postgres: '17.11.0.003' });
/** Container image whose `psql` is the database client (the same Supabase Postgres line as the local stack; the password file is mounted into it read-only). */
export const PSQL_IMAGE = 'public.ecr.aws/supabase/postgres:17.11.0.004';
/** The Supabase CLI the migrations are applied with (scripts/supabase-cli-pin.json). */
export const SUPABASE_CLI_VERSION = '2.120.0';

/** The 19 `api` functions that may appear in the exposed OpenAPI description (verified against the 010 golden inventory by a test). */
export const API_FUNCTIONS = Object.freeze(['create_draft', 'delete_draft', 'get_public_hack', 'get_publication', 'get_submission_for_review', 'get_version', 'list_my_versions', 'list_public_hacks', 'list_submissions_for_review', 'publish_version', 'record_decision', 'record_rights_review', 'record_risk_assessment', 'save_draft', 'staff_probe', 'start_review', 'submit_version', 'whoami', 'withdraw_publication']);
export const APP_SCHEMAS = Object.freeze(['app', 'app_guard', 'api', 'worker', 'app_bridge', 'app_content', 'app_review', 'app_budget']);

/** Two profiles. `staging` accepts only the hosted staging project; `selftest` accepts only the disposable LOCAL stack. Neither accepts the other's targets. */
export const PROFILES = Object.freeze(['staging', 'selftest']);

export const ENV_NAMES = Object.freeze(['STAGING_REF', 'STAGING_URL', 'STAGING_MIGRATE_HOST', 'STAGING_MIGRATE_PORT', 'STAGING_MIGRATE_USER', 'STAGING_POOLER_TXN_HOST', 'STAGING_POOLER_TXN_PORT',
  'STAGING_POOLER_SESSION_HOST', 'STAGING_POOLER_SESSION_PORT', 'STAGING_WORKER_USER', 'STAGING_PGPASSFILE', 'STAGING_PUBLISHABLE_KEY', 'STAGING_SECRET_KEY', 'FORBIDDEN_PROJECT_REFS']);

const POOLER_SUFFIX = '.pooler.supabase.com';
const SELFTEST_HOST = 'host.docker.internal';
const LOOPBACKISH = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$|\.internal$|^supabase_/i;

function jwtRef(token) {
  try { const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()); return typeof p.ref === 'string' ? p.ref : null; } catch { return null; }
}
const num = (v) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : NaN);

/**
 * H0. Validate every target BEFORE anything is contacted. Returns { errors, targets } (errors empty = pass). `env` is a plain object (never process.env spread into a child).
 * The API URL, the migration login, both pooler endpoints, the worker login and the password file are each validated on their own: a correct API reference does
 * not establish that a database connection reaches the same project.
 */
export function validateTargets(env, { profile = 'staging', repoRoot = REPO_ROOT, uid = process.getuid?.() } = {}) {
  const errors = [];
  const bad = (m) => errors.push(m);
  if (!PROFILES.includes(profile)) { bad(`unknown profile ${profile}`); return { errors, targets: null }; }
  const selftest = profile === 'selftest';
  const ref = env.STAGING_REF ?? '';
  const expectedRef = selftest ? 'selftest' : STAGING.ref;
  if (ref !== expectedRef) bad(`STAGING_REF must be exactly "${expectedRef}" for the ${profile} profile`);
  const forbidden = String(env.FORBIDDEN_PROJECT_REFS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!selftest && forbidden.length === 0) bad('FORBIDDEN_PROJECT_REFS must name at least the exposed project (owner input O5)');
  if (forbidden.includes(ref)) bad('STAGING_REF is in FORBIDDEN_PROJECT_REFS');
  for (const name of ENV_NAMES) {
    if (name === 'FORBIDDEN_PROJECT_REFS' || /KEY$/.test(name)) continue;
    const v = String(env[name] ?? '');
    for (const f of forbidden) if (f && v.includes(f)) bad(`${name} contains a forbidden project reference`);
  }
  const t = {
    ref, url: env.STAGING_URL ?? '',
    migrate: { host: env.STAGING_MIGRATE_HOST ?? '', port: num(env.STAGING_MIGRATE_PORT), user: env.STAGING_MIGRATE_USER ?? '' },
    txn: { host: env.STAGING_POOLER_TXN_HOST ?? '', port: num(env.STAGING_POOLER_TXN_PORT) },
    session: { host: env.STAGING_POOLER_SESSION_HOST ?? '', port: num(env.STAGING_POOLER_SESSION_PORT) },
    workerUser: env.STAGING_WORKER_USER ?? '', passfile: env.STAGING_PGPASSFILE ?? '', profile,
  };
  const dnsName = (h) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(h) && !/^\d+(\.\d+){3}$/.test(h);
  if (selftest) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(t.url)) bad('selftest STAGING_URL must be http://127.0.0.1:<port>');
    for (const [n, h] of [['migrate', t.migrate.host], ['pooler transaction', t.txn.host], ['pooler session', t.session.host]]) if (h !== SELFTEST_HOST) bad(`selftest ${n} host must be ${SELFTEST_HOST}`);
    if (t.migrate.user !== 'postgres') bad('selftest migration login must be postgres');
    if (t.workerUser !== 'hackass_worker') bad('selftest worker login must be hackass_worker');
    for (const p of [t.migrate.port, t.txn.port, t.session.port]) if (!(p >= 1024 && p <= 65535)) bad('selftest ports must be unprivileged numbers');
  } else {
    if (t.url !== `https://${ref}.supabase.co`) bad('STAGING_URL must equal https://<ref>.supabase.co for the staging reference');
    const direct = `db.${ref}.supabase.co`;
    const mHost = t.migrate.host;
    if (mHost.endsWith(POOLER_SUFFIX)) { if (t.migrate.user !== `postgres.${ref}`) bad(`migration login on the pooler must be postgres.${ref}`); }
    else if (mHost === direct) { if (t.migrate.user !== 'postgres') bad('migration login on the direct host must be postgres'); }
    else bad(`migration host must end ${POOLER_SUFFIX} or be exactly ${direct}`);
    if (![5432, 6543].includes(t.migrate.port)) bad('migration port must be 5432 or 6543');
    if (!t.txn.host.endsWith(POOLER_SUFFIX)) bad(`pooler transaction host must end ${POOLER_SUFFIX}`);
    if (!t.session.host.endsWith(POOLER_SUFFIX)) bad(`pooler session host must end ${POOLER_SUFFIX}`);
    if (t.txn.port !== 6543) bad('pooler transaction port must be 6543');
    if (t.session.port !== 5432) bad('pooler session port must be 5432');
    if (t.txn.host !== t.session.host) bad('pooler transaction and session hosts must be the same host (one project, one region)');
    if (mHost.endsWith(POOLER_SUFFIX) && mHost !== t.txn.host) bad('the migration host must equal the pooler host');
    for (const [n, h] of [['migration', mHost], ['pooler transaction', t.txn.host], ['pooler session', t.session.host]]) {
      if (!dnsName(h) || LOOPBACKISH.test(h)) bad(`${n} host must be a public DNS name (not an address, loopback, private, link-local or container name)`);
    }
    if (t.workerUser !== `hackass_worker.${ref}`) bad(`worker login must be hackass_worker.${ref}`);
  }
  // password file: absolute, a regular non-symlink file, 0600, owned by the caller, outside the repository; logins carry the reference; every login actually used has an entry
  const fileProblems = privateFileProblems(t.passfile, { repoRoot, uid, label: 'STAGING_PGPASSFILE' });
  for (const m of fileProblems) bad(m);
  if (!fileProblems.some((m) => /does not exist|cannot be inspected|not set|absolute|symbolic link|not a regular file/.test(m))) {
    try {
      const entries = parsePassfileEntries(t.passfile); // host, port, database, login only: the password field is never read
      const need = [[t.migrate.host, t.migrate.port, t.migrate.user], [t.txn.host, t.txn.port, t.workerUser], [t.session.host, t.session.port, t.workerUser], [t.txn.host, t.txn.port, t.migrate.user], [t.session.host, t.session.port, t.migrate.user]];
      const match = (e, h, p, u) => (e.host === '*' || e.host === h) && (e.port === '*' || e.port === String(p)) && (e.database === '*' || e.database === 'postgres') && (e.login === '*' || e.login === u);
      for (const [h, p, u] of need) if (!entries.some((e) => match(e, h, p, u))) bad(`the password file has no entry for ${u}@${h}:${p}`);
      if (!selftest) for (const e of entries) if (e.login !== 'postgres' && !e.login.endsWith(`.${ref}`) && e.login !== '*') bad(`a password file entry has a login without the .${ref} suffix`);
      for (const e of entries) for (const f of forbidden) if (f && (e.login.includes(f) || e.host.includes(f))) bad('a password file entry names a forbidden project reference');
    } catch (e) { bad(e instanceof Error && /password file/.test(e.message) ? e.message : 'STAGING_PGPASSFILE cannot be read'); }
  }
  // keys: required; JWT-shaped keys must carry this project's ref
  for (const k of ['STAGING_PUBLISHABLE_KEY', 'STAGING_SECRET_KEY']) {
    const v = env[k];
    if (!v) { bad(`${k} is not set`); continue; }
    const r = jwtRef(v);
    if (r !== null && r !== ref && !selftest) bad(`${k} carries a different project reference`);
    if (forbidden.some((f) => f && r === f)) bad(`${k} belongs to a forbidden project`);
  }
  return { errors, targets: t };
}

/** libpq connection string (no password, no secret). sslmode is fixed by the profile, never taken from the environment. */
export function conninfo({ host, port, user, profile, appName }) {
  if (appName !== undefined && !/^hackass-[a-z0-9-]{3,48}$/.test(appName)) throw new Error('unexpected application name');
  return `host=${host} port=${port} dbname=postgres user=${user} sslmode=${profile === 'selftest' ? 'disable' : 'require'} connect_timeout=15${appName ? ` application_name=${appName}` : ''}`;
}
/**
 * Password-free `postgresql://` URL for the Supabase CLI (the password file path is passed through PGPASSFILE by the caller). `limits` become STARTUP OPTIONS of the CLI's database session
 * (`options=-c name=value ...`), so the SERVER enforces them whatever happens to the client process: lock wait, statement time, idle-in-transaction time and a connection check that
 * ends a session whose client has died. (The CLI ignores an application_name given in the URL, so the session cannot be named; see lib/migrate.mjs.)
 */
export function cliUrl({ host, port, user, profile, limits }) {
  const h = profile === 'selftest' && host === SELFTEST_HOST ? '127.0.0.1' : host; // the CLI runs on the host, the container-side name does not resolve there
  const q = [`sslmode=${profile === 'selftest' ? 'disable' : 'require'}`];
  if (limits) {
    const opts = [['lock_timeout', limits.lockTimeoutMs], ['statement_timeout', limits.statementTimeoutMs], ['idle_in_transaction_session_timeout', limits.idleInTxnMs], ['client_connection_check_interval', limits.connectionCheckMs]];
    for (const [k, v] of opts) if (!Number.isInteger(v) || v < 0 || v > 86_400_000) throw new Error(`invalid server-side limit ${k}`);
    q.push(`options=${encodeURIComponent(opts.map(([k, v]) => `-c ${k}=${v}`).join(' '))}`);
  }
  return `postgresql://${encodeURIComponent(user)}@${h}:${port}/postgres?${q.join('&')}`;
}
