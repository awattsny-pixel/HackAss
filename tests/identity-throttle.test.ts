// PX-2a: throttling. Trusted client address, keyed hashes, bounded counters, fail-closed storage, throttle before the provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CounterCapacityError, DEFAULT_RULES, createMemoryCounterStore, createThrottle, keyedHash, normalizeEmail, normalizeIp, runThrottled, trustedClientIp, type CounterStore, type ActionRules } from '../src/modules/identity/index.ts';

const SECRET = 'x'.repeat(40);
const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

test('client address: only a trusted source is used', () => {
  assert.equal(trustedClientIp(h({ 'x-forwarded-for': '1.2.3.4' }), { kind: 'none' }), null, 'no trusted source: unknown');
  assert.equal(trustedClientIp(h({ 'x-real-ip': '203.0.113.9' }), { kind: 'header', name: 'x-real-ip' }), '203.0.113.9');
  assert.equal(trustedClientIp(h({}), { kind: 'header', name: 'x-real-ip' }), null);
  assert.equal(trustedClientIp(h({ 'x-real-ip': 'not an ip' }), { kind: 'header', name: 'x-real-ip' }), null);
  // forwarded-for: counted from the right; whatever the client put on the left is ignored
  const xff = h({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 203.0.113.9' });
  assert.equal(trustedClientIp(xff, { kind: 'forwarded-for', trustedHops: 1 }), '203.0.113.9');
  assert.equal(trustedClientIp(xff, { kind: 'forwarded-for', trustedHops: 2 }), '7.7.7.7');
  assert.equal(trustedClientIp(h({ 'x-forwarded-for': '203.0.113.9' }), { kind: 'forwarded-for', trustedHops: 2 }), null, 'fewer hops than configured: not trusted');
  assert.equal(trustedClientIp(xff, { kind: 'forwarded-for', trustedHops: 0 }), null);
  assert.equal(trustedClientIp(h({ 'x-forwarded-for': '1.1.1.1, garbage' }), { kind: 'forwarded-for', trustedHops: 1 }), null);
});
test('IPv6 is reduced to its /64 (one subscriber cannot rotate addresses); IPv4-mapped is IPv4', () => {
  assert.equal(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:0db8:0001:0002::/64');
  assert.equal(normalizeIp('2001:db8:1:2::1'), normalizeIp('2001:db8:1:2:ffff::9'));
  assert.equal(normalizeIp('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(normalizeIp('999.1.1.1'), null);
});
test('keyed hashes: stable, secret-dependent, purpose-separated, email-normalized; the secret must be long enough', () => {
  const a = keyedHash(SECRET, 'email', normalizeEmail(' Alice@Example.COM ')); assert.equal(a, keyedHash(SECRET, 'email', 'alice@example.com'));
  assert.notEqual(a, keyedHash('y'.repeat(40), 'email', 'alice@example.com')); assert.notEqual(a, keyedHash(SECRET, 'ip', 'alice@example.com'));
  assert.match(a, /^[0-9a-f]{32}$/); assert.throws(() => keyedHash('short', 'email', 'a'));
  assert.throws(() => createThrottle({ secret: 'short', store: createMemoryCounterStore() }));
});
test('stored keys never contain the address or the email', async () => {
  const keys: string[] = []; const store: CounterStore = { hit: async (k, w, n) => { keys.push(k); return { count: 1, resetAtMs: n + w }; } };
  await createThrottle({ secret: SECRET, store }).check('recovery-request', { ip: '203.0.113.9', email: 'Victim@Example.com' });
  assert.ok(keys.length >= 3); for (const k of keys) { assert.doesNotMatch(k, /203\.0\.113|victim|example/i); }
});
test('limits: per address, per address+email, per email (where set), global; a window expires', async () => {
  let t = 1_000_000; const rules: Record<string, ActionRules> = { 'sign-in': { ip: { max: 3, windowMs: 1000 }, pair: { max: 2, windowMs: 1000 }, global: { max: 100, windowMs: 1000 } } };
  const th = createThrottle({ secret: SECRET, store: createMemoryCounterStore(), now: () => t, rules: rules as never });
  const ctx = { ip: '203.0.113.9', email: 'a@example.com' };
  assert.equal((await th.check('sign-in', ctx)).allowed, true); assert.equal((await th.check('sign-in', ctx)).allowed, true);
  const third = await th.check('sign-in', ctx); assert.ok(!third.allowed && third.scope === 'pair' && third.retryAfterSec >= 1);
  assert.equal((await th.check('sign-in', { ip: '203.0.113.9', email: 'b@example.com' })).allowed, false, 'the per-address limit (3) now trips for a different email from the same address');
  t += 1500; assert.equal((await th.check('sign-in', ctx)).allowed, true, 'a new window');
});
test('per-email limit (recovery) caps email bombing across addresses but sign-in has none (no lock-out lever)', async () => {
  const th = createThrottle({ secret: SECRET, store: createMemoryCounterStore() });
  let denied = 0; for (let i = 0; i < 6; i++) { const d = await th.check('recovery-request', { ip: `198.51.100.${i + 1}`, email: 'victim@example.com' }); if (!d.allowed && d.scope === 'identifier') denied++; }
  assert.ok(denied >= 3, 'after 3 requests for one email, the rest are refused whatever the address');
  for (let i = 0; i < 4; i++) { const d = await th.check('sign-in', { ip: `198.51.100.${i + 50}`, email: 'victim@example.com' }); assert.equal(d.allowed, true, 'sign-in from other addresses is not blocked by one email-wide limit'); }
});
test('unknown address: the SAME action limit applies to the shared unknown bucket (never a looser one); an extra restriction is additive', async () => {
  const t = 5_000_000;
  // recovery-request allows 5 per address per hour: the unknown bucket must deny the SIXTH, exactly like a known address
  const th = createThrottle({ secret: SECRET, store: createMemoryCounterStore(), now: () => t });
  const known = createThrottle({ secret: SECRET, store: createMemoryCounterStore(), now: () => t });
  const run = async (x: typeof th, ip: string | null) => { const out: boolean[] = []; for (let i = 0; i < 7; i++) out.push((await x.check('recovery-request', { ip, email: `m${i}@example.com` })).allowed); return out; };
  const kn = await run(known, '203.0.113.9'), un = await run(th, null);
  assert.deepEqual(kn, [true, true, true, true, true, false, false]); assert.deepEqual(un, kn, 'unknown-address requests are limited exactly like a known address');
  // every action: the unknown bucket never allows more than the action's per-address limit
  for (const action of Object.keys(DEFAULT_RULES) as (keyof typeof DEFAULT_RULES)[]) {
    const x = createThrottle({ secret: SECRET, store: createMemoryCounterStore(), now: () => t }); let ok = 0;
    for (let i = 0; i < DEFAULT_RULES[action].ip.max + 20; i++) if ((await x.check(action, { ip: null, email: `z${i}@example.com` })).allowed) ok++;
    assert.ok(ok <= DEFAULT_RULES[action].ip.max, `${action}: ${ok} allowed, limit ${DEFAULT_RULES[action].ip.max}`);
  }
  // an extra restriction only tightens
  const extra = createThrottle({ secret: SECRET, store: createMemoryCounterStore(), now: () => t, unknownIpExtra: { max: 2, windowMs: 60_000 } });
  assert.equal((await extra.check('invite-callback', { ip: null })).allowed, true); assert.equal((await extra.check('invite-callback', { ip: null })).allowed, true);
  const d = await extra.check('invite-callback', { ip: null }); assert.ok(!d.allowed && d.scope === 'ip');
  assert.equal((await createThrottle({ secret: SECRET, store: createMemoryCounterStore(), now: () => t, unknownIpExtra: { max: 1000, windowMs: 60_000 } }).check('invite-callback', { ip: null })).allowed, true, 'a loose extra does not loosen the action limit');
});
test('REGRESSION capacity pressure: 6,000 distinct requests in one frozen window with a global limit of 300 approve at most 300 (default store capacity)', async () => {
  const t = 7_000_000; const rules = { 'sign-in': { ip: { max: 50, windowMs: 300_000 }, global: { max: 300, windowMs: 300_000 } } };
  const th = createThrottle({ secret: SECRET, store: createMemoryCounterStore(), now: () => t, rules: rules as never });
  let approved = 0; for (let i = 0; i < 6000; i++) if ((await th.check('sign-in', { ip: `10.${(i >> 8) & 255}.${i & 255}.1`, email: `u${i}@example.com` })).allowed) approved++;
  assert.ok(approved <= 300, `approved ${approved} of 6000 (limit 300)`); assert.equal(approved, 300);
});
test('REGRESSION capacity pressure, small store: active counters are never evicted; new keys are refused (denied), and the global limit still holds', async () => {
  const t = 9_000_000; const rules = { 'sign-in': { ip: { max: 50, windowMs: 300_000 }, global: { max: 20, windowMs: 300_000 } } };
  const store = createMemoryCounterStore({ maxKeys: 10 });
  const th = createThrottle({ secret: SECRET, store, now: () => t, rules: rules as never });
  let approved = 0; let store_denied = 0;
  for (let i = 0; i < 500; i++) { const d = await th.check('sign-in', { ip: `10.0.${i >> 8}.${i & 255}` }); if (d.allowed) approved++; else if (d.scope === 'store') store_denied++; }
  assert.ok(approved <= 20, `approved ${approved}, global limit 20`); assert.ok(store_denied > 0, 'new keys were refused once the store was full'); assert.ok(store.size <= 10);
});
test('the store reports capacity with a retry time; expired entries are reclaimed so service resumes after the window', async () => {
  const s = createMemoryCounterStore({ maxKeys: 3 });
  for (const k of ['a', 'b', 'c']) await s.hit(k, 60_000, 1000);
  await assert.rejects(() => s.hit('d', 60_000, 1000), (e: unknown) => e instanceof CounterCapacityError && e.retryAfterMs >= 1000);
  assert.equal((await s.hit('a', 60_000, 1000)).count, 2, 'an existing active key keeps counting when the store is full');
  assert.equal((await s.hit('d', 60_000, 1000 + 60_001)).count, 1, 'after the windows end, entries are reclaimed');
  const th = createThrottle({ secret: SECRET, store: createMemoryCounterStore({ maxKeys: 1 }), now: () => 1000 });
  await th.check('sign-in', { ip: '203.0.113.1' }); const d = await th.check('sign-in', { ip: '203.0.113.2' });
  assert.ok(!d.allowed && d.scope === 'store' && d.retryAfterSec >= 1, 'a full store denies with a retry time');
});
test('the memory store is bounded (size never exceeds maxKeys)', async () => {
  const s = createMemoryCounterStore({ maxKeys: 50 }); let refused = 0;
  for (let i = 0; i < 5000; i++) { try { await s.hit(`k${i}`, 60_000, 1000); } catch (e) { if (e instanceof CounterCapacityError) refused++; else throw e; } }
  assert.ok(s.size <= 50, `size ${s.size}`); assert.equal(refused, 4950);
});
test('a failing store always DENIES (fail closed); there is no option to allow', async () => {
  const broken: CounterStore = { hit: async () => { throw new Error('store down'); } };
  const d = await createThrottle({ secret: SECRET, store: broken }).check('sign-in', { ip: '203.0.113.9' }); assert.ok(!d.allowed && d.scope === 'store' && d.retryAfterSec > 0);
  assert.equal((await createThrottle({ secret: SECRET, store: broken, onStoreError: 'allow' } as never).check('sign-in', { ip: '203.0.113.9' })).allowed, false, 'an onStoreError option, if passed, has no effect');
});
test('the throttle runs BEFORE the provider call: a denied request never reaches it', async () => {
  const th = createThrottle({ secret: SECRET, store: createMemoryCounterStore(), unknownIpExtra: { max: 1, windowMs: 60_000 } });
  let providerCalls = 0; const call = async () => { providerCalls++; return 'ok'; };
  const a = await runThrottled(th, 'invite-callback', { ip: null }, call); const b = await runThrottled(th, 'invite-callback', { ip: null }, call);
  assert.ok(a.ok); assert.ok(!b.ok && b.kind === 'rate_limited'); assert.equal(providerCalls, 1);
});
