import test from 'node:test';
import assert from 'node:assert/strict';
import { ANONYMOUS, isMember, isStaff, parseUserId, satisfiesTier } from '../src/platform/actor.ts';
import type { Actor, MemberActor, StaffActor } from '../src/platform/actor.ts';

const id = parseUserId('00000000-0000-4000-8000-000000000001');
const now = new Date('2026-10-13T12:00:00Z');
const member = (over: Partial<MemberActor> = {}): MemberActor => ({ kind: 'member', userId: id, aal: 'aal1', verification: 'claims', ...over });
const staff = (over: Partial<StaffActor> = {}): StaffActor => ({ kind: 'staff', userId: id, roles: ['reviewer'], aal: 'aal2', verification: 'server', mfaVerifiedAt: new Date(now.getTime() - 60_000), ...over });
const worker: Actor = { kind: 'worker', capability: 'job-runner' };

test('user ids must be UUIDs', () => {
  assert.throws(() => parseUserId('not-a-uuid'));
  assert.throws(() => parseUserId(undefined));
  assert.equal(parseUserId('00000000-0000-4000-8000-000000000001'), '00000000-0000-4000-8000-000000000001');
});

test('the anonymous actor is frozen and recognised by the guards', () => {
  assert.ok(Object.isFrozen(ANONYMOUS));
  assert.equal(isMember(ANONYMOUS), false);
  assert.equal(isStaff(staff()), true);
  assert.equal(isMember(member()), true);
});

test('tiers: T0 anyone; T1 members/staff; T2 requires server verification; T3 requires staff, aal2, server verification and fresh MFA', () => {
  const o = { now };
  assert.ok(satisfiesTier(ANONYMOUS, 'T0', o) && satisfiesTier(worker, 'T0', o));
  assert.equal(satisfiesTier(ANONYMOUS, 'T1', o), false);
  assert.equal(satisfiesTier(worker, 'T1', o), false);
  assert.ok(satisfiesTier(member(), 'T1', o));
  assert.equal(satisfiesTier(member(), 'T2', o), false, 'claims-verified member must not satisfy T2');
  assert.ok(satisfiesTier(member({ verification: 'server' }), 'T2', o));
  assert.equal(satisfiesTier(member({ verification: 'server', aal: 'aal2' }), 'T3', o), false, 'a member is never staff');
  assert.ok(satisfiesTier(staff(), 'T3', o));
});

test('T3 rejects claims-only verification, aal1, stale or missing MFA, a future MFA timestamp, and an empty role set', () => {
  const o = { now };
  assert.equal(satisfiesTier(staff({ verification: 'claims' }), 'T3', o), false);
  assert.equal(satisfiesTier(staff({ aal: 'aal1' }), 'T3', o), false);
  assert.equal(satisfiesTier(staff({ mfaVerifiedAt: null }), 'T3', o), false);
  assert.equal(satisfiesTier(staff({ mfaVerifiedAt: new Date(now.getTime() - 16 * 60_000) }), 'T3', o), false);
  assert.ok(satisfiesTier(staff({ mfaVerifiedAt: new Date(now.getTime() - 14 * 60_000) }), 'T3', o));
  assert.equal(satisfiesTier(staff({ mfaVerifiedAt: new Date(now.getTime() + 10 * 60_000) }), 'T3', o), false);
  assert.equal(satisfiesTier(staff({ roles: [] }), 'T3', o), false);
  assert.ok(satisfiesTier(staff({ mfaVerifiedAt: new Date(now.getTime() - 20 * 60_000) }), 'T3', { now, stepUpWindowMs: 30 * 60_000 }));
});
