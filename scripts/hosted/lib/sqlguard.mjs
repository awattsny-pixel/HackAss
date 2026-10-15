// The allowlist for SQL the hosted scripts may send (docs/hosted/verification-procedure.md section 1). Three kinds:
//   read   - queries only (select/show/with ... select); no data-changing keyword anywhere outside string literals;
//   admin  - role administration, run as `postgres` and NEVER after SET ROLE: only the worker marker (a role comment) and its removal;
//   probe  - statements that are EXPECTED to be refused by the database (worker privilege probes): only the fixed list PROBES below;
//   fixture - application DML run as hackass_owner (SET ROLE is reserved for this kind): the staff-assignment insert/revocation for fixture users created in
//            this run and the one scoped job update.
// Anything else, and anything on the forbidden list, is refused before it leaves the process.
export class SqlRefused extends Error {}

/** Statements the worker login is expected to be refused (H9). Exact strings only. */
export const PROBES = Object.freeze(['select 1 from app.accounts limit 1', 'select 1 from app.jobs limit 1', 'select api.whoami()', 'select app_budget.today()', 'select app_review.utc_today()', 'set role hackass_owner', 'select 1 from auth.users limit 1', 'create table public.x (i int)']);

const FORBIDDEN = [/\bdrop\s+(schema|role|table|database|function)\b/i, /\btruncate\b/i, /\bdisable\s+trigger\b/i, /\bcreate\s+(table|role|schema|extension|function)\b/i, /\bgrant\b/i, /\brevoke\b/i, /\bcopy\b/i, /\bpg_terminate_backend\b/i, /\bset_config\b/i, /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export)\b/i];
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

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const NONCE = '[0-9a-f]{16,64}';
const SHAPES = {
  setRole: /^set\s+role\s+hackass_owner$/i,
  resetRole: /^reset\s+role$/i,
  txn: /^(begin|commit|rollback)$/i,
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
export function checkSql(sql, kind, { fixtureIds = new Set(), allowedJobTargets = new Set() } = {}) {
  if (!['read', 'admin', 'fixture', 'probe'].includes(kind)) throw new SqlRefused(`unknown SQL kind ${kind}`);
  if (kind === 'probe') { const one = sql.replace(/;\s*$/, '').replace(/\s+/g, ' ').trim(); if (!PROBES.includes(one)) throw new SqlRefused('not one of the fixed worker privilege probes'); return [one]; }
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
    if (SHAPES.txn.test(one)) continue;
    if (kind === 'read') {
      const b = stripLiterals(one);
      if (!/^(select|show|with)\b/i.test(b)) throw new SqlRefused(`not a read statement: ${one.slice(0, 50)}`);
      if (/\b(insert|update|delete|alter|create|drop|truncate|merge|call|do|execute|perform|set_config|nextval|setval|pg_sleep_for)\b/i.test(b.replace(/\bupdated_at\b|\bcreated_at\b|\bdeleted\b/gi, ''))) throw new SqlRefused(`data-changing keyword in a read: ${one.slice(0, 50)}`);
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
    if (/^(select|show|with)\b/i.test(stripLiterals(one))) continue; // owner-side verification reads
    throw new SqlRefused(`fixture statement not on the allowlist: ${one.slice(0, 60)}`);
  }
  return stmts;
}
