// The allowlist for SQL the hosted scripts may send (docs/hosted/verification-procedure.md section 1). Kinds:
//   read   - queries only (select/show/with ... select, plus SET ROLE hackass_owner for owner-side reads); no data-changing keyword anywhere outside string literals. The
//            executor (pg.mjs) additionally runs every read inside BEGIN READ ONLY ... ROLLBACK, so the DATABASE refuses a write even if this check were wrong;
//   worker - the fixed worker-function calls of the job flow (H10), the only reads-that-write; run on the worker endpoints only, in their own transaction;
//   admin  - role administration, run as `postgres` and NEVER after SET ROLE: only the worker marker (a role comment) and its removal;
//   migration - the fixed statements that observe, cancel and terminate the Supabase CLI's own database session (identified by login, the CLI's session name and its start time);
//   probe  - statements that are EXPECTED to be refused by the database (worker privilege probes): only the fixed list PROBES below;
//   fixture - application DML run as hackass_owner (SET ROLE is reserved for this kind): the staff-assignment insert/revocation for fixture users created in
//            this run, the category insert and the one scoped job update. There is NO general select fallback in this kind.
// Anything else, and anything on the forbidden list, is refused before it leaves the process.
export class SqlRefused extends Error {}

/** The Supabase CLI's database sessions are named by the CLI itself (it ignores a name given in the URL). Observed for the pinned CLI 2.120.0 and asserted by the selftest. */
export const CLI_SESSION_NAME = '@effect/sql-pg';
const MARK = '\\d{10}\\.\\d{6}';
const ident = (mark) => `usename = current_user and application_name = '${CLI_SESSION_NAME}' and backend_start >= to_timestamp(${mark}) and pid <> pg_backend_pid()`;
/** The migration-session statements. `mark` is the SERVER clock (epoch seconds, 6 decimals) read just before the CLI was started: only sessions of the migration login, named like the CLI's, that started after it are touched. */
export const MIGRATION_SQL = Object.freeze({
  mark: "select extract(epoch from clock_timestamp())::numeric(16,6)::text",
  count: (mark) => `select count(*) from pg_stat_activity where ${ident(mark)}`,
  locks: (mark) => `select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid where a.usename = current_user and a.application_name = '${CLI_SESSION_NAME}' and a.backend_start >= to_timestamp(${mark}) and a.pid <> pg_backend_pid()`,
  stuck: "select count(*) from pg_stat_activity where usename = current_user and pid <> pg_backend_pid() and application_name not like 'hackass-psql-%' and (wait_event_type = 'Lock' or state like 'idle in transaction%')",
  cancel: (mark) => `select count(pg_cancel_backend(pid)) from pg_stat_activity where ${ident(mark)}`,
  terminate: (mark) => `select count(pg_terminate_backend(pid)) from pg_stat_activity where ${ident(mark)}`,
});
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MIGRATION_SHAPES = [MIGRATION_SQL.mark, MIGRATION_SQL.stuck].map((t) => new RegExp(`^${esc(t)}$`))
  .concat(['count', 'locks', 'cancel', 'terminate'].map((k) => new RegExp(`^${esc(MIGRATION_SQL[k]('@@')).replace('@@', MARK)}$`)));

/** Statements the worker login is expected to be refused (H9). Exact strings only. */
export const PROBES = Object.freeze(['select 1 from app.accounts limit 1', 'select 1 from app.jobs limit 1', 'select api.whoami()', 'select app_budget.today()', 'select app_review.utc_today()', 'set role hackass_owner', 'select 1 from auth.users limit 1', 'create table public.x (i int)']);

const FORBIDDEN = [/\bdrop\s+(schema|role|table|database|function)\b/i, /\btruncate\b/i, /\bdisable\s+trigger\b/i, /\bcreate\s+(table|role|schema|extension|function)\b/i, /\bgrant\b/i, /\brevoke\b/i, /\bcopy\b/i, /\bpg_terminate_backend\b/i, /\bpg_cancel_backend\b/i, /\bset_config\b/i, /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export)\b/i];
const stripLiterals = (sql) => sql.replace(/'(?:[^']|'')*'/g, "''").replace(/\$\$[\s\S]*?\$\$/g, '$$$$').replace(/--[^\n]*/g, '');

/** Split a script into statements on semicolons outside string literals and $$ bodies. */
export function splitStatements(sql) {
  const out = []; let cur = ''; let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") { let j = i + 1; while (j < sql.length) { if (sql[j] === "'" && sql[j + 1] === "'") j += 2; else if (sql[j] === "'") break; else j++; } cur += sql.slice(i, j + 1); i = j + 1; continue; }
    if (c === '$' && sql[i + 1] === '$') { const j = sql.indexOf('$$', i + 2); if (j < 0) { cur += sql.slice(i); break; } cur += sql.slice(i, j + 2); i = j + 2; continue; }
    if (c === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); i = j < 0 ? sql.length : j; continue; }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Worker calls that name no job (the claim takes the single due fixture job, which H10 has proved is the only due job). */
const WORKER_FIXED = Object.freeze(["select worker.claim_job('publication_recheck')::text", 'select worker.healthcheck()']);
const WORKER_SHAPE = /^select worker\.(get_job_subject|heartbeat_job|complete_job)\('([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', (\d{1,9})\)(::text)?$/i;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const NONCE = '[0-9a-f]{16,64}';
const SHAPES = {
  setRole: /^set\s+role\s+hackass_owner$/i,
  resetRole: /^reset\s+role$/i,
  staffInsert: new RegExp(`^insert\\s+into\\s+app\\.staff_assignments\\s*\\(user_id,\\s*role,\\s*granted_by\\)\\s+values\\s*\\('(${UUID})',\\s*'reviewer',\\s*'staging-check'\\)$`, 'i'),
  staffRevoke: new RegExp(`^update\\s+app\\.staff_assignments\\s+set\\s+revoked_at\\s*=\\s*now\\(\\),\\s*revoked_by\\s*=\\s*'staging-check'\\s+where\\s+user_id\\s*=\\s*'(${UUID})'\\s+and\\s+revoked_at\\s+is\\s+null$`, 'i'),
  categoryInsert: /^insert into app\.categories \(slug, name\) values \('(stg-[a-z0-9-]{3,40})', 'Staging [A-Za-z0-9 -]{1,60}'\) on conflict do nothing$/i,
  markerSet: new RegExp(`^comment\\s+on\\s+role\\s+hackass_worker\\s+is\\s+'(${NONCE})'$`, 'i'),
  markerReset: /^comment\s+on\s+role\s+hackass_worker\s+is\s+null$/i,
  jobDue: new RegExp(`^do\\s+\\$\\$\\s*declare\\s+n\\s+integer;\\s*begin\\s+update\\s+app\\.jobs\\s+set\\s+available_at\\s*=\\s*pg_catalog\\.now\\(\\)\\s*-\\s*interval\\s+'1 minute'\\s+where\\s+id\\s*=\\s*'(${UUID})'\\s+and\\s+target_publication_id\\s*=\\s*'(${UUID})'\\s+and\\s+status\\s*=\\s*'queued';\\s*get\\s+diagnostics\\s+n\\s*=\\s*row_count;\\s*if\\s+n\\s*<>\\s*1\\s+then\\s+raise\\s+exception\\s+'scoped job update touched % rows',\\s*n;\\s*end\\s+if;\\s*end\\s+\\$\\$$`, 'i'),
};
export const JOB_DUE_SQL = (jobId, pubId) => `do $$ declare n integer; begin update app.jobs set available_at = pg_catalog.now() - interval '1 minute' where id = '${jobId}' and target_publication_id = '${pubId}' and status = 'queued'; get diagnostics n = row_count; if n <> 1 then raise exception 'scoped job update touched % rows', n; end if; end $$`;
export const STAFF_INSERT_SQL = (uid) => `insert into app.staff_assignments (user_id, role, granted_by) values ('${uid}', 'reviewer', 'staging-check')`;
export const STAFF_REVOKE_SQL = (uid) => `update app.staff_assignments set revoked_at = now(), revoked_by = 'staging-check' where user_id = '${uid}' and revoked_at is null`;
export const CATEGORY_INSERT_SQL = (slug) => `insert into app.categories (slug, name) values ('${slug}', 'Staging check') on conflict do nothing`;
export const MARKER_SET_SQL = (nonce) => `comment on role hackass_worker is '${nonce}'`;
export const MARKER_RESET_SQL = 'comment on role hackass_worker is null';
export const MARKER_READ_SQL = "select shobj_description(r.oid, 'pg_authid') from pg_roles r where r.rolname = current_user";

/**
 * Check a script. `fixtureIds` is the set of user ids created in this run (a staff statement naming any other id is refused); `jobIds` likewise for the job update.
 * Returns the statements on success; throws SqlRefused otherwise.
 */
export function checkSql(sql, kind, { fixtureIds = new Set(), allowedJobTargets = new Set(), allowedJobIds = new Set() } = {}) {
  if (!['read', 'admin', 'fixture', 'probe', 'worker', 'migration'].includes(kind)) throw new SqlRefused(`unknown SQL kind ${kind}`);
  if (kind === 'probe') { const one = sql.replace(/;\s*$/, '').replace(/\s+/g, ' ').trim(); if (!PROBES.includes(one)) throw new SqlRefused('not one of the fixed worker privilege probes'); return [one]; }
  if (kind === 'migration') {
    const one = sql.replace(/;\s*$/, '').replace(/\s+/g, ' ').trim();
    if (!MIGRATION_SHAPES.some((re) => re.test(one))) throw new SqlRefused('not one of the fixed migration-session statements');
    return [one];
  }
  if (kind === 'worker') {
    const stmts = splitStatements(sql);
    if (stmts.length !== 1) throw new SqlRefused('a worker call is exactly one statement');
    const one = stmts[0].replace(/\s+/g, ' ').trim();
    if (WORKER_FIXED.includes(one)) return [one];
    const m = WORKER_SHAPE.exec(one);
    if (!m) throw new SqlRefused(`not one of the reviewed worker calls: ${one.slice(0, 60)}`);
    if (!allowedJobIds.has(m[2].toLowerCase())) throw new SqlRefused('the worker call names a job that was not registered as the synthetic fixture');
    return [one];
  }
  const bare = stripLiterals(sql);
  for (const re of FORBIDDEN) if (re.test(bare)) throw new SqlRefused(`forbidden SQL (${re})`);
  if (kind !== 'read' && /\bschema_migrations\b/i.test(bare)) throw new SqlRefused('the migration ledger may be read, never written');
  const stmts = splitStatements(sql);
  if (stmts.length === 0) throw new SqlRefused('empty SQL');
  let inOwner = false;
  for (const s of stmts) {
    const one = s.replace(/\s+/g, ' ').trim();
    if (SHAPES.setRole.test(one)) { if (kind !== 'fixture' && kind !== 'read') throw new SqlRefused('SET ROLE is reserved for fixture DML and owner-side reads'); inOwner = true; continue; }
    if (SHAPES.resetRole.test(one)) { inOwner = false; continue; }
    if (kind === 'read') {
      const b = stripLiterals(one);
      if (!/^(select|show|with)\b/i.test(b)) throw new SqlRefused(`not a read statement: ${one.slice(0, 50)}`);
      if (/\b(insert|update|delete|alter|create|drop|truncate|merge|call|do|execute|perform|set_config|nextval|setval|pg_sleep_for|into)\b/i.test(b.replace(/\bupdated_at\b|\bcreated_at\b|\bdeleted\b/gi, ''))) throw new SqlRefused(`data-changing keyword in a read: ${one.slice(0, 50)}`);
      continue;
    }
    if (kind === 'admin') {
      if (inOwner) throw new SqlRefused('role administration must run as postgres, not after SET ROLE');
      if (SHAPES.markerSet.test(one) || SHAPES.markerReset.test(one)) continue;
      throw new SqlRefused(`administration statement not on the allowlist: ${one.slice(0, 60)}`);
    }
    // fixture DML (hackass_owner)
    if (!inOwner) throw new SqlRefused('fixture DML requires SET ROLE hackass_owner first');
    let m;
    if ((m = SHAPES.staffInsert.exec(one)) || (m = SHAPES.staffRevoke.exec(one))) { if (!fixtureIds.has(m[1].toLowerCase())) throw new SqlRefused('staff statement names a user that is not a fixture created in this run'); continue; }
    if ((m = SHAPES.categoryInsert.exec(one))) continue;
    if ((m = SHAPES.jobDue.exec(s.trim()))) { if (!allowedJobTargets.has(`${m[1]}:${m[2]}`.toLowerCase())) throw new SqlRefused('job update names a job that was not registered as the synthetic fixture'); continue; }
    throw new SqlRefused(`fixture statement not on the allowlist: ${one.slice(0, 60)}`);
  }
  return stmts;
}
