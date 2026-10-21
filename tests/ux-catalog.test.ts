// The catalog read module: a failed, denied, invalid or empty response is REPORTED, never replaced with other content; arguments are validated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPublicHack, listPublicHacks, classifyFailure, type RpcClient } from '../src/modules/catalog/index.ts';

const item = (slug: string) => ({ slug, version_id: '11111111-1111-4111-8111-111111111111', published_at: '2026-01-02T03:04:05+00:00', category: { slug: 'home', name: 'Home' }, title: 'T ' + slug, summary: 'S', difficulty: 'easy', time_minutes: { min: 5, max: 10 }, cost: { min_cents: null, max_cents: null, currency: null }, ai_requirement: 'none' });
const fake = (res: { data?: unknown; error?: { code?: string; message?: string } | null; status?: number } | 'throw', calls: Array<[string, Record<string, unknown>]> = []): RpcClient => ({
  rpc: (fn, args) => { calls.push([fn, args]); if (res === 'throw') throw new Error('network'); return Promise.resolve({ data: res.data ?? null, error: res.error ?? null, status: res.status }); },
});

test('empty catalog is ok with zero items (not a failure, not demo content)', async () => {
  const r = await listPublicHacks(fake({ data: { items: [], page_size: 25, next_cursor: null } }));
  assert.ok(r.ok); assert.equal(r.page.items.length, 0);
});
test('a page parses, maps arguments to p_* names and exposes the cursor', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const r = await listPublicHacks(fake({ data: { items: [item('a')], page_size: 25, next_cursor: { published_at: '2026-01-02T03:04:05+00:00', slug: 'a' } } }, calls), { category: 'home', after: { published_at: '2026-01-03T00:00:00+00:00', slug: 'b' } });
  assert.ok(r.ok); assert.equal(r.page.nextCursor?.slug, 'a');
  assert.equal(calls[0][0], 'list_public_hacks'); assert.equal(calls[0][1].p_category, 'home'); assert.equal(calls[0][1].p_after_slug, 'b');
});
test('failures are reported with a kind and never carry items', async () => {
  for (const [res, kind] of [
    ['throw', 'unavailable'],
    [{ error: { code: '42501' } }, 'denied'],
    [{ error: { code: 'XX000' }, status: 500 }, 'unavailable'],
    [{ data: { items: 'nope' } }, 'invalid_response'],
    [{ data: { items: [{ ...item('a'), secret: 1, title: 5 }], page_size: 1, next_cursor: null } }, 'invalid_response'],
  ] as const) {
    const r = await listPublicHacks(fake(res));
    assert.equal(r.ok, false); assert.equal(r.ok ? '' : r.kind, kind);
    assert.equal('page' in r, false);
  }
});
test('arguments are validated before any call', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  for (const args of [{ limit: 0 }, { limit: 101 }, { category: 'Bad Slug!' }, { after: { published_at: 'x', slug: 'a' } }]) {
    const r = await listPublicHacks(fake({ data: {} }, calls), args as never); assert.equal(r.ok ? '' : r.kind, 'invalid_request');
  }
  assert.equal(calls.length, 0);
});
test('detail: not found, bad slug, invalid response', async () => {
  assert.equal((await getPublicHack(fake({ error: { code: 'PT404' } }), 'x')).ok, false);
  const bad = await getPublicHack(fake({ data: {} }), 'Not A Slug'); assert.equal(bad.ok ? '' : bad.kind, 'not_found');
  const inv = await getPublicHack(fake({ data: { slug: 'a' } }), 'a'); assert.equal(inv.ok ? '' : inv.kind, 'invalid_response');
});
test('classifyFailure', () => {
  assert.equal(classifyFailure({ code: 'PT404' }), 'not_found');
  assert.equal(classifyFailure({ code: 'PGRST202' }, 404), 'unavailable');
  assert.equal(classifyFailure({ code: 'PT422' }), 'invalid_request');
  assert.equal(classifyFailure({}, 401), 'denied');
});
