// Secret redaction for everything the scripts print or write. Pattern-based (JWTs, Supabase keys, connection strings with a password, bearer tokens, passwords in
// key=value form, e-mail addresses other than the synthetic example.test ones), exact-value redaction of every secret registered in THIS process, and hash-based redaction of
// secrets registered by EARLIER processes of the same run: a run keeps only salted SHA-256 hashes of what it registered (never the secrets), so a later, separate process (the
// evidence stage) still removes them after the secrets file has been deleted.
import { createHash } from 'node:crypto';

const registered = new Set();
let sink = null; // set by the run: receives every registered value so it can persist its salted hash
let hashed = { salt: '', set: new Set() };

export const hashSecret = (salt, value) => createHash('sha256').update(`${salt}\0${value}`).digest('hex');
export function setRegisterSink(fn) { sink = fn; }
export function loadHashedSecrets({ salt, hashes }) { hashed = { salt, set: new Set(hashes) }; }
/** The values worth hashing for a secret: itself and, for a dotted token (a JWT), each long segment. */
export function hashableParts(v) { return [v, ...(v.includes('.') ? v.split('.').filter((x) => x.length >= 8) : [])]; }

/** Register a secret value (a key, a generated password, a TOTP secret) so any occurrence is replaced. Short values are refused (they would redact ordinary text). */
export function registerSecret(v) {
  if (typeof v !== 'string' || v.length < 8) return;
  registered.add(v);
  if (sink) sink(v);
}
export function clearRegisteredSecrets() { registered.clear(); hashed = { salt: '', set: new Set() }; }

const TOKEN = /[A-Za-z0-9_-]{8,}/g;
const PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[JWT]'],
  [/sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, '[API-KEY]'],
  [/(postgres(?:ql)?:\/\/[^\s:@/]+):[^\s@]+@/gi, '$1:[PASSWORD]@'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[TOKEN]'],
  [/((?:password|passwd|pwd|secret|token|apikey|api_key|access_token|refresh_token)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]{4,}/gi, '$1[REDACTED]'],
  [/\b[A-Za-z0-9._%+-]+@(?!example\.test\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
];
export function redact(text) {
  let s = typeof text === 'string' ? text : String(text);
  for (const v of registered) s = s.split(v).join('[REDACTED]');
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  if (hashed.set.size) s = s.replace(TOKEN, (t) => (hashed.set.has(hashSecret(hashed.salt, t)) ? '[REDACTED]' : t));
  return s;
}
/** True when text still contains something that looks like a secret AFTER redaction (used as a last gate before evidence is written). */
export function looksSecret(text) {
  if (/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(text) || /sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/.test(text) || /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@[]+@/i.test(text) || [...registered].some((v) => text.includes(v))) return true;
  if (hashed.set.size) for (const t of text.match(TOKEN) ?? []) if (hashed.set.has(hashSecret(hashed.salt, t))) return true;
  return false;
}
