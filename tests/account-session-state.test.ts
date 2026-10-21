// PX-2c: the signed-in indicator's rules. An outage never signs anyone out; only a definite "anonymous" after being a member shows the signed-out notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSession, interpretSessionResponse, reduceSession, shouldRecheck, type SessionEvent, type SessionState } from '../src/ui/account/session-state.ts';

const run = (...es: SessionEvent[]): SessionState => es.reduce(reduceSession, initialSession);
const res = (result: 'member' | 'anonymous' | 'unavailable', at = 1, setupPending = false): SessionEvent => ({ type: 'result', result, at, setupPending });

test('first results: member, anonymous, or unavailable (not a guess)', () => {
  assert.equal(run(res('member')).status, 'member'); assert.equal(run(res('anonymous')).status, 'anonymous'); assert.equal(run(res('unavailable')).status, 'unavailable');
  assert.equal(run(res('anonymous')).notice, null, 'never being signed in is not a sign-out');
  assert.equal(run(res('member', 1, true)).setupPending, true);
});
test('REGRESSION: an outage never signs a member out: they stay shown as signed in, degraded, with a "cant_check" notice', () => {
  const s = run(res('member'), res('unavailable', 2)); assert.deepEqual([s.status, s.notice], ['degraded', 'cant_check']);
  const again = reduceSession(s, res('unavailable', 3)); assert.equal(again.status, 'degraded');
  const back = reduceSession(again, res('member', 4)); assert.deepEqual([back.status, back.notice], ['member', null], 'recovers silently');
});
test('a definite anonymous answer after being a member (also after a degraded period) shows the signed-out notice once', () => {
  const s = run(res('member'), res('anonymous', 2)); assert.deepEqual([s.status, s.notice], ['anonymous', 'signed_out']);
  assert.equal(reduceSession(s, { type: 'notice_shown' }).notice, null);
  const d = run(res('member'), res('unavailable', 2), res('anonymous', 3)); assert.equal(d.notice, 'signed_out');
});
test('an outage while anonymous or checking does not invent a session; explicit sign-in and sign-out are exact', () => {
  assert.equal(run(res('anonymous'), res('unavailable', 2)).status, 'anonymous');
  assert.equal(run({ type: 'signed_in', at: 1 }).status, 'member'); const out = run({ type: 'signed_in', at: 1 }, { type: 'signed_out', at: 2 }); assert.deepEqual([out.status, out.notice], ['anonymous', null]);
  assert.equal(reduceSession(run(res('member', 1, true)), { type: 'signed_out', at: 2 }).setupPending, false);
});
test('the "cant_check" notice is not cleared by the toast event (the indicator keeps showing it)', () => {
  assert.equal(reduceSession(run(res('member'), res('unavailable', 2)), { type: 'notice_shown' }).notice, 'cant_check');
});
test('focus re-check is throttled but never skipped the first time', () => {
  assert.equal(shouldRecheck(null, 5), true); assert.equal(shouldRecheck(1000, 5000, 10_000), false); assert.equal(shouldRecheck(1000, 11_000, 10_000), true);
});
test('responses are interpreted conservatively: anything unexpected is "unavailable", never "anonymous" or "member"', () => {
  assert.deepEqual(interpretSessionResponse(200, { state: 'member', setupPending: true }), { result: 'member', setupPending: true });
  assert.deepEqual(interpretSessionResponse(200, { state: 'anonymous' }), { result: 'anonymous', setupPending: false });
  for (const [st, b] of [[503, { error: {} }], [500, null], [401, { state: 'anonymous' }], [200, null], [200, {}], [200, { state: 'weird' }], [200, 'member'], [0, undefined], [404, { state: 'member' }]] as const) assert.equal(interpretSessionResponse(st, b).result, 'unavailable', `${st} ${JSON.stringify(b)}`);
});

// ---- REGRESSIONS: stale answers can never overwrite a newer sign-in or sign-out
import { createSessionCoordinator, type CheckOutcome } from '../src/ui/account/session-coordinator.ts';
import { reduceSession as reduce } from '../src/ui/account/session-state.ts';
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
function harness(initial: SessionState = initialSession) { let state = initial; const events: SessionEvent[] = []; const c = createSessionCoordinator((e) => { events.push(e); state = reduce(state, e); }, () => 1); return { c, get state() { return state; }, events }; }
const flush = () => new Promise((r) => setTimeout(r, 0));

test('reducer: a result from an older generation is discarded after a sign-in, a sign-out or the start of an action', () => {
  const inFlight = reduce(initialSession, { type: 'signed_out', gen: 0, at: 1 }); // anonymous, generation 0
  const signedIn = reduce(inFlight, { type: 'signed_in', gen: 2, at: 2 });
  assert.equal(reduce(signedIn, { type: 'result', gen: 1, result: 'anonymous', at: 3 }).status, 'member', 'an old "anonymous" must not undo the sign-in');
  const signedOut = reduce(signedIn, { type: 'signed_out', gen: 4, at: 4 });
  assert.equal(reduce(signedOut, { type: 'result', gen: 3, result: 'member', at: 5 }).status, 'anonymous', 'an old "member" must not undo the sign-out');
  assert.equal(reduce(signedOut, { type: 'result', gen: 3, result: 'member', at: 5 }).notice, null);
  const begun = reduce(initialSession, { type: 'action_begin', gen: 1 }); assert.equal(reduce(begun, { type: 'result', gen: 0, result: 'member', at: 1 }).status, 'checking', 'a result older than the action is ignored even before the action finishes');
  assert.equal(reduce(begun, { type: 'result', gen: 1, result: 'member', at: 1 }).status, 'member', 'a result from the current generation is accepted');
});
test('DELAYED RESPONSE, direction 1: a slow "anonymous" check that finishes after the sign-in cannot sign the member out again', async () => {
  const h = harness(); const slow = deferred<CheckOutcome>(); let signal: AbortSignal | undefined;
  const check = h.c.check((s) => { signal = s; return slow.promise; });             // check begins while anonymous
  const begun = h.c.beginAction(); await flush();                                  // the member signs in: the action cancels the check and waits for it
  assert.equal(signal?.aborted, true, 'the in-flight check was cancelled');
  slow.resolve({ result: 'anonymous', setupPending: false }); await check;           // the stale answer arrives late
  const end = await begun; h.c.signedIn(); end();
  assert.equal(h.state.status, 'member', 'the stale anonymous answer overwrote the sign-in');
  await h.c.check(async () => ({ result: 'member', setupPending: false })); assert.equal(h.state.status, 'member');
});
test('DELAYED RESPONSE, direction 2: a slow "member" check that finishes after the sign-out cannot restore the signed-in state', async () => {
  const h = harness(reduce(initialSession, { type: 'signed_in', gen: 0, at: 0 })); const slow = deferred<CheckOutcome>();
  const check = h.c.check(() => slow.promise);
  const begun = h.c.beginAction(); await flush();                                    // the member signs out
  slow.resolve({ result: 'member', setupPending: false }); await check;              // the stale "member" answer arrives late
  const end = await begun; h.c.signedOut(); end();
  assert.equal(h.state.status, 'anonymous', 'the stale member answer restored the session');
  assert.equal(h.state.notice, null);
});
test('the requests never overlap: the action waits for the cancelled check to settle; no check starts during an action; checks resume afterwards', async () => {
  const h = harness(); const slow = deferred<CheckOutcome>(); const order: string[] = [];
  const check = h.c.check(async () => { order.push('check-start'); const r = await slow.promise; order.push('check-end'); return r; });
  const begun = h.c.beginAction().then((end) => { order.push('action-sends'); return end; }); await flush();
  assert.deepEqual(order, ['check-start'], 'the action must not send while the check is in flight');
  slow.resolve({ result: 'anonymous', setupPending: false }); await check; const end = await begun;
  assert.deepEqual(order, ['check-start', 'check-end', 'action-sends']);
  let ran = false; await h.c.check(async () => { ran = true; return { result: 'member', setupPending: false }; }); assert.equal(ran, false, 'a check started during an action');
  end(); await h.c.check(async () => { ran = true; return { result: 'anonymous', setupPending: false }; }); assert.equal(ran, true, 'checks do not resume after the action');
});
test('only one check runs at a time; a failed action leaves the state as it was and checks resume', async () => {
  const h = harness(reduce(initialSession, { type: 'signed_in', gen: 0, at: 0 })); let runs = 0; const slow = deferred<CheckOutcome>();
  const a = h.c.check(async () => { runs++; return slow.promise; }); const b = h.c.check(async () => { runs++; return { result: 'anonymous', setupPending: false }; }); assert.equal(runs, 1);
  slow.resolve({ result: 'member', setupPending: false }); await Promise.all([a, b]);
  const end = await h.c.beginAction(); end();                                          // a sign-in that failed: no signedIn()
  assert.equal(h.state.status, 'member'); await h.c.check(async () => ({ result: 'member', setupPending: false })); assert.equal(runs, 1);
});
