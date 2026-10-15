// One check for every file that carries a credential (the libpq password file, an API-key file, a probe password file) before it is read or mounted: an absolute path, a regular
// file that is not a symbolic link, mode 0600, owned by the caller, and outside the repository checkout (lexically and after resolving the real path).
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Returns a list of problems (empty = acceptable). `label` names the file in the messages (an environment variable name, for example). */
export function privateFileProblems(file, { repoRoot = REPO_ROOT, uid = process.getuid?.(), label = 'file' } = {}) {
  const problems = [];
  if (!file) return [`${label} is not set`];
  if (!path.isAbsolute(file)) return [`${label} must be an absolute path`];
  const inside = (p) => { const rel = path.relative(repoRoot, p); return !rel.startsWith('..') && !path.isAbsolute(rel); };
  if (inside(file)) problems.push(`${label} is inside the repository working tree`);
  let st;
  try { st = lstatSync(file); } catch (e) { return [...problems, e?.code === 'ENOENT' ? `${label} does not exist` : `${label} cannot be inspected (${e?.code ?? 'error'})`]; }
  if (st.isSymbolicLink()) { problems.push(`${label} is a symbolic link`); return problems; }
  if (!st.isFile()) problems.push(`${label} is not a regular file`);
  if ((st.mode & 0o777) !== 0o600) problems.push(`${label} mode must be 0600 (is ${(st.mode & 0o777).toString(8)})`);
  if (uid !== undefined && st.uid !== uid) problems.push(`${label} is not owned by the current user`);
  try { if (inside(realpathSync(file))) problems.push(`${label} resolves to a path inside the repository working tree`); } catch { /* reported above */ }
  return problems;
}
export class SecretFileRefused extends Error {}
export function assertPrivateFile(file, opts = {}) {
  const p = privateFileProblems(file, opts);
  if (p.length) throw new SecretFileRefused(p.join('; '));
}
/** Validate, then read (API-key files). */
export function readPrivateFile(file, opts = {}) {
  assertPrivateFile(file, opts);
  return readFileSync(file, 'utf8');
}
