// Classifies a PostgREST/Auth answer so that "refused" is only accepted as isolation evidence when the REASON is the expected one. A generic 4xx proves nothing: a rate limit,
// a malformed request or a missing function all answer 4xx without saying anything about authorization.
export function classifyRefusal(r) {
  const status = r?.status; const code = r?.body?.code ?? null;
  if (status >= 200 && status < 300) return { kind: 'success', status, code };
  if (status === 429) return { kind: 'rate-limited', status, code };
  if (status === 406 && code === 'PGRST106') return { kind: 'schema-excluded', status, code, schemas: exposedSchemas(r) };
  if ((status === 401 || status === 403) && code === '42501') return { kind: 'authorization-denied', status, code };
  if (code === 'PGRST202' || code === 'PGRST205' || code === 'PGRST200' || status === 404) return { kind: 'not-found', status, code };
  if (status === 400 || status === 422 || code === 'PGRST102' || code === 'PGRST100') return { kind: 'malformed', status, code };
  if (status >= 500) return { kind: 'server-error', status, code };
  return { kind: 'other', status, code };
}
/** The exposed-schema list a PGRST106 answer names (in its hint, or in older versions its message). */
export function exposedSchemas(r) {
  for (const text of [r?.body?.hint, r?.body?.message]) { // each field on its own: the list must not run into the next sentence
    const m = /(?:exposed|one of the following):\s*([A-Za-z0-9_, ]+)$/.exec(String(text ?? '').trim());
    if (m) return m[1].split(',').map((x) => x.trim()).filter(Boolean);
  }
  return null;
}
export const PRIVATE_SCHEMAS = Object.freeze(['app', 'app_guard', 'app_content', 'app_review', 'app_budget', 'app_bridge', 'worker']);
/** Throws unless `r` is a schema-exclusion refusal; `expectExact` (hosted) demands the exposed list to be exactly ['api']. */
export function requireSchemaExcluded(r, what, { expectExact = null } = {}) {
  const c = classifyRefusal(r);
  if (c.kind === 'rate-limited') throw new Error(`${what}: rate limited (HTTP 429): inconclusive, not evidence of isolation`);
  if (c.kind !== 'schema-excluded') throw new Error(`${what}: expected a schema-exclusion refusal (HTTP 406 PGRST106), got ${c.kind} (HTTP ${c.status}${c.code ? ` ${c.code}` : ''})`);
  if (!c.schemas) throw new Error(`${what}: the refusal does not name the exposed schemas`);
  const leaked = c.schemas.filter((s) => PRIVATE_SCHEMAS.includes(s));
  if (leaked.length) throw new Error(`${what}: a private schema is exposed (${leaked.join(',')})`);
  if (expectExact && JSON.stringify([...c.schemas].sort()) !== JSON.stringify([...expectExact].sort())) throw new Error(`${what}: exposed schemas are ${c.schemas.join(',')}, expected exactly ${expectExact.join(',')}`);
  return c;
}
