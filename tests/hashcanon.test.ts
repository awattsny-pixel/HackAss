// HashCanon-1 in TypeScript, against the shared golden vectors that the SQL implementation is also checked against
// (supabase/tests/database/030_hashcanon_vectors.test.sql, generated from the same JSON file).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CANON_HEADER, CANON_VERSION, CanonError, canonStr, canonicalBytes, canonicalText, hashHex } from '../src/modules/submissions/index.ts';
import type { ContentDoc } from '../src/modules/submissions/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
interface Vector { name: string; storable: boolean; doc: ContentDoc; canonical?: string; sha256?: string; rejects?: string }
const file = JSON.parse(readFileSync(join(root, 'tests/fixtures/hashcanon-vectors.json'), 'utf8')) as { format: string; vectors: Vector[] };
const vectors = file.vectors;
const accepted = vectors.filter((v) => !v.rejects) as (Vector & { canonical: string; sha256: string })[];
const rejected = vectors.filter((v) => v.rejects);
const byName = (n: string) => accepted.find((v) => v.name === n)!;

test('there are at least thirty golden vectors, with unique names and 64-hex digests', () => {
  assert.equal(file.format, 'HACKASS-CANON-1');
  assert.ok(accepted.length >= 30, `only ${accepted.length} accepted vectors`);
  assert.ok(rejected.length >= 10, `only ${rejected.length} rejection vectors`);
  assert.equal(new Set(vectors.map((v) => v.name)).size, vectors.length);
  for (const v of accepted) assert.match(v.sha256, /^[0-9a-f]{64}$/, v.name);
  assert.ok(accepted.filter((v) => v.storable).length >= 30, 'most accepted vectors are also round-tripped through the real tables');
});

test('every golden vector: canonical text and SHA-256 match the stored expectation', async () => {
  for (const v of accepted) {
    assert.equal(canonicalText(v.doc), v.canonical, v.name);
    assert.equal(await hashHex(v.doc), v.sha256, v.name);
    assert.equal(createHash('sha256').update(v.canonical, 'utf8').digest('hex'), v.sha256, `${v.name}: Node crypto agrees with Web Crypto`);
    assert.deepEqual(Buffer.from(canonicalBytes(v.doc)), Buffer.from(v.canonical, 'utf8'), v.name);
  }
});

test('every rejection vector (uppercase or alternate UUID spellings, bad digests) is rejected, naming the field', () => {
  for (const v of rejected) {
    assert.throws(() => canonicalText(v.doc), (e: unknown) => e instanceof CanonError && e.path === v.rejects, v.name);
  }
  // and the accepted spelling is exactly the documented one
  assert.doesNotThrow(() => canonicalText({ attributions: [{ role: 'author', profile_id: '00000000-0000-4000-8000-0000000000aa' }], assets: [{ asset_id: '30000000-0000-4000-8000-0000000000bb', sha256: 'ab'.repeat(32) }] }));
});

test('the fixture files are exactly what the generator produces (nobody edited them by hand)', async () => {
  const gen = await import(pathToFileURL(join(root, 'scripts/gen-hashcanon.mjs')).href);
  const { json, sql } = gen.build();
  assert.equal(readFileSync(join(root, 'tests/fixtures/hashcanon-vectors.json'), 'utf8'), json);
  assert.equal(readFileSync(join(root, 'supabase/tests/database/030_hashcanon_vectors.test.sql'), 'utf8'), sql);
});

test('HAND-WRITTEN expectations (independent of the implementation): the empty document, a small document, and a multi-byte document', () => {
  assert.equal(canonicalText({}),
    'HACKASS-CANON-1\ncategory_slug:-:\ntitle:-:\nsummary:-:\noutcome:-:\ndifficulty:-:\ntime_min_minutes:-:\ntime_max_minutes:-:\ncost_min_cents:-:\ncost_max_cents:-:\ncurrency:-:\nestimate_basis:-:\nai_requirement:-:\nlimitations:-:\nsteps:0\nmaterials:0\nrequirements:0\ntags:0\nattributions:0\nsource_claims:0\nassets:0\n');
  assert.equal(canonicalText({ title: 'Hi', time_min_minutes: 0, steps: ['a', 'bc'], tags: ['z', 'a'], requirements: [{ kind: 'tool', name: 'x' }, { kind: 'skill', name: 'y', detail: 'd' }] }),
    'HACKASS-CANON-1\ncategory_slug:-:\ntitle:2:Hi\nsummary:-:\noutcome:-:\ndifficulty:-:\ntime_min_minutes:1:0\ntime_max_minutes:-:\ncost_min_cents:-:\ncost_max_cents:-:\ncurrency:-:\nestimate_basis:-:\nai_requirement:-:\nlimitations:-:\n'
    + 'steps:2\nstep;1;1:a\nstep;2;2:bc\nmaterials:0\nrequirements:2\nrequirement;5:skill;1:y;1:d\nrequirement;4:tool;1:x;-:\ntags:2\ntag;1:a\ntag;1:z\nattributions:0\nsource_claims:0\nassets:0\n');
  // length is in UTF-8 BYTES: e-acute is 2, the emoji is 4, the CJK character is 3
  assert.equal(canonicalText({ title: 'é', summary: '😀', outcome: '漢' }).split('\n').slice(2, 5).join('|'), 'title:2:é|summary:4:😀|outcome:3:漢');
});

test('equivalent inputs give the same text: NFC, CRLF/CR, null vs absent vs empty list, input order of sorted lists', () => {
  assert.equal(byName('combining acute (e + U+0301) normalizes to NFC').canonical, byName('precomposed acute (same canonical text as the previous vector)').canonical);
  assert.equal(canonicalText({ summary: 'a\r\nb' }), canonicalText({ summary: 'a\nb' }));
  assert.equal(canonicalText({ summary: 'a\rb' }), canonicalText({ summary: 'a\nb' }));
  assert.equal(canonicalText({ title: null, steps: null }), canonicalText({}));
  assert.equal(canonicalText({ steps: [], tags: [], assets: [] }), canonicalText({}));
  assert.equal(byName('requirements sorted by kind then name').canonical, byName('requirements: same set, other input order (same canonical text)').canonical);
  assert.equal(canonicalText({ tags: ['b', 'a', 'c'] }), canonicalText({ tags: ['c', 'b', 'a'] }));
  assert.equal(canonicalText({ assets: [{ asset_id: '00000000-0000-4000-8000-000000000001', sha256: 'bb'.repeat(32) }, { asset_id: '00000000-0000-4000-8000-000000000002', sha256: 'aa'.repeat(32) }] }), canonicalText({ assets: [{ asset_id: '00000000-0000-4000-8000-000000000002', sha256: 'aa'.repeat(32) }, { asset_id: '00000000-0000-4000-8000-000000000001', sha256: 'bb'.repeat(32) }] }));
});

test('different inputs give different text: empty vs null, case, whitespace, step order, field forgery', () => {
  const differ = (a: ContentDoc, b: ContentDoc, why: string) => assert.notEqual(canonicalText(a), canonicalText(b), why);
  differ({ title: '' }, {}, 'empty string vs absent');
  differ({ title: 'a' }, { title: 'A' }, 'case');
  differ({ title: 'a' }, { title: 'a ' }, 'trailing space');
  differ({ steps: ['a', 'b'] }, { steps: ['b', 'a'] }, 'step order is meaningful');
  differ({ materials: [{ name: 'a' }, { name: 'b' }] }, { materials: [{ name: 'b' }, { name: 'a' }] }, 'material order is meaningful');
  differ({ title: 'x\nsummary:1:y' }, { title: 'x', summary: 'y' }, 'a title cannot forge the summary line');
  differ({ steps: ['a;2;1:b'] }, { steps: ['a', 'b'] }, 'a step cannot forge a second step');
  differ({ time_min_minutes: 0 }, {}, 'zero is not null');
});

test('rejections: non-integers, wrong types, huge integers, non-objects', () => {
  const bad: unknown[] = [{ time_min_minutes: 1.5 }, { time_min_minutes: -1 }, { time_min_minutes: '5' }, { cost_max_cents: 1e21 }, { cost_max_cents: 1000000000000000 }, { title: 5 }, { steps: 'x' }, { steps: [1] }, { tags: [1] }, { materials: ['x'] }, { requirements: [null] }, null, [], 'x'];
  for (const d of bad) assert.throws(() => canonicalText(d as ContentDoc), CanonError, JSON.stringify(d));
  assert.doesNotThrow(() => canonicalText({ cost_max_cents: 999999999999999 }));
});

test('constants and idempotence', () => {
  assert.equal(CANON_VERSION, 1);
  assert.equal(CANON_HEADER, 'HACKASS-CANON-1\n');
  assert.ok(canonicalText({}).startsWith(CANON_HEADER));
  for (const s of ['plain', 'é', 'a\r\nb', '😀', '']) assert.equal(canonStr(canonStr(s)), canonStr(s));
});

test('fuzz: the encoding is injective over single-field documents with hostile characters (no two different inputs share a text)', () => {
  const alphabet = ['a', 'b', ':', ';', '\n', '-', '0', '1', '9', ' ', 'é', '😀', 'step', 'tag'];
  const seen = new Map<string, string>();
  const random = () => Array.from({ length: randomInt(0, 6) }, () => alphabet[randomInt(0, alphabet.length)]).join('');
  for (let i = 0; i < 2000; i++) {
    const s = random();
    const docs: [string, ContentDoc][] = [[`title|${s}`, { title: s }], [`summary|${s}`, { summary: s }], [`step|${s}`, { steps: [s] }], [`tag|${s}`, { tags: [s] }], [`material|${s}`, { materials: [{ name: s }] }], [`materialdetail|${s}`, { materials: [{ name: 'n', detail: s }] }]];
    for (const [key, d] of docs) {
      const canon = canonicalText(d);
      const normalizedKey = `${key.split('|')[0]}|${canonStr(s)}`;
      const prev = seen.get(canon);
      assert.ok(prev === undefined || prev === normalizedKey, `collision between ${JSON.stringify(prev)} and ${JSON.stringify(normalizedKey)}`);
      seen.set(canon, normalizedKey);
    }
  }
  assert.ok(seen.size > 100);
});
