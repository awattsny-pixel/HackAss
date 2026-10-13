// Shared helpers for the scripts that run against the REAL local Supabase stack (disposable `hackass-local` project).
// Nothing here prints keys, tokens or passwords. Exit code 2 (BLOCKED) when the stack is not reachable.
import { createHmac, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

export const SUPABASE = process.env.SUPABASE_BIN || 'supabase';
export const DOCKER = process.env.DOCKER_BIN || 'docker';
export const PROJECT = 'hackass-local';
export const DB_CONTAINER = `supabase_db_${PROJECT}`;
export const NETWORK = `supabase_network_${PROJECT}`;

const st = spawnSync(SUPABASE, ['status', '-o', 'json'], { encoding: 'utf8', timeout: 60_000 });
if (st.status !== 0) { console.error('BLOCKED  the local stack is not running (supabase status failed)'); process.exit(2); }
const cfg = JSON.parse(st.stdout);
export const API = cfg.API_URL;
export const PUB = cfg.PUBLISHABLE_KEY || cfg.ANON_KEY;
export const SECRET = cfg.SECRET_KEY || cfg.SERVICE_ROLE_KEY;
const JWT_SECRET = cfg.JWT_SECRET;
export const MAIL = cfg.MAILPIT_URL || cfg.INBUCKET_URL;
if (!API || !PUB || !SECRET) { console.error('BLOCKED  the stack did not report API_URL and keys'); process.exit(2); }

const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
export const anon = () => createClient(API, PUB, noPersist);
export const admin = createClient(API, SECRET, noPersist);

const b64u = (s) => Buffer.from(s, 'base64url');
export const decode = (jwt) => { const [h, p] = jwt.split('.'); return { header: JSON.parse(b64u(h).toString()), claims: JSON.parse(b64u(p).toString()) }; };
export async function signatureValid(jwt) {
  const [h, p, s] = jwt.split('.');
  const { header } = decode(jwt);
  if (header.alg === 'HS256') return createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url') === s;
  const jwks = await (await fetch(`${API}/auth/v1/.well-known/jwks.json`)).json();
  const jwk = jwks.keys.find((k) => k.kid === header.kid) ?? jwks.keys[0];
  const v = createVerify('SHA256');
  v.update(`${h}.${p}`);
  return v.verify({ key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, b64u(s));
}

/** Run SQL as `postgres` inside the database container. Throws on error (message = first stderr line only). */
export function psql(sql, { user = 'postgres', tolerate = false } = {}) {
  const r = spawnSync(DOCKER, ['exec', '-i', DB_CONTAINER, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0 && !tolerate) throw new Error(`psql failed: ${(r.stderr || '').split('\n')[0]}`);
  return { out: r.stdout.trim(), err: (r.stderr || '').trim(), status: r.status };
}
export const sql = (text) => psql(text).out;

/** Call an exposed function through PostgREST (schema `api`) with a user's access token. */
export async function rpc(schema, name, token, args = {}) {
  const res = await fetch(`${API}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: PUB, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-profile': schema, 'accept-profile': schema },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export function totp(secretBase32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = ''; for (const c of secretBase32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[19] & 15;
  return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000).padStart(6, '0');
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const rnd = () => randomBytes(6).toString('hex');
export const newUser = () => ({ email: `spike-${rnd()}@example.test`, password: `Pw-${randomBytes(12).toString('base64url')}` });

/** A confirmed user with a live password session (created through the admin API; the account row appears via the trigger). */
export async function confirmedSession() {
  const u = newUser();
  const { data: created, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true });
  if (error) throw new Error(`admin.createUser: ${error.message}`);
  const c = anon();
  const { data, error: e2 } = await c.auth.signInWithPassword(u);
  if (e2) throw new Error(`signIn: ${e2.message}`);
  return { u, c, session: data.session, userId: created.user.id };
}

/** TOTP-enrol and verify so the user's session reaches aal2. Returns the aal2 access token. */
export async function elevateToAal2(c) {
  const enroll = await c.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'check' });
  if (enroll.error) throw new Error(`enroll: ${enroll.error.message}`);
  const ch = await c.auth.mfa.challenge({ factorId: enroll.data.id });
  if (ch.error) throw new Error(`challenge: ${ch.error.message}`);
  const ver = await c.auth.mfa.verify({ factorId: enroll.data.id, challengeId: ch.data.id, code: totp(enroll.data.totp.secret) });
  if (ver.error) throw new Error(`verify: ${ver.error.message}`);
  return ver.data.access_token;
}

export function createRunner() {
  const results = [];
  return {
    results,
    async check(id, title, fn) {
      try { const facts = await fn(); results.push({ id, ok: true }); console.log(`PASS  ${id}  ${title}${facts ? `  [${facts}]` : ''}`); }
      catch (e) { results.push({ id, ok: false }); console.log(`FAIL  ${id}  ${title}  -> ${e.message}`); }
    },
    failed: () => results.filter((r) => !r.ok).length,
  };
}
export const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
