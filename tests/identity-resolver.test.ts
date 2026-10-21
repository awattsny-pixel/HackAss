// PX-2a: resolver trust levels and failure handling. The invariant under test: a T2 operation is never served at T1 level, whatever goes wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { satisfiesTier } from '../src/platform/index.ts';
import { authorize, OPERATION_TIER, resolveActor, tierFor, type ClaimsResult, type ServerResult, type SessionSource } from '../src/modules/identity/index.ts';

const UID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;
const good: ClaimsResult = { ok: true, claims: { userId: UID, sessionId: 's1', aal: 'aal1', expiresAt: NOW / 1000 + 600 } };
function src(over: Partial<{ claims: () => ClaimsResult | Promise<ClaimsResult>; server: () => Promise<ServerResult> }> = {}) {
  const calls = { claims: 0, server: 0 };
  const s: SessionSource = {
    claims: () => { calls.claims++; return (over.claims ?? (() => good))(); },
    serverVerify: () => { calls.server++; return (over.server ?? (async () => ({ ok: true, userId: UID } as ServerResult)))(); },
  };
  return { s, calls };
}
const opts = { now: () => NOW, serverTimeoutMs: 40 };

test('T0: anonymous is allowed; a signed-in member is recognised at claims level; the server is never asked', async () => {
  const a = src({ claims: () => ({ ok: false, reason: 'no_session' }) });
  const r0 = await resolveActor(a.s, 'T0', opts); assert.ok(r0.ok && r0.actor.kind === 'anonymous'); assert.equal(a.calls.server, 0);
  const b = src(); const r1 = await resolveActor(b.s, 'T0', opts);
  assert.ok(r1.ok && r1.actor.kind === 'member' && r1.actor.verification === 'claims'); assert.equal(b.calls.server, 0);
});
test('T1: claims only, no server call', async () => {
  const ok = src(); const r = await resolveActor(ok.s, 'T1', opts); assert.ok(r.ok && r.actor.kind === 'member' && r.actor.verification === 'claims'); assert.equal(ok.calls.server, 0);
});
const kindOf = (r: { ok: boolean; kind?: string; status?: number }) => `${r.ok}/${r.kind ?? ''}/${r.status ?? ''}`;
test('DEFINITE credential verdicts (no session, expired, invalid, expired by the clock) are 401 for T1 and T2, anonymous for T0, and never ask the server', async () => {
  for (const claims of [
    () => ({ ok: false, reason: 'no_session' } as ClaimsResult), () => ({ ok: false, reason: 'expired' } as ClaimsResult), () => ({ ok: false, reason: 'invalid' } as ClaimsResult),
    () => ({ ok: true, claims: { ...good.claims, expiresAt: NOW / 1000 - 1 } } as ClaimsResult),   // expired even if the source said ok
  ]) {
    for (const tier of ['T1', 'T2'] as const) { const x = src({ claims }); assert.equal(kindOf(await resolveActor(x.s, tier, opts)), 'false/unauthenticated/401'); assert.equal(x.calls.server, 0); }
    const t0 = await resolveActor(src({ claims }).s, 'T0', opts); assert.ok(t0.ok && t0.actor.kind === 'anonymous');
  }
});
test('a verification SERVICE failure is NOT a bad credential: unavailable reason, thrown error, malformed or uninterpretable claims all give 503 for T1 and T2 (never 401, never a member); T0 stays anonymous', async () => {
  const broken: Record<string, () => ClaimsResult | Promise<ClaimsResult>> = {
    'source reports unavailable (e.g. signing keys unreachable)': () => ({ ok: false, reason: 'unavailable' }),
    'source throws': () => { throw new Error('JWKS fetch failed'); },
    'source rejects': () => Promise.reject(new Error('timeout')),
    'undefined': () => undefined as unknown as ClaimsResult,
    'unknown reason': () => ({ ok: false, reason: 'weird' } as unknown as ClaimsResult),
    'bad user id': () => ({ ok: true, claims: { ...good.claims, userId: 'not-a-uuid' } } as ClaimsResult),
    'bad aal': () => ({ ok: true, claims: { ...good.claims, aal: 'aal9' } } as unknown as ClaimsResult),
    'non-finite expiry': () => ({ ok: true, claims: { ...good.claims, expiresAt: Number.NaN } } as ClaimsResult),
    'ok without claims': () => ({ ok: true } as unknown as ClaimsResult),
  };
  for (const [name, claims] of Object.entries(broken)) {
    for (const tier of ['T1', 'T2'] as const) { const x = src({ claims }); assert.equal(kindOf(await resolveActor(x.s, tier, opts)), 'false/auth_unavailable/503', `${tier}: ${name}`); assert.equal(x.calls.server, 0, name); }
    const t0 = await resolveActor(src({ claims }).s, 'T0', opts); assert.ok(t0.ok && t0.actor.kind === 'anonymous', `T0: ${name}`);
  }
});
test('T2: confirmed by the Auth server -> member with verification "server"', async () => {
  const x = src(); const r = await resolveActor(x.s, 'T2', opts);
  assert.ok(r.ok && satisfiesTier(r.actor, 'T2') && satisfiesTier(r.actor, 'T1'), 'agrees with the platform tier rules');
  const t1 = await resolveActor(src().s, 'T1', opts); assert.ok(t1.ok && satisfiesTier(t1.actor, 'T1') && !satisfiesTier(t1.actor, 'T2'), 'a T1 actor does NOT satisfy T2');
  assert.ok(r.ok && r.actor.kind === 'member' && r.actor.verification === 'server' && r.actor.userId === UID); assert.equal(x.calls.server, 1);
});
test('T2: no usable session is refused WITHOUT asking the server', async () => {
  const x = src({ claims: () => ({ ok: false, reason: 'expired' }) }); const r = await resolveActor(x.s, 'T2', opts);
  assert.deepEqual([r.ok, r.ok ? '' : r.kind, r.ok ? 0 : r.status], [false, 'unauthenticated', 401]); assert.equal(x.calls.server, 0);
});
test('T2: a session the server says is revoked or gone is refused (401), although the claims still verify', async () => {
  for (const reason of ['revoked', 'no_session'] as const) {
    const r = await resolveActor(src({ server: async () => ({ ok: false, reason }) }).s, 'T2', opts);
    assert.deepEqual([r.ok, r.ok ? '' : r.kind, r.ok ? 0 : r.status], [false, 'unauthenticated', 401]);
  }
});
test('T2: the server confirming a DIFFERENT user than the claims names is refused', async () => {
  const r = await resolveActor(src({ server: async () => ({ ok: true, userId: '22222222-2222-4222-8222-222222222222' }) }).s, 'T2', opts);
  assert.equal(r.ok, false);
});
test('T2 never downgrades to T1: outage, timeout, thrown error, malformed or unknown answers all give auth_unavailable (503), not a member', async () => {
  const cases: Record<string, () => Promise<ServerResult>> = {
    'provider reports unavailable': async () => ({ ok: false, reason: 'unavailable' }),
    'throws': async () => { throw new Error('ECONNRESET'); },
    'never answers (timeout)': () => new Promise<ServerResult>(() => {}),
    'null': async () => null as unknown as ServerResult,
    'string': async () => 'ok' as unknown as ServerResult,
    'unknown reason': async () => ({ ok: false, reason: 'weird' } as unknown as ServerResult),
    'ok without a user id (an unreadable "success")': async () => ({ ok: true } as unknown as ServerResult),
    'ok with an empty user id': async () => ({ ok: true, userId: '' } as ServerResult),
    'ok with a non-string user id': async () => ({ ok: true, userId: 7 } as unknown as ServerResult),
  };
  for (const [name, server] of Object.entries(cases)) {
    const r = await resolveActor(src({ server }).s, 'T2', opts);
    assert.equal(r.ok, false, name);
    if (!r.ok) { assert.equal(r.kind, 'auth_unavailable', name); assert.equal(r.status, 503, name); assert.equal(r.retryable, true, name); }
  }
});
test('documented T1 limitation: a session revoked by sign-out still passes T1 (claims valid) and is refused at T2', async () => {
  const revoked = src({ server: async () => ({ ok: false, reason: 'revoked' }) });
  assert.ok((await resolveActor(revoked.s, 'T1', opts)).ok);
  assert.equal((await resolveActor(revoked.s, 'T2', opts)).ok, false);
});
test('private reads are T2, exactly like private writes; only the signed-in indicator is T1', () => {
  assert.equal(tierFor('read-private'), 'T2'); assert.equal(tierFor('write-private'), 'T2'); assert.equal(tierFor('change-account'), 'T2');
  assert.equal(tierFor('show-signed-in-indicator'), 'T1'); assert.equal(tierFor('public-read'), 'T0');
  assert.deepEqual(Object.entries(OPERATION_TIER).filter(([, t]) => t === 'T1').map(([o]) => o), ['show-signed-in-indicator']);
});
test('authorize("read-private") during an Auth outage is refused with 503 and never returns a member', async () => {
  const r = await authorize(src({ server: async () => { throw new Error('down'); } }).s, 'read-private', opts);
  assert.ok(!r.ok && r.status === 503);
});
