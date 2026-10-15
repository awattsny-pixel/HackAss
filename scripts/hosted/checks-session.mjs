#!/usr/bin/env node
// Authorization S8 (MUTATING): `session-checks` = H6 (session revocation), H7 (staff removal), H8 (real-token MFA expiry). Each check uses its OWN dedicated fixture user
// (s-sess, s-rm, s-mfa) so nothing a check destroys is needed by a later one. Needs the `fixtures` stage.
// Usage: node scripts/hosted/checks-session.mjs --run-id=... --authorized=S8@<sha> --confirm-mutating=session-checks [--default-window]
import { runStage, checker, ok } from './lib/cli.mjs';
import { runSql } from './lib/pg.mjs';
import { signIn, signOut, getUser, refreshSession, api, errMsg, claims, header, steppedUp } from './lib/flows.mjs';
import { STAFF_REVOKE_SQL } from './lib/sqlguard.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const code = await runStage('session-checks', process.argv.slice(2), async ({ ctx, run, flags, say }) => {
  const c = checker(run, say);
  const state = run.state(); const sec = run.secrets();
  const fx = (n) => ({ ...state.fixtures.users[n], password: sec.users[n].password });
  const ids = () => new Set(Object.values(state.fixtures.users).map((u) => u.id.toLowerCase()));
  const probe = (token, args = {}) => api(ctx, 'staff_probe', token, args);

  await c.check('H6', 'a signed-out session is refused INSIDE the database while its token is still unexpired and validly signed', async () => {
    const u = fx('s-sess');
    const s = await signIn(ctx, u.email, u.password);
    const before = await api(ctx, 'whoami', s.access_token, {});
    ok(before.status === 200, `whoami before sign-out: HTTP ${before.status} ${errMsg(before) ?? ''}`);
    const out = await signOut(ctx, s.access_token);
    ok(out.status === 204 || out.status === 200, `sign out: HTTP ${out.status}`);
    const after = await api(ctx, 'whoami', s.access_token, {});
    ok(after.status === 403 && /session_invalid/.test(errMsg(after) ?? ''), `whoami after sign-out: HTTP ${after.status} ${errMsg(after) ?? ''} (expected 403 session_invalid)`);
    const cl = claims(s.access_token);
    ok(cl.exp * 1000 > Date.now(), 'the token had already expired, so the refusal proves nothing about the session check');
    const user = await getUser(ctx, s.access_token);
    ok(user.status >= 400, `the Auth server still accepts the revoked token (HTTP ${user.status})`);
    return `expires_in ${s.expires_in}s; header alg ${header(s.access_token).alg}; whoami 200 then 403 session_invalid with exp ${Math.round(cl.exp - Date.now() / 1000)}s ahead; /auth/v1/user HTTP ${user.status}`;
  });

  await c.check('H7', 'removing a staff assignment takes effect on the very next call with the same token', async () => {
    const u = fx('s-rm');
    const t = await steppedUp(ctx, run, 's-rm');
    const a = await probe(t.access_token);
    ok(a.status === 200, `staff_probe before revocation: HTTP ${a.status} ${errMsg(a) ?? ''}`);
    const rev = await runSql(ctx, 'migrate', `set role hackass_owner;\n${STAFF_REVOKE_SQL(u.id)};`, { kind: 'fixture', fixtureIds: ids() });
    ok(rev.ok, `revocation failed: ${rev.stderr.split('\n')[0]}`);
    const b = await probe(t.access_token);
    ok(b.status === 403 && /not_staff/.test(errMsg(b) ?? ''), `staff_probe after revocation: HTTP ${b.status} ${errMsg(b) ?? ''} (expected 403 not_staff)`);
    return 'success before; not_staff at once after, same token';
  });

  await c.check('H8', 'a staff step-up older than the window is refused although the access token is unexpired (fast path)', async () => {
    const t = await steppedUp(ctx, run, 's-mfa');
    const cl = claims(t.access_token);
    ok(cl.aal === 'aal2' && Array.isArray(cl.amr) && cl.amr.some((m) => m.method === 'totp' && Number.isFinite(m.timestamp)), `token lacks aal2 or a totp amr entry (aal ${cl.aal})`);
    const a = await probe(t.access_token, { p_max_mfa_age_seconds: 60 });
    ok(a.status === 200, `staff_probe(60 s) fresh: HTTP ${a.status} ${errMsg(a) ?? ''}`);
    await sleep(70_000);
    const b = await probe(t.access_token, { p_max_mfa_age_seconds: 60 });
    ok(b.status === 403 && /mfa_stale/.test(errMsg(b) ?? ''), `staff_probe(60 s) after 70 s: HTTP ${b.status} ${errMsg(b) ?? ''} (expected 403 mfa_stale)`);
    ok(claims(t.access_token).exp * 1000 > Date.now(), 'the token expired during the wait');
    return `aal2 with a totp amr timestamp; fresh 200; mfa_stale after 70 s with the token still unexpired`;
  });

  if (flags['default-window']) {
    await c.check('H8-default', 'the default 15-minute window: a refreshed token keeps the original MFA timestamp and is refused after 16 minutes (about 17 minutes)', async () => {
      const t0 = Date.now();
      let t = await steppedUp(ctx, run, 's-mfa');
      const amr0 = claims(t.access_token).amr.find((m) => m.method === 'totp').timestamp;
      const a = await probe(t.access_token);
      ok(a.status === 200, `staff_probe with default arguments, fresh: HTTP ${a.status} ${errMsg(a) ?? ''}`);
      await sleep(9 * 60_000);
      const r = await refreshSession(ctx, t.refresh_token);
      const amr1 = claims(r.access_token).amr.find((m) => m.method === 'totp')?.timestamp;
      ok(amr1 === amr0, `the refreshed token's totp amr timestamp moved (${amr0} -> ${amr1}): record this platform fact and review the expectation`);
      const wait = 16 * 60_000 - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
      const b = await probe(r.access_token);
      ok(b.status === 403 && /mfa_stale/.test(errMsg(b) ?? ''), `staff_probe with default arguments at about 16 minutes: HTTP ${b.status} ${errMsg(b) ?? ''} (expected 403 mfa_stale)`);
      ok(claims(r.access_token).exp * 1000 > Date.now(), 'the refreshed token had expired');
      return 'refresh kept the amr timestamp; mfa_stale at about 16 minutes with the token unexpired';
    });
  }
  return c.out;
});
process.exitCode = code;
