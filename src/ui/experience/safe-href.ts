// Untrusted text from the catalog is rendered by React (escaped); the only attribute that could carry a URL is a source link, and it is checked here.
/** Returns the URL if (and only if) it is an absolute http(s) URL without credentials; otherwise null (the caller shows plain text, never a link). */
export function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}
