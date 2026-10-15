// API-level building blocks for the checks: Auth admin and sign-in, TOTP step-up, and the member -> staff -> publish path through the real `api` functions.
import { randomBytes } from 'node:crypto';
import { request, rpc } from './http.mjs';
import { totp } from './totp.mjs';
import { registerSecret } from './redact.mjs';

export const fixtureEmail = (runId, name) => `staging-${runId}-${name}@example.test`;
export const newPassword = () => { const p = `Pw-${randomBytes(18).toString('base64url')}`; registerSecret(p); return p; };
export const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
export const header = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString());
const must = (r, what, ok = [200, 201]) => { if (!ok.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${r.body?.msg ?? r.body?.message ?? r.body?.error_description ?? ''}`.trim()); return r; };

const admin = (ctx) => ({ apikey: ctx.keys.secret });
export async function adminCreateUser(ctx, { email, password }) {
  const r = must(await request(ctx, { method: 'POST', path: '/auth/v1/admin/users', ...admin(ctx), body: { email, password, email_confirm: true } }), 'admin create user');
  return { id: r.body.id, email };
}
export async function adminDeleteUser(ctx, id) { return must(await request(ctx, { method: 'DELETE', path: `/auth/v1/admin/users/${id}`, ...admin(ctx) }), 'admin delete user', [200, 204]); }
/**
 * Find users by EXACT e-mail address among the recorded fixture identities, walking the admin user list page by page until it returns an empty page (the platform may cap the page
 * size, so a short page is not the end). Returns a Map(email -> user). Never matches by pattern and never returns a user whose e-mail was not asked for.
 */
export async function adminFindUsersByEmails(ctx, emails, { perPage = 100, maxPages = 500, req = request } = {}) {
  const want = new Set(emails.map((e) => String(e).toLowerCase()));
  const found = new Map();
  if (want.size === 0) return found;
  for (let page = 1; page <= maxPages; page++) {
    const r = must(await req(ctx, { path: `/auth/v1/admin/users?page=${page}&per_page=${perPage}`, ...admin(ctx) }), 'admin list users');
    const users = r.body?.users ?? [];
    if (users.length === 0) return found;
    for (const u of users) if (u?.email && want.has(String(u.email).toLowerCase())) found.set(String(u.email).toLowerCase(), u);
  }
  throw new Error(`the admin user list exceeded ${maxPages} pages: the absence of the fixture users cannot be proved`);
}
export async function signIn(ctx, email, password) {
  const r = must(await request(ctx, { method: 'POST', path: '/auth/v1/token?grant_type=password', body: { email, password } }), 'sign in');
  registerSecret(r.body.access_token); registerSecret(r.body.refresh_token);
  return { access_token: r.body.access_token, refresh_token: r.body.refresh_token, expires_in: r.body.expires_in };
}
export async function refreshSession(ctx, refreshToken) {
  const r = must(await request(ctx, { method: 'POST', path: '/auth/v1/token?grant_type=refresh_token', body: { refresh_token: refreshToken } }), 'refresh');
  registerSecret(r.body.access_token); registerSecret(r.body.refresh_token);
  return { access_token: r.body.access_token, refresh_token: r.body.refresh_token };
}
export const signOut = (ctx, token) => request(ctx, { method: 'POST', path: '/auth/v1/logout?scope=local', token });
export const getUser = (ctx, token) => request(ctx, { path: '/auth/v1/user', token });
export async function mfaEnroll(ctx, token, name = 'staging-check') {
  const r = must(await request(ctx, { method: 'POST', path: '/auth/v1/factors', token, body: { factor_type: 'totp', friendly_name: `${name}-${randomBytes(3).toString('hex')}` } }), 'mfa enroll');
  registerSecret(r.body.totp.secret);
  return { factorId: r.body.id, secret: r.body.totp.secret };
}
/** Challenge + verify with a computed code; returns the aal2 session. A code is valid for its 30 s window, so a second verify in the same window is spaced out by the caller. */
export async function mfaVerify(ctx, token, factorId, secret) {
  const ch = must(await request(ctx, { method: 'POST', path: `/auth/v1/factors/${factorId}/challenge`, token, body: {} }), 'mfa challenge');
  const v = must(await request(ctx, { method: 'POST', path: `/auth/v1/factors/${factorId}/verify`, token, body: { challenge_id: ch.body.id, code: totp(secret) } }), 'mfa verify');
  registerSecret(v.body.access_token); registerSecret(v.body.refresh_token);
  return { access_token: v.body.access_token, refresh_token: v.body.refresh_token };
}
/** A fresh aal2 token for a stored staff fixture (sign in, then step up). */
export async function staffToken(ctx, fx) {
  const s = await signIn(ctx, fx.email, fx.password);
  return mfaVerify(ctx, s.access_token, fx.factorId, fx.totpSecret);
}

export const api = (ctx, name, token, args) => rpc(ctx, name, token, args);
export const errMsg = (r) => r.body?.message ?? r.body?.msg ?? null;

export const doc = (category, title, extra = {}) => ({
  category_slug: category, title, summary: `Summary of ${title}.`, outcome: 'A synthetic outcome.', difficulty: 'easy', steps: [`Step for ${title}.`],
  attributions: [{ role: 'author', external_name: 'A. Cook' }], source_claims: [{ kind: 'original_work' }], ...extra,
});
/** member: create a draft (new hack, or a new version of hackId), save the content and submit it. */
export async function submit(ctx, memberToken, content, hackId = null) {
  const c = must(await api(ctx, 'create_draft', memberToken, hackId ? { p_hack_id: hackId } : {}), 'create_draft');
  const sv = must(await api(ctx, 'save_draft', memberToken, { p_version_id: c.body.version_id, p_content: content }), 'save_draft');
  const sub = must(await api(ctx, 'submit_version', memberToken, { p_version_id: c.body.version_id, p_expected_hash: sv.body.content_hash }), 'submit_version');
  return { hackId: c.body.hack_id, versionId: c.body.version_id, submissionId: sub.body.submission_id, hash: sv.body.content_hash };
}
const rev = (s, extra = {}) => ({ p_submission_id: s.submissionId, p_expected_hash: s.hash, ...extra });
/** staff: review all the way to an approving PUBLISH decision; `expiresOn` (YYYY-MM-DD) is recorded on the rights review when given. */
export async function approve(ctx, staffTokenValue, s, { expiresOn = null } = {}) {
  must(await api(ctx, 'start_review', staffTokenValue, rev(s)), 'start_review');
  must(await api(ctx, 'record_risk_assessment', staffTokenValue, rev(s, { p_risk_class: 'low', p_rationale: 'A synthetic, harmless household tip.' })), 'record_risk_assessment');
  must(await api(ctx, 'record_rights_review', staffTokenValue, rev(s, { p_claim_no: 1, p_status: 'clear', p_basis_code: 'staff_original_check', p_evidence_note: 'Synthetic fixture checked against itself.', p_expires_on: expiresOn })), 'record_rights_review');
  const d = must(await api(ctx, 'record_decision', staffTokenValue, rev(s, { p_decision: 'PUBLISH', p_reason_codes: null, p_note: null, p_expected_prior_decision_id: null })), 'record_decision');
  if (d.body.state !== 'approved') throw new Error('decision did not approve');
  return d.body.decision_id;
}
export async function publish(ctx, staffTokenValue, s, decisionId, slug = null) {
  const p = must(await api(ctx, 'publish_version', staffTokenValue, rev(s, { p_expected_decision_id: decisionId, p_slug: slug })), 'publish_version');
  return p.body;
}
export const withdraw = (ctx, staffTokenValue, publicationId) => api(ctx, 'withdraw_publication', staffTokenValue, { p_publication_id: publicationId, p_reason_code: 'quality', p_note: null });
export const revokeRights = (ctx, staffTokenValue, s) => api(ctx, 'record_rights_review', staffTokenValue, rev(s, { p_claim_no: 1, p_status: 'revoked', p_basis_code: null, p_evidence_note: null, p_expires_on: null }));

/** A fresh aal2 token for a stored fixture. TOTP codes are single-use per 30 s window, so a second step-up in the same window waits for the next one. */
export async function steppedUp(ctx, run, name) {
  const sec = run.secrets();
  const fx = sec.users?.[name];
  if (!fx?.factorId) throw new Error(`fixture ${name} has no TOTP factor`);
  const email = run.state().fixtures.users[name].email;
  const win = () => Math.floor(Date.now() / 30_000);
  while (fx.lastWindow !== undefined && fx.lastWindow >= win()) await new Promise((r) => setTimeout(r, 1000));
  const s = await signIn(ctx, email, fx.password);
  const out = await mfaVerify(ctx, s.access_token, fx.factorId, fx.totpSecret);
  fx.lastWindow = win(); run.saveSecrets(sec);
  return out;
}
