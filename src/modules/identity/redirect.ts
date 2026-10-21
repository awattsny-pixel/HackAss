// Safe return paths. A `next` value arrives from a query string and is attacker-controlled; the only thing it may ever name is a relative path
// inside this application. Anything else (other host, scheme, protocol-relative, backslash, encoded tricks, traversal, unknown area) becomes the fallback.
export const DEFAULT_RETURN_PREFIXES: readonly string[] = ['/spark', '/lab', '/reveal', '/states', '/account'];
export interface ReturnPathOptions { readonly allowedPrefixes?: readonly string[]; readonly fallback?: string }

const MAX_LENGTH = 512;
const MAX_QUERY = 200;
const PATH_OK = /^\/[A-Za-z0-9\-._~/]*$/;       // no '%', no ':', no '@', no '\\', no spaces: a path in this app never needs them
const QUERY_OK = /^[A-Za-z0-9\-._~%=&,+]*$/;
const BAD_CHARS = /[\u0000-\u001f\u007f\\\s]/;

function decodesSafely(s: string): string[] | null {
  const forms = [s];
  let cur = s;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try { next = decodeURIComponent(cur); } catch { return null; } // malformed escape
    if (next === cur) break;
    forms.push(next); cur = next;
  }
  return forms;
}

export function safeReturnPath(raw: unknown, opts: ReturnPathOptions = {}): string {
  const fallback = opts.fallback ?? '/spark';
  const prefixes = opts.allowedPrefixes ?? DEFAULT_RETURN_PREFIXES;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return fallback;
  const forms = decodesSafely(raw);
  if (!forms) return fallback;
  for (const f of forms) {
    if (BAD_CHARS.test(f)) return fallback;
    if (f.startsWith('//') || f.startsWith('/\\') || !f.startsWith('/')) return fallback;
  }
  const hash = raw.indexOf('#'); const noHash = hash === -1 ? raw : raw.slice(0, hash);
  const q = noHash.indexOf('?'); const path = q === -1 ? noHash : noHash.slice(0, q); const query = q === -1 ? '' : noHash.slice(q + 1);
  if (!PATH_OK.test(path) || path.includes('//')) return fallback;
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return fallback;
  if (!prefixes.some((p) => path === p || path.startsWith(p + '/'))) return fallback;
  const keepQuery = query.length > 0 && query.length <= MAX_QUERY && QUERY_OK.test(query) && (decodesSafely(query) ?? ['\\']).every((f) => !BAD_CHARS.test(f));
  return keepQuery ? `${path}?${query}` : path;
}
