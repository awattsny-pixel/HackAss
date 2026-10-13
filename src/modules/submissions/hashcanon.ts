// HashCanon-1 (HACKASS-CANON-1): the canonical text of a hack's content and its SHA-256, in TypeScript.
// The database implementation is app_content.canonical_text_json (supabase/migrations/20261014090100_f2b_canonical_hash.sql);
// the specification is docs/db/hashcanon-1.md; both are checked against tests/fixtures/hashcanon-vectors.json.
// Pure and client-safe: no environment, no database, no Node-only API (hashing uses Web Crypto).

export const CANON_VERSION = 1;
export const CANON_HEADER = 'HACKASS-CANON-1\n';

export interface MaterialDoc { name?: string | null; detail?: string | null }
export interface RequirementDoc { kind?: string | null; name?: string | null; detail?: string | null }
export interface AttributionDoc { role?: string | null; profile_id?: string | null; external_name?: string | null; external_url?: string | null }
export interface SourceClaimDoc {
  kind?: string | null; canonical_url?: string | null; source_author?: string | null; license_spdx?: string | null;
  license_version?: string | null; permission_note?: string | null; asset_rights_note?: string | null;
}
export interface AssetDoc { asset_id?: string | null; sha256?: string | null }
export interface ContentDoc {
  category_slug?: string | null; title?: string | null; summary?: string | null; outcome?: string | null; difficulty?: string | null;
  time_min_minutes?: number | null; time_max_minutes?: number | null; cost_min_cents?: number | null; cost_max_cents?: number | null;
  currency?: string | null; estimate_basis?: string | null; ai_requirement?: string | null; limitations?: string | null;
  steps?: string[] | null; materials?: MaterialDoc[] | null; requirements?: RequirementDoc[] | null; tags?: string[] | null;
  attributions?: AttributionDoc[] | null; source_claims?: SourceClaimDoc[] | null; assets?: AssetDoc[] | null;
}

export class CanonError extends Error {
  readonly path: string;
  constructor(path: string) { super(`invalid_content: ${path}`); this.name = 'CanonError'; this.path = path; }
}

const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).length;

/** Unicode NFC, and CRLF / lone CR -> LF. Idempotent. */
export const canonStr = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').normalize('NFC');

/** "<utf8 byte length>:<value>", or "-:" for an absent value. */
const fv = (v: string | null): string => (v === null ? '-:' : `${byteLength(v)}:${v}`);

function text(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new CanonError(key);
  return canonStr(v);
}
function int(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || !/^(0|[1-9][0-9]{0,14})$/.test(String(v))) throw new CanonError(key);
  return String(v);
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
/** An identifier that must already be a lowercase hyphenated UUID (`uuid`) or 64 lowercase hex characters (`hex64`). Any other spelling is rejected, as in SQL. */
function ident(obj: Record<string, unknown>, key: string, kind: 'uuid' | 'hex64'): string | null {
  const v = text(obj, key);
  if (v !== null && !(kind === 'uuid' ? UUID_RE : HEX64_RE).test(v)) throw new CanonError(key);
  return v;
}
function arr(obj: Record<string, unknown>, key: string): unknown[] {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new CanonError(key);
  return v;
}
function item(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new CanonError(path);
  return v as Record<string, unknown>;
}
/** Byte-wise comparison of two strings' UTF-8 encodings (the same order as comparing bytea values in PostgreSQL). */
function compareBytes(a: string, b: string): number {
  const x = encoder.encode(a), y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

export function canonicalText(doc: ContentDoc): string {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new CanonError('(root)');
  const d = doc as Record<string, unknown>;
  let out = CANON_HEADER;
  for (const f of ['category_slug', 'title', 'summary', 'outcome', 'difficulty']) out += `${f}:${fv(text(d, f))}\n`;
  for (const f of ['time_min_minutes', 'time_max_minutes', 'cost_min_cents', 'cost_max_cents']) out += `${f}:${fv(int(d, f))}\n`;
  for (const f of ['currency', 'estimate_basis', 'ai_requirement', 'limitations']) out += `${f}:${fv(text(d, f))}\n`;

  const steps = arr(d, 'steps');
  out += `steps:${steps.length}\n`;
  steps.forEach((s, i) => { if (typeof s !== 'string') throw new CanonError('steps'); out += `step;${i + 1};${fv(canonStr(s))}\n`; });

  const materials = arr(d, 'materials');
  out += `materials:${materials.length}\n`;
  materials.forEach((m, i) => { const o = item(m, 'materials'); out += `material;${i + 1};${fv(text(o, 'name'))};${fv(text(o, 'detail'))}\n`; });

  const requirements = arr(d, 'requirements').map((r) => { const o = item(r, 'requirements'); return { kind: text(o, 'kind'), name: text(o, 'name'), detail: text(o, 'detail') }; });
  requirements.sort((a, b) => compareBytes(a.kind ?? '', b.kind ?? '') || compareBytes(a.name ?? '', b.name ?? ''));
  out += `requirements:${requirements.length}\n`;
  for (const r of requirements) out += `requirement;${fv(r.kind)};${fv(r.name)};${fv(r.detail)}\n`;

  const tags = arr(d, 'tags').map((t) => { if (typeof t !== 'string') throw new CanonError('tags'); return canonStr(t); });
  tags.sort(compareBytes);
  out += `tags:${tags.length}\n`;
  for (const t of tags) out += `tag;${fv(t)}\n`;

  const attributions = arr(d, 'attributions');
  out += `attributions:${attributions.length}\n`;
  attributions.forEach((a, i) => {
    const o = item(a, 'attributions');
    out += `attribution;${i + 1};${fv(text(o, 'role'))};${fv(ident(o, 'profile_id', 'uuid'))};${fv(text(o, 'external_name'))};${fv(text(o, 'external_url'))}\n`;
  });

  const claims = arr(d, 'source_claims');
  out += `source_claims:${claims.length}\n`;
  claims.forEach((c, i) => {
    const o = item(c, 'source_claims');
    out += `claim;${i + 1};${['kind', 'canonical_url', 'source_author', 'license_spdx', 'license_version', 'permission_note', 'asset_rights_note'].map((k) => fv(text(o, k))).join(';')}\n`;
  });

  const assets = arr(d, 'assets').map((a) => { const o = item(a, 'assets'); return { sha: ident(o, 'sha256', 'hex64'), id: ident(o, 'asset_id', 'uuid') }; });
  assets.sort((a, b) => compareBytes(a.sha ?? '', b.sha ?? ''));
  out += `assets:${assets.length}\n`;
  for (const a of assets) out += `asset;${fv(a.sha)};${fv(a.id)}\n`;
  return out;
}

export function canonicalBytes(doc: ContentDoc): Uint8Array { return encoder.encode(canonicalText(doc)); }

/** SHA-256 of the canonical text's UTF-8 bytes, lowercase hex (the same value the database stores in content_hash). */
export async function hashHex(doc: ContentDoc): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', canonicalBytes(doc) as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
