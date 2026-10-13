#!/usr/bin/env node
// Generates the shared HashCanon-1 golden vectors and the pgTAP file that checks the SQL implementation against them.
//   node --conditions=react-server scripts/gen-hashcanon.mjs          (writes both files)
//   node --conditions=react-server scripts/gen-hashcanon.mjs --check  (exit 1 if either file is out of date)
// The expected values come from the TypeScript implementation; SQL is then checked independently against them. A few
// canonical texts are also written out BY HAND in tests/hashcanon.test.ts so a shared misunderstanding cannot hide.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalText } from '../src/modules/submissions/hashcanon.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = (n) => n.toString(16).padStart(2, '0').repeat(32);
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const full = {
  category_slug: 'kitchen', title: 'Keep herbs fresh for two weeks', summary: 'Store cut herbs upright in a jar of water in the fridge.',
  outcome: 'Herbs stay crisp for about two weeks.', difficulty: 'easy', time_min_minutes: 5, time_max_minutes: 10, cost_min_cents: 0, cost_max_cents: 250,
  currency: 'USD', estimate_basis: 'Own kitchen, three trials', ai_requirement: 'none', limitations: 'Basil prefers room temperature.',
  steps: ['Trim the stems.', 'Stand the herbs in a jar with 3 cm of water.', 'Cover loosely with a bag and refrigerate.'],
  materials: [{ name: 'Glass jar', detail: 'any size' }, { name: 'Plastic bag' }],
  requirements: [{ kind: 'tool', name: 'Scissors' }, { kind: 'skill', name: 'None', detail: 'beginner friendly' }],
  tags: ['kitchen', 'food-saving', 'herbs'],
  attributions: [{ role: 'author', profile_id: U(1) }, { role: 'source_author', external_name: 'A. Cook', external_url: 'https://example.test/cook' }],
  source_claims: [{ kind: 'original_work' }, { kind: 'third_party_reuse', canonical_url: 'https://example.test/herbs', source_author: 'A. Cook', license_spdx: 'CC-BY-4.0', license_version: '4.0', permission_note: 'Used with credit', asset_rights_note: 'No images' }],
  assets: [{ asset_id: U(7), sha256: SHA(0xaa) }, { asset_id: U(8), sha256: SHA(0x0b) }],
};
const long = (unit, n) => unit.repeat(n);

// [name, doc, storable] — storable: the document satisfies every table constraint, so it is also round-tripped through the tables.
export const VECTORS = [
  ['empty document', {}, true],
  ['title only', { title: 'Hello' }, true],
  ['empty string is not null', { title: '', summary: 'x' }, false],
  ['explicit nulls equal absent fields', { title: null, summary: null, steps: null, tags: null }, true],
  ['all scalars', { category_slug: 'home', title: 'T', summary: 'S', outcome: 'O', difficulty: 'hard', time_min_minutes: 1, time_max_minutes: 2, cost_min_cents: 3, cost_max_cents: 4, currency: 'EUR', estimate_basis: 'B', ai_requirement: 'required', limitations: 'L' }, true],
  ['zero integers are present, not null', { time_min_minutes: 0, time_max_minutes: 0, cost_min_cents: 0, cost_max_cents: 0 }, true],
  ['largest accepted integer (15 digits)', { cost_max_cents: 999999999999999 }, false],
  ['combining acute (e + U+0301) normalizes to NFC', { title: 'Café' }, true],
  ['precomposed acute (same canonical text as the previous vector)', { title: 'Café' }, true],
  ['CJK and Hangul', { title: '漢字かな한글', summary: '今日' }, true],
  ['emoji outside the BMP (4-byte UTF-8)', { title: 'Fix 😀 quickly' }, true],
  ['ZWJ emoji sequence', { summary: '👨‍👩‍👧' }, true],
  ['CRLF in text becomes LF', { summary: 'line one\r\nline two' }, true],
  ['lone CR becomes LF', { summary: 'a\rb' }, true],
  ['newline inside a title is length-prefixed', { title: 'two\nlines' }, true],
  ['long ASCII text (2000 chars)', { limitations: long('abcdefghij', 200) }, true],
  ['long multi-byte text (e-acute x 600)', { outcome: long('é', 600) }, true],
  ['steps keep author order', { steps: ['b', 'a', 'c'] }, true],
  ['step containing the list syntax', { steps: ['x;2;1:y\nstep;9;1:z'] }, true],
  ['materials with and without detail', { materials: [{ name: 'Jar', detail: '1 L' }, { name: 'Lid' }] }, true],
  ['material name that looks like encoding', { materials: [{ name: 'a;1:b', detail: '-:' }] }, true],
  ['requirements sorted by kind then name', { requirements: [{ kind: 'tool', name: 'b' }, { kind: 'account', name: 'z' }, { kind: 'tool', name: 'a' }, { kind: 'skill', name: 'm' }] }, true],
  ['requirements: same set, other input order (same canonical text)', { requirements: [{ kind: 'skill', name: 'm' }, { kind: 'tool', name: 'a' }, { kind: 'account', name: 'z' }, { kind: 'tool', name: 'b' }] }, true],
  ['requirement names sort by UTF-8 bytes', { requirements: [{ kind: 'tool', name: 'éclair' }, { kind: 'tool', name: 'zebra' }, { kind: 'tool', name: 'Zebra' }] }, true],
  ['requirement sort keys are NFC-normalized first', { requirements: [{ kind: 'tool', name: 'éb' }, { kind: 'tool', name: 'éa' }] }, true],
  ['tags sorted bytewise', { tags: ['b', 'a1', 'a-b', 'a'] }, true],
  ['attributions: member and external author', { attributions: [{ role: 'author', profile_id: U(2) }, { role: 'contributor', external_name: 'Pat', external_url: 'https://example.test/pat' }] }, true],
  ['source claims keep claim order', { source_claims: [{ kind: 'licensed', canonical_url: 'https://example.test/a', license_spdx: 'MIT' }, { kind: 'original_work' }] }, true],
  ['source claim with every field', { source_claims: [{ kind: 'permission_granted', canonical_url: 'https://example.test/p', source_author: 'Q', license_spdx: 'CC0-1.0', license_version: '1', permission_note: 'n', asset_rights_note: 'r' }] }, true],
  ['assets sorted by sha-256 hex', { assets: [{ asset_id: U(3), sha256: SHA(0xff) }, { asset_id: U(4), sha256: SHA(0x01) }, { asset_id: U(5), sha256: SHA(0x7a) }] }, true],
  ['text is case sensitive', { title: 'Hello', summary: 'hello', outcome: 'HELLO' }, true],
  ['whitespace is significant', { title: ' a ', summary: 'a  b' }, true],
  ['injection attempt inside a field cannot forge another field', { title: 'x\nsummary:1:y' }, true],
  ['the forged-field twin is different', { title: 'x', summary: 'y' }, true],
  ['empty lists present explicitly equal absent', { steps: [], materials: [], requirements: [], tags: [], attributions: [], source_claims: [], assets: [] }, true],
  ['a realistic complete document', full, true],
];

export function build() {
  const vectors = VECTORS.map(([name, doc, storable]) => {
    const canonical = canonicalText(doc);
    return { name, storable, doc, canonical, sha256: createHash('sha256').update(canonical, 'utf8').digest('hex') };
  });
  const json = JSON.stringify({ format: 'HACKASS-CANON-1', note: 'Generated by scripts/gen-hashcanon.mjs from the TypeScript implementation; the SQL implementation is checked against it by supabase/tests/database/030_hashcanon_vectors.test.sql.', vectors }, null, 2) + '\n';
  const q = (i, k, s) => { const tag = `v${i}${k}`; if (s.includes(`$${tag}$`)) throw new Error('dollar-quote tag collision'); return `$${tag}$${s}$${tag}$`; };
  let sql = `-- GENERATED by scripts/gen-hashcanon.mjs from tests/fixtures/hashcanon-vectors.json. Do not edit by hand.
-- Checks the SQL implementation of HashCanon-1 against the shared golden vectors: the canonical text and the SHA-256 for every
-- vector, and (for vectors that satisfy the table constraints) the same text after the document is stored in the real tables.
begin;
select no_plan();

create function pg_temp.owner_val(p_sql text) returns text language plpgsql as $f$
declare v text;
begin
  perform set_config('role', 'hackass_owner', true);
  begin execute p_sql into v;
  exception when others then perform set_config('role', 'none', true); return 'ERR:' || sqlstate; end;
  perform set_config('role', 'none', true);
  return coalesce(v, 'NULL');
end $f$;
-- statements that return no rows (EXECUTE ... INTO would roll a successful INSERT back): report 'ok' or the SQLSTATE
create function pg_temp.owner_do(p_sql text) returns text language plpgsql as $f$
begin
  perform set_config('role', 'hackass_owner', true);
  begin execute p_sql;
  exception when others then perform set_config('role', 'none', true); return 'ERR:' || sqlstate; end;
  perform set_config('role', 'none', true);
  return 'ok';
end $f$;

insert into auth.users (id, aud, role, email) values ('00000000-0000-4000-8000-0000000000c1', 'authenticated', 'authenticated', 'vectors@example.test');
select is(pg_temp.owner_val($v$select count(*)::text from app.accounts where user_id = '00000000-0000-4000-8000-0000000000c1'$v$), '1', 'fixture account exists');
select is(pg_temp.owner_do($v$insert into app.categories (slug, name) values ('home', 'Home'), ('kitchen', 'Kitchen')$v$), 'ok', 'fixture categories');
select is(pg_temp.owner_val($v$select count(*)::text from (select 1 from app_content.canonical_text_json('{}'::jsonb)) x$v$), '1', 'the canonical function is callable by the owner role');
`;
  vectors.forEach((v, i) => {
    const n = i + 1, label = `vector ${n} (${v.name})`.replace(/'/g, "''");
    sql += `select is(pg_temp.owner_val(${q(n, 'a', `select app_content.canonical_text_json(${q(n, 'j', JSON.stringify(v.doc))}::jsonb)`)}), ${q(n, 'e', v.canonical)}, '${label}: canonical text');\n`;
    sql += `select is(pg_temp.owner_val(${q(n, 'b', `select pg_catalog.encode(app_content.hash_text(app_content.canonical_text_json(${q(n, 'k', JSON.stringify(v.doc))}::jsonb)), 'hex')`)}), '${v.sha256}', '${label}: sha-256');\n`;
    if (v.storable) {
      sql += `select is(pg_temp.owner_do($v${n}s$insert into app.hacks (id, created_by) values ('10000000-0000-4000-8000-${String(n).padStart(12, '0')}', '00000000-0000-4000-8000-0000000000c1')$v${n}s$), 'ok', '${label}: fixture hack');\n`;
      sql += `select is(pg_temp.owner_do($v${n}t$insert into app.hack_versions (id, hack_id, version_no, created_by) values ('20000000-0000-4000-8000-${String(n).padStart(12, '0')}', '10000000-0000-4000-8000-${String(n).padStart(12, '0')}', 1, '00000000-0000-4000-8000-0000000000c1')$v${n}t$), 'ok', '${label}: fixture version');\n`;
      sql += `select is(pg_temp.owner_do(${q(n, 'c', `select app_content.write_doc('20000000-0000-4000-8000-${String(n).padStart(12, '0')}'::uuid, ${q(n, 'm', JSON.stringify(v.doc))}::jsonb)`)}), 'ok', '${label}: stored in the tables without error');\n`;
      sql += `select is(pg_temp.owner_val($v${n}d$select app_content.canonical_text('20000000-0000-4000-8000-${String(n).padStart(12, '0')}'::uuid)$v${n}d$), ${q(n, 'f', v.canonical)}, '${label}: canonical text rebuilt from the stored rows is identical');\n`;
    }
  });
  sql += `\nselect is((select count(*)::int from (values ${vectors.map((_, i) => `(${i})`).join(',')}) t), ${vectors.length}, '${vectors.length} golden vectors');\nselect * from finish();\nrollback;\n`;
  return { json, sql };
}

const jsonPath = path.join(root, 'tests/fixtures/hashcanon-vectors.json');
const sqlPath = path.join(root, 'supabase/tests/database/030_hashcanon_vectors.test.sql');
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, sql } = build();
  if (process.argv.includes('--check')) {
    const stale = [[jsonPath, json], [sqlPath, sql]].filter(([p, c]) => { try { return readFileSync(p, 'utf8') !== c; } catch { return true; } });
    if (stale.length) { console.error(`STALE  ${stale.map(([p]) => path.relative(root, p)).join(', ')} (run scripts/gen-hashcanon.mjs)`); process.exit(1); }
    console.log(`up to date: ${VECTORS.length} vectors`);
  } else { writeFileSync(jsonPath, json); writeFileSync(sqlPath, sql); console.log(`wrote ${VECTORS.length} vectors`); }
}
