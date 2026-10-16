// The server's root certificate for verified TLS on the migration route (sslmode=verify-full). It is PUBLIC, so unlike the credential files it need not be 0600, but it is a trust anchor:
// whoever can change it decides whom the migration connection trusts. So before it is mounted or named in a URL it must be an absolute path, a regular file that is not a symbolic link,
// owned by the caller, writable by nobody else, outside the repository checkout, small, and made of PEM CERTIFICATE blocks only (no private key, no stray text), every one a parseable,
// currently valid X.509 certificate. NOTE: whether a certificate is a CA (basicConstraints) is RECORDED (`ca` in the result) but NOT required: a non-CA (leaf) certificate is accepted, so this check
// does not enforce CA status; trust is decided by the owner's choice of file and by the TLS verification (verify-full), not by this check.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MAX_BYTES = 64 * 1024;
const BLOCK = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/g;

/** Returns { problems, certs } (problems empty = acceptable). `now` is injectable for tests. */
export function rootCertProblems(file, { repoRoot = REPO_ROOT, uid = process.getuid?.(), label = 'root certificate', now = new Date() } = {}) {
  const problems = []; const certs = [];
  if (!file) return { problems: [`${label} is not set`], certs };
  if (!path.isAbsolute(file)) return { problems: [`${label} must be an absolute path`], certs };
  const inside = (p) => { const rel = path.relative(repoRoot, p); return !rel.startsWith('..') && !path.isAbsolute(rel); };
  if (inside(file)) problems.push(`${label} is inside the repository working tree`);
  let st;
  try { st = lstatSync(file); } catch (e) { return { problems: [...problems, e?.code === 'ENOENT' ? `${label} does not exist` : `${label} cannot be inspected (${e?.code ?? 'error'})`], certs }; }
  if (st.isSymbolicLink()) return { problems: [...problems, `${label} is a symbolic link`], certs };
  if (!st.isFile()) return { problems: [...problems, `${label} is not a regular file`], certs };
  if ((st.mode & 0o022) !== 0) problems.push(`${label} is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
  if (uid !== undefined && st.uid !== uid) problems.push(`${label} is not owned by the current user`);
  if (st.size === 0) return { problems: [...problems, `${label} is empty`], certs };
  if (st.size > MAX_BYTES) return { problems: [...problems, `${label} is larger than ${MAX_BYTES} bytes`], certs };
  try { if (inside(realpathSync(file))) problems.push(`${label} resolves to a path inside the repository working tree`); } catch { /* reported above */ }
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { problems: [...problems, `${label} cannot be read`], certs }; }
  if (/PRIVATE KEY/.test(text)) { problems.push(`${label} contains a private key: it must hold the CA certificate only`); return { problems, certs }; }
  const blocks = text.match(BLOCK) ?? [];
  if (blocks.length === 0) return { problems: [...problems, `${label} holds no PEM certificate`], certs };
  if (text.replace(BLOCK, '').replace(/\s+/g, '') !== '') problems.push(`${label} holds text other than PEM certificates`);
  for (const [i, b] of blocks.entries()) {
    let c; try { c = new X509Certificate(b); } catch { problems.push(`${label}: certificate ${i + 1} cannot be parsed`); continue; }
    if (now < new Date(c.validFrom)) problems.push(`${label}: certificate ${i + 1} is not valid yet`);
    if (now > new Date(c.validTo)) problems.push(`${label}: certificate ${i + 1} has expired`);
    certs.push({ subject: c.subject.replace(/\n/g, ', '), validTo: c.validTo, ca: c.ca });
  }
  return { problems, certs };
}
