// Secret redaction for everything the scripts print or write. Pattern-based (JWTs, Supabase keys, connection strings with a password, bearer tokens, passwords in
// key=value form, e-mail addresses other than the synthetic example.test ones) plus exact-value redaction of every secret registered at run time.
const registered = new Set();
/** Register a secret value (a key, a generated password, a TOTP secret) so any occurrence is replaced. Short values are refused (they would redact ordinary text). */
export function registerSecret(v) {
  if (typeof v === 'string' && v.length >= 8) registered.add(v);
}
export function clearRegisteredSecrets() { registered.clear(); }

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
  return s;
}
/** True when text still contains something that looks like a secret AFTER redaction (used as a last gate before evidence is written). */
export function looksSecret(text) {
  return /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(text) || /sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/.test(text) || /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@\[]+@/i.test(text) || [...registered].some((v) => text.includes(v));
}
