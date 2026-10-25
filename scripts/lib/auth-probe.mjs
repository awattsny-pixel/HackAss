// Stack health probe for the PX-3c browser harness: times create-user / sign-in / delete-user round trips and reports them. Kept apart from the harness so the cleanup rules can be tested
// with fake clients. A probe is "clean" only when every call succeeded AND every fixture it created was confirmed deleted; a failed or thrown deletion is an error, never a silent pass.
export const pct = (a, q) => { const v = [...a].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(q * v.length))]; };
const tag = (e) => (e ? `err${e.status ?? ''}` : 'ok');

/** One round trip. Cleanup is attempted whenever a user was created, even if sign-in threw or failed. Never throws: every outcome is recorded in the row. */
export async function probeOnce({ admin, makeAnon, email, password, now = Date.now, clock = () => '' }) {
  const row = { at: clock(), create_ms: 0, create: 'ok', signin_ms: 0, signin: 'ok', delete_ms: 0, delete: 'skipped' };
  const t0 = now(); let userId = null;
  try { const c = await admin.auth.admin.createUser({ email, password, email_confirm: true }); row.create = tag(c.error); userId = c.data?.user?.id ?? null; } catch { row.create = 'threw'; }
  const t1 = now(); row.create_ms = t1 - t0;
  if (userId !== null) {
    try { const si = await makeAnon().auth.signInWithPassword({ email, password }); row.signin = tag(si.error); } catch { row.signin = 'threw'; }
  } else row.signin = 'skipped';
  const t2 = now(); row.signin_ms = t2 - t1;
  if (userId !== null) {
    try { const d = await admin.auth.admin.deleteUser(userId); row.delete = tag(d?.error); } catch { row.delete = 'threw'; }
  }
  row.delete_ms = now() - t2; row.fixture = userId; // the id (not an email or token) lets the caller report a fixture that could not be removed
  return row;
}

export async function authProbe(n, deps) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(await probeOnce({ ...deps, email: `probe-${deps.rand()}@example.test` }));
  return rows;
}

/** Fixtures the probe created and could not confirm deleted (ids only). */
export const leftBehind = (rows) => rows.filter((r) => r.fixture && r.delete !== 'ok').map((r) => r.fixture);

export const probeSummary = (rows, env = {}) => {
  const left = leftBehind(rows);
  return {
    n: rows.length,
    create_ms: { p50: pct(rows.map((r) => r.create_ms), .5), max: Math.max(...rows.map((r) => r.create_ms)) },
    signin_ms: { p50: pct(rows.map((r) => r.signin_ms), .5), p90: pct(rows.map((r) => r.signin_ms), .9), max: Math.max(...rows.map((r) => r.signin_ms)) },
    delete_ms: { p50: pct(rows.map((r) => r.delete_ms), .5), max: Math.max(...rows.map((r) => r.delete_ms)) },
    errors: rows.filter((r) => r.create !== 'ok' || r.signin !== 'ok').length,
    delete_errors: rows.filter((r) => r.delete !== 'ok' && r.delete !== 'skipped').length,
    unconfirmed_cleanup: left.length, // fixtures whose deletion was not confirmed
    ...env,
  };
};

/** The gate: slow, any error of any kind, or any unconfirmed cleanup. */
export const probeBlocked = (sum, { maxMs, p90Ms }) =>
  sum.errors > 0 || sum.delete_errors > 0 || sum.unconfirmed_cleanup > 0 || Math.max(sum.signin_ms.max, sum.create_ms.max, sum.delete_ms.max) > maxMs || sum.signin_ms.p90 > p90Ms;
