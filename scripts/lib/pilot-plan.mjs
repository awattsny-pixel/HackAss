// PURE planning for the pilot migration apply (no I/O): compares the manifest, the files on disk (as SHA-256) and the database's migration ledger, and says what is pending or why
// applying must refuse. It encodes the rules: the ledger must be an exact PREFIX of the manifest (no unknown version, no gap, no renamed migration), every file must equal its
// manifest hash, and nothing is "re-applied". Used by scripts/pilot-apply.mjs and tested in tests/pilot-apply.test.ts.
/**
 * @param {{ migrations: { order: number; file: string; version: string; name: string; sha256: string }[] }} manifest
 * @param {Record<string, string>} fileHashes file name -> sha256 of the file as it is on disk now
 * @param {{ version: string; name: string }[]} ledger rows already applied in the database
 * @returns {{ ok: true; applied: number; pending: { order: number; file: string; version: string; name: string }[] } | { ok: false; refusals: string[] }}
 */
export function planApply(manifest, fileHashes, ledger) {
  const refusals = [];
  const ms = manifest.migrations;
  for (const m of ms) {
    if (!(m.file in fileHashes)) refusals.push(`migration file missing on disk: ${m.file}`);
    else if (fileHashes[m.file] !== m.sha256) refusals.push(`migration file differs from the manifest (SHA-256): ${m.file}`);
  }
  for (const f of Object.keys(fileHashes)) if (!ms.some((m) => m.file === f)) refusals.push(`migration file not in the manifest: ${f}`);
  const rows = [...ledger].sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  if (new Set(rows.map((r) => r.version)).size !== rows.length) refusals.push('the ledger lists a version twice');
  rows.forEach((r, i) => {
    const m = ms[i];
    if (!m) refusals.push(`the ledger has a version beyond the manifest: ${r.version}`);
    else if (m.version !== r.version) refusals.push(`the ledger is not a prefix of the manifest: position ${i + 1} is ${r.version}, expected ${m.version} (an unknown version or a gap)`);
    else if (m.name !== r.name) refusals.push(`the ledger name differs from the manifest for ${r.version}: "${r.name}" vs "${m.name}"`);
  });
  if (refusals.length) return { ok: false, refusals };
  return { ok: true, applied: rows.length, pending: ms.slice(rows.length).map(({ order, file, version, name }) => ({ order, file, version, name })) };
}

// The disposable staging project is never a pilot target (its history and records are preserved untouched). Its reference is the one recorded in scripts/hosted/lib/config.mjs.
export const FORBIDDEN_PILOT_REFS = Object.freeze(['foptxhdnhudburqtnflt']);
const REF_PATTERN = /^[a-z0-9]{20}$/;
// libpq variables that could silently redirect or alter a connection after the checks above passed (a service file can override host, user and database)
const LIBPQ_CONFLICTS = ['PGSERVICE', 'PGSERVICEFILE', 'PGHOSTADDR', 'PGOPTIONS', 'PGSYSCONFDIR'];

/** The project reference in a direct database host db.<ref>.supabase.co, or null. */
export function refFromDbHost(host) { const m = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(host ?? ''); return m ? m[1] : null; }

/**
 * Connection safety for a HOSTED database run (apply AND inventory share it): the direct host of one project, port 5432, login postgres, database postgres, verified TLS, never a pooler,
 * never the staging project, no libpq variable that can override the connection. Returns a list of refusals (empty = acceptable).
 * @param {{ host?: string; port?: string; user?: string; database?: string; sslmode?: string; sslrootcert?: string; expectHost?: string; env?: Record<string, string | undefined> }} t
 */
export function checkHostedTarget({ host, port, user, database, sslmode, sslrootcert, expectHost, env = {} }) {
  const r = [];
  if (!expectHost || !/^db\.[a-z0-9]{20}\.supabase\.co$/.test(expectHost)) r.push('--expect-host must be the direct host db.<project-ref>.supabase.co');
  if (host !== expectHost) r.push('PGHOST does not equal --expect-host');
  if (/pooler/i.test(host ?? '') || /pooler/i.test(user ?? '')) r.push('a pooler is refused: migrations run only over the direct connection');
  if (String(port ?? '5432') !== '5432') r.push('PGPORT must be 5432 (the direct connection)');
  if (user !== 'postgres') r.push('PGUSER must be postgres (the direct login)');
  if (database !== 'postgres') r.push('PGDATABASE must be set to postgres');
  if (sslmode !== 'verify-full') r.push('PGSSLMODE must be verify-full');
  if (!sslrootcert) r.push('PGSSLROOTCERT must name the root certificate file');
  const ref = refFromDbHost(expectHost);
  if (ref && FORBIDDEN_PILOT_REFS.includes(ref)) r.push('that is the disposable staging project; it is never a pilot target');
  for (const n of LIBPQ_CONFLICTS) if (env[n]) r.push(`${n} is set: it can override the connection; unset it`);
  return r;
}

/**
 * The hosted API target for the RPC checks, bound to the same project as the database tools: https only, exactly https://<ref>.supabase.co (no port, path, credentials or query),
 * the reference confirmed by --confirm-pilot, never the staging project. The operator's secret key is read only after this returns no refusals.
 * @param {{ apiUrl?: string; confirmRef?: string }} t
 */
export function checkHostedApiTarget({ apiUrl, confirmRef }) {
  const r = [];
  let u = null; try { u = new URL(apiUrl ?? ''); } catch { r.push('PILOT_API_URL must be a URL'); }
  if (u) {
    if (u.protocol !== 'https:') r.push('PILOT_API_URL must be https');
    if (u.username || u.password || u.port || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) r.push('PILOT_API_URL must be exactly https://<project-ref>.supabase.co');
    const m = /^([a-z0-9]{20})\.supabase\.co$/.exec(u.hostname);
    if (!m) r.push('PILOT_API_URL host must be <project-ref>.supabase.co');
    else {
      if (FORBIDDEN_PILOT_REFS.includes(m[1])) r.push('that is the disposable staging project; it is never a pilot target');
      if (!REF_PATTERN.test(confirmRef ?? '') || confirmRef !== m[1]) r.push('--confirm-pilot must equal the project reference in PILOT_API_URL');
    }
  }
  return r;
}
