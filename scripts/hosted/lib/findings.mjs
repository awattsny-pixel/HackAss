// Known findings: a finding may be carried by an explicit, narrowly scoped exception, so the checks after it can still be run, WITHOUT the finding being accepted, hidden or counted as a pass.
// An excepted check is recorded with status EXCEPTION (never PASS), keeps the observed messages, and makes the evidence outcome FAILED while the finding is open.
//
// F-H9-1: the staging pooler's transaction endpoint answers a wrong password for the real worker login with a password-authentication failure, and a nonexistent login with
// `(EAUTHQUERY) user not found in the database`. The two refusals differ (a username/login-existence disclosure). Confirmed: the DIFFERING REFUSAL MESSAGES. Not captured: the authentication
// exchange itself (for example whether a password was requested or sent before the nonexistent login was refused), so nothing is claimed about it.
export const KNOWN_FINDINGS = Object.freeze({
  'F-H9-1': Object.freeze({ check: 'H9b', stage: 'worker-checks', title: 'the pooler transaction endpoint refuses a nonexistent login differently from a wrong password for the real login (login-existence disclosure; the authentication exchange was not captured)' }),
});

const REAL_REFUSAL = /^psql: error: connection to server at .* failed: FATAL:\s+password authentication failed for user "[^"]*"$/;
const FAKE_REFUSAL = /^psql: error: connection to server at .* failed: FATAL:\s+\(EAUTHQUERY\) user not found in the database$/;
const firstLine = (e) => String(e ?? '').split('\n').find((l) => /failed|FATAL|error/i.test(l)) ?? '';
const refused = (r) => r && r.ok === false && r.code === 2 && typeof r.stderr === 'string'; // psql exit 2 = the connection was refused; a success, a timeout (thrown earlier) or another exit never qualifies

/** H9's own uniformity key (user names normalised, parenthesised text removed, first failure line): identical to the comparison in checks-worker.mjs before the split. */
export const h9Key = (stderr) => firstLine(stderr).replace(/user "[^"]*"/g, 'user "X"').replace(/\(.*?\)/g, '');

/**
 * Judge the two wrong-password refusals of H9b. `knownFinding` is the exception named on the command line (or null).
 * Returns { status: 'PASS' | 'EXCEPTION' | 'FAIL', error?, real, fake } with the first failure line of each (already redacted by the caller's transport).
 *  - the refusals are the same (after H9's normalisation): PASS, with or without the exception (a fixed pooler passes normally);
 *  - they differ, with no exception: FAIL, exactly as before;
 *  - they differ, the exception F-H9-1 is named, and the pair is EXACTLY the observed pair (real: password authentication failure; nonexistent: `(EAUTHQUERY) user not found in the database`;
 *    both refused with exit 2): EXCEPTION;
 *  - anything else, with or without the exception (a success, a different exit code, a connection failure, a timeout, any other message): FAIL.
 */
export function judgeUniformRefusal({ real, fake, knownFinding = null }) {
  const lines = { real: firstLine(real?.stderr), fake: firstLine(fake?.stderr) };
  if (!refused(real) || !refused(fake)) return { status: 'FAIL', error: 'a wrong password was not refused as a failed connection (exit 2) for both logins', ...lines };
  if (h9Key(real.stderr) === h9Key(fake.stderr)) return { status: 'PASS', ...lines };
  if (knownFinding === null) return { status: 'FAIL', error: 'the refusal for a nonexistent role differs from the one for the real role (existence oracle)', ...lines };
  if (!Object.hasOwn(KNOWN_FINDINGS, knownFinding)) return { status: 'FAIL', error: `unknown finding ${knownFinding}`, ...lines };
  if (REAL_REFUSAL.test(lines.real) && FAKE_REFUSAL.test(lines.fake)) return { status: 'EXCEPTION', finding: knownFinding, ...lines };
  return { status: 'FAIL', error: `the refusals differ and are not the responses ${knownFinding} covers (a password-authentication failure for the real login and "(EAUTHQUERY) user not found in the database" for the nonexistent one)`, ...lines };
}
