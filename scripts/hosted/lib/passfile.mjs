// Reads ONLY the host, port, database and login fields of a libpq password file. The password field (and anything after it) is dropped while parsing and is
// never stored, returned or logged; the file's bytes are never passed to another process (it is mounted or named by PGPASSFILE instead).
import { readFileSync } from 'node:fs';

/** Split the first four colon-separated fields (honouring libpq's backslash escapes) and discard the rest of the line. */
export function parsePassfileLine(line) {
  const fields = [];
  let cur = '';
  for (let i = 0; i < line.length && fields.length < 4; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
    if (c === ':') { fields.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (fields.length < 4) return null; // fewer than four fields: not an entry (and no password field exists to leak)
  const [host, port, database, login] = fields;
  return { host, port, database, login };
}
export function parsePassfileEntries(file) {
  const out = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const e = parsePassfileLine(line);
    if (!e) throw new Error('a line in the password file does not have the host:port:database:login:password shape');
    out.push(e);
  }
  if (out.length === 0) throw new Error('the password file has no entries');
  return out;
}
