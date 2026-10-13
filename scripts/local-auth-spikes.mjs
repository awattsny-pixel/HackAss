#!/usr/bin/env node
// Auth / session / MFA checks that can run against the REAL local Supabase stack (GoTrue + PostgREST + Postgres).
// Local equivalents of hosted spikes S1-S4 (see docs/spikes/f1-hosted-spikes.md); the hosted-only parts stay BLOCKED.
//
// Run through `npm run db:test:auth`, which starts the disposable `hackass-local` stack, runs pgTAP, then runs this
// script, and always stops the stack. Run directly only with the stack already up:
//   node --conditions=react-server scripts/local-auth-spikes.mjs
// It creates throwaway users and a few `hackass_probe_*` functions in the disposable local database (destroyed by
// `supabase stop --no-backup`; dropped again at the end). It prints facts and PASS/FAIL, never keys, tokens or passwords.
// Exit 0 all checks passed, 1 a check failed, 2 the stack is not reachable.
import { createHmac, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { createUserDb } from '../src/platform/db/clients.ts';

const SUPABASE = process.env.SUPABASE_BIN || 'supabase';
const DOCKER = process.env.DOCKER_BIN || 'docker';
const PROJECT = 'hackass-local';

// ---- stack configuration (read from the running stack; never printed) ----------------------------------------------
const st = spawnSync(SUPABASE, ['status', '-o', 'json'], { encoding: 'utf8', timeout: 60_000 });
if (st.status !== 0) { console.error('BLOCKED  the local stack is not running (supabase status failed)'); process.exit(2); }
const cfg = JSON.parse(st.stdout);
const API = cfg.API_URL, PUB = cfg.PUBLISHABLE_KEY || cfg.ANON_KEY, SECRET = cfg.SECRET_KEY || cfg.SERVICE_ROLE_KEY, JWT_SECRET = cfg.JWT_SECRET;
const MAIL = cfg.MAILPIT_URL || cfg.INBUCKET_URL;
if (!API || !PUB || !SECRET) { console.error('BLOCKED  the stack did not report API_URL and keys'); process.exit(2); }
const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const anon = () => createClient(API, PUB, noPersist);
const admin = createClient(API, SECRET, noPersist);

// ---- helpers ---------------------------------------------------------------------------------------------------------
const b64u = (s) => Buffer.from(s, 'base64url');
const decode = (jwt) => { const [h, p] = jwt.split('.'); return { header: JSON.parse(b64u(h).toString()), claims: JSON.parse(b64u(p).toString()) }; };
async function signatureValid(jwt) {
  const [h, p, s] = jwt.split('.');
  const { header } = decode(jwt);
  if (header.alg === 'HS256') return createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url') === s;
  const jwks = await (await fetch(`${API}/auth/v1/.well-known/jwks.json`)).json();
  const jwk = jwks.keys.find((k) => k.kid === header.kid) ?? jwks.keys[0];
  const v = createVerify(header.alg === 'ES256' ? 'SHA256' : 'SHA256');
  v.update(`${h}.${p}`);
  return v.verify({ key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, b64u(s));
}
function psql(sql) {
  const r = spawnSync(DOCKER, ['exec', '-i', `supabase_db_${PROJECT}`, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || '').split('\n')[0]}`);
  return r.stdout.trim();
}
const rpc = async (name, token) => {
  const res = await fetch(`${API}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: PUB, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  return { status: res.status, body: await res.json().catch(() => null) };
};
function totp(secretBase32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = ''; for (const c of secretBase32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[19] & 15;
  return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000).padStart(6, '0');
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => randomBytes(6).toString('hex');
const newUser = () => ({ email: `spike-${rnd()}@example.test`, password: `Pw-${randomBytes(12).toString('base64url')}` });
async function confirmedSession() {
  const u = newUser();
  const { error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true });
  if (error) throw new Error(`admin.createUser: ${error.message}`);
  const c = anon();
  const { data, error: e2 } = await c.auth.signInWithPassword(u);
  if (e2) throw new Error(`signIn: ${e2.message}`);
  return { u, c, session: data.session };
}

// ---- runner ----------------------------------------------------------------------------------------------------------
const results = [];
async function check(id, title, fn) {
  try { const facts = await fn(); results.push({ id, ok: true }); console.log(`PASS  ${id}  ${title}${facts ? `  [${facts}]` : ''}`); }
  catch (e) { results.push({ id, ok: false }); console.log(`FAIL  ${id}  ${title}  -> ${e.message}`); }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

// probe objects in the disposable local database
psql(`
  create or replace function public.hackass_probe_claims() returns jsonb language sql stable security invoker as $$ select auth.jwt() $$;
  create or replace function public.hackass_probe_session_alive() returns boolean language sql stable security definer set search_path = '' as $$
    select exists (select 1 from auth.sessions s where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid and (s.not_after is null or s.not_after > now()))
  $$;
  revoke all on function public.hackass_probe_claims(), public.hackass_probe_session_alive() from public;
  grant execute on function public.hackass_probe_claims(), public.hackass_probe_session_alive() to anon, authenticated;
  notify pgrst, 'reload schema';
`);
await wait(2500);

try {
  await check('L0', 'stack facts: access-token lifetime follows config (jwt_expiry = 600) and the signing algorithm is known', async () => {
    const { session } = await confirmedSession();
    ok(session.expires_in === 600, `expires_in is ${session.expires_in}, expected 600`);
    const { header, claims } = decode(session.access_token);
    ok(claims.exp - claims.iat === 600, 'exp - iat is not 600');
    return `alg=${header.alg}, lifetime=${claims.exp - claims.iat}s, claims: ${Object.keys(claims).sort().join(',')}`;
  });

  await check('L1', 'email confirmation is enforced: sign-up gives no session, sign-in fails until the Mailpit link is followed, then succeeds', async () => {
    const u = newUser();
    const c = anon();
    const { data, error } = await c.auth.signUp({ email: u.email, password: u.password });
    ok(!error, `signUp: ${error?.message}`);
    ok(data.session === null && data.user && !data.user.email_confirmed_at, 'sign-up returned a session or a confirmed user');
    const before = await c.auth.signInWithPassword(u);
    ok(before.error?.code === 'email_not_confirmed', `expected email_not_confirmed, got ${before.error?.code}`);
    let link = null;
    for (let i = 0; i < 20 && !link; i++) {
      const list = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent('to:' + u.email)}`)).json();
      const id = list.messages?.[0]?.ID;
      if (id) { const msg = await (await fetch(`${MAIL}/api/v1/message/${id}`)).json(); link = (msg.Text + ' ' + msg.HTML).match(/https?:\/\/[^\s"<>)]+\/auth\/v1\/verify\?[^\s"<>)]+/)?.[0]?.replace(/&amp;/g, '&') ?? null; }
      if (!link) await wait(500);
    }
    ok(link, 'no confirmation email arrived in Mailpit');
    const v = await fetch(link, { redirect: 'manual' });
    ok(v.status >= 300 && v.status < 400, `verify link answered ${v.status}`);
    const after = await c.auth.signInWithPassword(u);
    ok(!after.error && after.data.session, `sign-in after confirmation failed: ${after.error?.message}`);
    return 'sign-up -> unconfirmed sign-in refused -> link -> sign-in ok';
  });

  await check('L2', 'server-centric cookie session via createUserDb: HttpOnly/SameSite cookies, persists across clients, refreshes, and sign-out clears it and revokes the refresh token', async () => {
    const u = newUser();
    await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true });
    const jar = new Map(); const seen = [];
    const adapter = { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (list) => { for (const { name, value, options } of list) { seen.push(options ?? {}); if (value === '' || options?.maxAge === 0) jar.delete(name); else jar.set(name, value); } } };
    const env = { appEnv: 'local', supabaseUrl: API, supabasePublishableKey: PUB, appOrigin: 'http://localhost:3000' };
    const first = createUserDb(env, adapter);
    const { error } = await first.client.auth.signInWithPassword(u);
    ok(!error, `signIn: ${error?.message}`);
    ok(jar.size > 0 && seen.length > 0, 'no session cookie was set');
    ok(seen.every((o) => o.httpOnly === true && o.sameSite === 'lax' && o.path === '/'), `cookie options were ${JSON.stringify([...new Set(seen.map((o) => JSON.stringify(o)))])}`);
    const second = createUserDb(env, adapter); // a "new request": fresh client, same cookies
    const got = await second.client.auth.getUser();
    ok(got.data.user?.email === u.email, 'a second client did not see the session');
    const oldRefresh = (await second.client.auth.getSession()).data.session.refresh_token;
    const refreshed = await second.client.auth.refreshSession();
    ok(refreshed.data.session && refreshed.data.session.refresh_token !== oldRefresh, 'refresh did not rotate the refresh token');
    await second.client.auth.signOut();
    ok(jar.size === 0, 'sign-out did not clear the cookies');
    const rt = refreshed.data.session.refresh_token;
    const reuse = await anon().auth.refreshSession({ refresh_token: rt });
    ok(reuse.error, 'a refresh token still worked after sign-out');
    return `cookie options httpOnly=true sameSite=lax path=/; refresh rotated; sign-out cleared the jar and revoked the refresh token. NOT shown here: a real browser honouring HttpOnly (hosted/browser spike S1)`;
  });

  await check('L3', 'revocation vs signature (S2): after sign-out the access token still verifies by signature and is still accepted by PostgREST, but the Auth server rejects it', async () => {
    const { c, session } = await confirmedSession();
    const token = session.access_token;
    ok(await signatureValid(token), 'signature should be valid before sign-out');
    const { error: so } = await c.auth.signOut();
    ok(!so, `signOut: ${so?.message}`);
    ok(await signatureValid(token), 'signature should STILL be valid after sign-out (that is the point of the test)');
    ok(decode(token).claims.exp * 1000 > Date.now(), 'token should not be expired yet');
    const viaServer = await anon().auth.getUser(token);
    ok(viaServer.error, 'getUser(token) should fail after sign-out');
    const viaRest = await rpc('hackass_probe_claims', token);
    ok(viaRest.status === 200 && viaRest.body?.sub, `PostgREST answered ${viaRest.status} for the revoked token`);
    return `signature valid=true, exp in future, PostgREST=${viaRest.status} (accepted), auth server getUser=rejected (${viaServer.error.code ?? viaServer.error.status})`;
  });

  await check('L4', 'in-database session check (S3/I-3): a SECURITY DEFINER function owned by a non-superuser reads auth.sessions and sees the session die at sign-out; the caller role cannot read auth.sessions itself', async () => {
    const who = psql(`select current_user || ' superuser=' || (select rolsuper from pg_roles where rolname = current_user);`);
    ok(/superuser=false/.test(who), `function owner would be a superuser (${who})`);
    const owner = psql(`select pg_get_userbyid(proowner) from pg_proc where proname = 'hackass_probe_session_alive';`);
    ok(owner === 'postgres', `probe function owner is ${owner}`);
    const { c, session } = await confirmedSession();
    const before = await rpc('hackass_probe_session_alive', session.access_token);
    ok(before.status === 200 && before.body === true, `before sign-out: ${before.status} ${JSON.stringify(before.body)}`);
    await c.auth.signOut();
    const after = await rpc('hackass_probe_session_alive', session.access_token);
    ok(after.status === 200 && after.body === false, `after sign-out: ${after.status} ${JSON.stringify(after.body)} (the revoked token is still accepted by PostgREST, but the in-database check sees the session gone)`);
    const direct = psql(`set role authenticated; select has_table_privilege('authenticated', 'auth.sessions', 'select');`).split('\n').pop();
    ok(direct === 'f', `authenticated can read auth.sessions directly (${direct})`);
    return `owner=${owner} (${who}); alive before=true, after sign-out=false; authenticated has no direct SELECT on auth.sessions`;
  });

  await check('L5', 'MFA claims (S4): TOTP enrol + verify moves aal1 -> aal2 and the token carries amr entries with a verification timestamp, visible inside the database', async () => {
    const { c, session } = await confirmedSession();
    const c1 = decode(session.access_token).claims;
    ok(c1.aal === 'aal1', `initial aal is ${c1.aal}`);
    const enroll = await c.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'spike' });
    ok(!enroll.error, `enroll: ${enroll.error?.message}`);
    const ch = await c.auth.mfa.challenge({ factorId: enroll.data.id });
    ok(!ch.error, `challenge: ${ch.error?.message}`);
    const ver = await c.auth.mfa.verify({ factorId: enroll.data.id, challengeId: ch.data.id, code: totp(enroll.data.totp.secret) });
    ok(!ver.error, `verify: ${ver.error?.message}`);
    const token = ver.data.access_token;
    const claims = decode(token).claims;
    ok(claims.aal === 'aal2', `aal after verify is ${claims.aal}`);
    ok(Array.isArray(claims.amr) && claims.amr.some((a) => a.method === 'totp' && Number.isFinite(a.timestamp)), `amr is ${JSON.stringify(claims.amr)}`);
    const ageS = Math.floor(Date.now() / 1000) - claims.amr.find((a) => a.method === 'totp').timestamp;
    ok(ageS >= -5 && ageS < 60, `totp timestamp age is ${ageS}s`);
    const inDb = await rpc('hackass_probe_claims', token);
    ok(inDb.status === 200 && inDb.body.aal === 'aal2' && inDb.body.amr?.some((a) => a.method === 'totp'), `auth.jwt() in the database showed ${JSON.stringify({ s: inDb.status, aal: inDb.body?.aal })}`);
    const lvl = await c.auth.mfa.getAuthenticatorAssuranceLevel();
    ok(lvl.data.currentLevel === 'aal2', `assurance level ${lvl.data.currentLevel}`);
    const wrong = await (async () => { const c2 = await c.auth.mfa.challenge({ factorId: enroll.data.id }); return c.auth.mfa.verify({ factorId: enroll.data.id, challengeId: c2.data.id, code: '000000' }); })();
    ok(wrong.error, 'a wrong TOTP code was accepted');
    return `aal ${c1.aal} -> ${claims.aal}; amr=[${claims.amr.map((a) => a.method).join(',')}] with timestamp age ${ageS}s; auth.jwt() shows aal2 + amr in the database; wrong code rejected`;
  });
} finally {
  try { psql(`drop function if exists public.hackass_probe_claims(), public.hackass_probe_session_alive();`); } catch (e) { console.log(`WARN  probe cleanup: ${e.message}`); }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\nlocal Auth/session/MFA checks: ${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
console.log('NOT run here (hosted/browser only): S1 real-browser HttpOnly cookie behaviour over HTTPS; S5 worker role through the hosted pooler; S6 hosted key model, SMTP and rate limits.');
process.exit(failed ? 1 : 0);
