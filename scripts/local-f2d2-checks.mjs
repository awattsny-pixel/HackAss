#!/usr/bin/env node
// F2-D2 checks against the REAL local Supabase stack: fifty concurrent reservations against the global and the per-operation limits, concurrent same-key requests,
// changed arguments, settlement / cancellation / unknown-outcome races (no double charge, no double release), UTC rollover, ledger reconciliation, the absence of any
// access for members, anon, service_role and the worker login, and a COMMITTED rollback followed by re-application.
// The budget functions are owner-only and internal (nothing is wired to a capability yet), so every session here runs as the owner role in its own psql process.
// Run through `npm run db:test:auth`, or with the stack up:  node --conditions=react-server scripts/local-f2d2-checks.mjs
// Prints facts and PASS/FAIL only. Exit 0 all passed, 1 a check failed, 2 stack unreachable.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_CONTAINER, DOCKER, NETWORK, PUB, SECRET, SUPABASE, asOwner, confirmedSession, createRunner, ok, psql, rpc, session } from './lib/local-stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, failed } = createRunner();
const api = (name, token, args) => rpc('api', name, token, args);
const owner = (sqlText) => psql(`set role hackass_owner;\n${sqlText}`).out;
const last = (t) => t.split('\n').pop();
const stamp = randomBytes(3).toString('hex');
let n = 0;
const key = (p) => `${p}-${stamp}-${++n}`;
const doc = (title) => ({
  category_slug: `f2d2-${stamp}`, title, summary: 'Store cut herbs upright in water.', outcome: 'Crisp herbs for two weeks.', difficulty: 'easy', steps: ['Trim the stems.'],
  attributions: [{ role: 'author', external_name: 'A. Cook' }], source_claims: [{ kind: 'original_work' }],
});
owner(`insert into app.categories (slug, name) values ('f2d2-${stamp}', 'F2D2 ${stamp}') on conflict do nothing;`);
async function submission(title) {
  const m = await confirmedSession(); const t = m.session.access_token;
  const c = await api('create_draft', t); const sv = await api('save_draft', t, { p_version_id: c.body.version_id, p_content: doc(title) });
  const sub = await api('submit_version', t, { p_version_id: c.body.version_id, p_expected_hash: sv.body.content_hash });
  ok(sub.status === 200, `fixture submit: HTTP ${sub.status}`);
  return { sid: sub.body.submission_id, hash: sv.body.content_hash };
}
const S1 = await submission('F2D2 one');
const S2 = await submission('F2D2 two');

// ---- configuration helpers ---------------------------------------------------------------------------------------------------------------
const used = (scope, day = 'current_date') => Number(last(owner(`select coalesce((select reserved_micros + spent_micros from app.ai_budget_days where scope = '${scope}' and budget_day = ${day}), 0);`)));
/** Global budget for this scenario: what today already used + `extra` (scenarios share the global scope for the day). */
function setGlobal(extra) {
  owner(`insert into app.ai_budget_global (enabled, daily_limit_micros) values (true, ${used('global') + extra}) on conflict (id) do update set enabled = true, daily_limit_micros = ${used('global') + extra};`);
}
const newOp = (limit, cap = 1000) => { const op = `op_${stamp}_${++n}`.slice(0, 40); owner(`insert into app.ai_operation_types (op_type, enabled, daily_limit_micros, max_charge_micros) values ('${op}', true, ${limit}, ${cap});`); return op; };
const reserveSql = (k, op, max, s = S1) => `select app_budget.reserve('${k}', '${op}', '${s.sid}', '${s.hash}', ${max});`;
// A start barrier: every session connects, then waits on a shared advisory lock that a holder releases after 2.5 s, so they all begin at the same moment
// (docker exec starts each psql tens of milliseconds apart, which would otherwise hide races).
let barrierN = 0;
async function runAll(scripts) {
  const id = 7_770_000 + (++barrierN);
  const holder = session(asOwner(`select pg_advisory_lock(${id});\nselect pg_sleep(2.5);\nselect pg_advisory_unlock(${id});`));
  const runs = await Promise.all(scripts.map((x) => session(asOwner(`select pg_advisory_lock_shared(${id});\nselect pg_advisory_unlock_shared(${id});\n${x}`), 600)));
  await holder;
  return runs;
}
const okCount = (runs, re = /"reservation_id"/) => runs.filter((r) => re.test(r.out)).length;
const errCount = (runs, re) => runs.filter((r) => re.test(r.err)).length;
const noDeadlock = (runs) => ok(!runs.some((r) => /deadlock/i.test(r.err)), `a deadlock occurred: ${runs.find((r) => /deadlock/i.test(r.err))?.err}`);
const reconciled = () => ok(last(owner(`select (app_budget.reconcile_report(null) ->> 'ok');`)) === 'true', `the ledger does not reconcile: ${owner(`select app_budget.reconcile_report(null);`).slice(-400)}`);
const resId = (k) => last(owner(`select id from app.ai_reservations where idempotency_key = '${k}';`));
const terminals = (id) => Number(last(owner(`select count(*) from app.ai_ledger where reservation_id = '${id}' and kind in ('settle', 'cancel');`)));
const status = (id) => last(owner(`select status from app.ai_reservations where id = '${id}';`));
const scopeRow = (scope, day = 'current_date') => last(owner(`select reserved_micros || '/' || spent_micros || '/' || overrun_micros from app.ai_budget_days where scope = '${scope}' and budget_day = ${day};`));

await check('B1', 'fifty concurrent reservations cannot exceed the GLOBAL budget (operation limit far above it)', async () => {
  const op = newOp(10_000_000, 200); setGlobal(2500);
  const runs = await runAll(Array.from({ length: 50 }, () => reserveSql(key('b1'), op, 100)));
  noDeadlock(runs);
  const won = okCount(runs);
  ok(won === 25 && errCount(runs, /global_budget_exhausted/) === 25, `expected 25 accepted and 25 global_budget_exhausted, got ${won} / ${errCount(runs, /global_budget_exhausted/)}: ${runs.map((r) => r.err.split('\n')[0]).filter(Boolean).slice(0, 2).join(' | ')}`);
  ok(scopeRow(op).startsWith('2500/0') && used('global') <= used('global'), `operation total: ${scopeRow(op)}`);
  ok(last(owner(`select count(*) from app.ai_reservations where op_type = '${op}';`)) === '25', 'exactly 25 reservations exist');
  reconciled();
  return '50 simultaneous reserve calls of 100 against a global budget of 2500 -> 25 accepted (total exactly 2500), 25 refused global_budget_exhausted; no deadlock; ledger reconciles';
});

await check('B2', 'fifty concurrent reservations cannot exceed the per-OPERATION budget (global far above it)', async () => {
  const op = newOp(1800, 200); setGlobal(10_000_000);
  const runs = await runAll(Array.from({ length: 50 }, () => reserveSql(key('b2'), op, 100)));
  noDeadlock(runs);
  ok(okCount(runs) === 18 && errCount(runs, /operation_budget_exhausted/) === 32, `expected 18 accepted, 32 refused, got ${okCount(runs)} / ${errCount(runs, /operation_budget_exhausted/)}`);
  ok(scopeRow(op).startsWith('1800/0'), `operation total ${scopeRow(op)}`);
  reconciled();
  return '50 simultaneous reservations of 100 against an operation limit of 1800 -> 18 accepted (exactly 1800), 32 refused operation_budget_exhausted';
});

await check('B3', 'two operations sharing one global budget, 50 concurrent requests with mixed amounts: neither limit is ever exceeded', async () => {
  const a = newOp(2000, 300), b = newOp(2000, 300); setGlobal(3000);
  const amounts = Array.from({ length: 50 }, (_, i) => 20 + ((i * 37) % 281));
  const runs = await runAll(amounts.map((m, i) => reserveSql(key('b3'), i % 2 ? a : b, m)));
  noDeadlock(runs);
  const sums = last(owner(`select coalesce(sum(max_charge_micros) filter (where op_type = '${a}'), 0) || '/' || coalesce(sum(max_charge_micros) filter (where op_type = '${b}'), 0) from app.ai_reservations where op_type in ('${a}', '${b}');`)).split('/').map(Number);
  ok(sums[0] <= 2000 && sums[1] <= 2000 && sums[0] + sums[1] <= 3000, `limits exceeded: ${sums.join(' + ')}`);
  ok(sums[0] + sums[1] > 2700, `the budget should be nearly used (${sums[0] + sums[1]} of 3000)`);
  ok(sums[0] === Number(scopeRow(a).split('/')[0]) && sums[1] === Number(scopeRow(b).split('/')[0]), 'the totals equal the reservations');
  reconciled();
  return `50 mixed requests (20-300) over two operations (limit 2000 each) and a global 3000: reserved ${sums[0]} + ${sums[1]} = ${sums[0] + sums[1]} (<= 3000, each <= 2000); totals equal the reservations; no deadlock`;
});

await check('B4', 'many rounds of fifty concurrent unit reservations across two operations against one tight global budget: the global total is never exceeded (the cross-operation race)', async () => {
  const rounds = [];
  for (let r = 0; r < 4; r++) {
    const a = newOp(1_000_000, 10), b = newOp(1_000_000, 10); setGlobal(25);
    const runs = await runAll(Array.from({ length: 50 }, (_, i) => reserveSql(key('b4'), i % 2 ? a : b, 1)));
    noDeadlock(runs);
    const total = Number(last(owner(`select coalesce(sum(max_charge_micros), 0) from app.ai_reservations where op_type in ('${a}', '${b}');`)));
    ok(total === 25 && okCount(runs) === 25 && errCount(runs, /global_budget_exhausted/) === 25, `round ${r}: expected exactly 25 of 50 across the two operations, got ${total} (${okCount(runs)} accepted)`);
    rounds.push(total);
  }
  reconciled();
  return `4 rounds x 50 simultaneous requests of 1 unit over two operations against a global budget of 25: ${rounds.join(', ')} accepted (exactly the budget every time)`;
});

await check('B5', 'sustained contention: eight sessions looping reservations over four operations against one tight global budget never exceed it (the lock on the global counter)', async () => {
  const ops = [newOp(1_000_000, 10), newOp(1_000_000, 10), newOp(1_000_000, 10), newOp(1_000_000, 10)]; setGlobal(120);
  const loop = (i) => `do $x$ begin for n in 1..80 loop begin perform app_budget.reserve('b5-${stamp}-${i}-' || n, '${ops[i % 4]}', '${S1.sid}', '${S1.hash}', 1); exception when others then null; end; end loop; end $x$;`;
  const runs = await runAll(Array.from({ length: 8 }, (_, i) => loop(i)));
  noDeadlock(runs);
  const total = Number(last(owner(`select count(*) from app.ai_reservations where op_type in (${ops.map((o) => `'${o}'`).join(',')});`)));
  ok(total === 120 && used('global') >= 120, `640 attempts against a budget of 120 must accept exactly 120, got ${total}`);
  reconciled();
  return `8 sessions x 80 looped unit reservations (640 attempts) over 4 operations against a global budget of 120 -> exactly ${total} accepted, no deadlock, ledger reconciles`;
});

await check('I1', 'concurrent requests with the same idempotency key create exactly one reservation and consume the budget once; changed arguments are refused', async () => {
  const op = newOp(100_000, 1000); setGlobal(100_000);
  const k = key('i1');
  const before = used('global');
  const runs = await runAll(Array.from({ length: 50 }, () => reserveSql(k, op, 400)));
  noDeadlock(runs);
  ok(okCount(runs) === 50, `every identical request must succeed (replay or original), got ${okCount(runs)}: ${runs.find((r) => r.err)?.err}`);
  ok(runs.filter((r) => /"replayed": false/.test(r.out)).length === 1 && runs.filter((r) => /"replayed": true/.test(r.out)).length === 49, 'exactly one original and 49 replays');
  ok(new Set(runs.map((r) => /"reservation_id": "([^"]+)"/.exec(r.out)?.[1])).size === 1, 'all return the same reservation id');
  ok(used('global') - before === 400 && last(owner(`select count(*) from app.ai_reservations where idempotency_key = '${k}';`)) === '1', 'the budget was consumed once (400) by one reservation');
  const bad = await runAll([reserveSql(k, op, 401), reserveSql(k, op, 400, S2), reserveSql(k, newOp(1000), 400)]);
  ok(errCount(bad, /idempotency_conflict/) === 3, `changed arguments must be refused: ${bad.map((r) => r.err.split('\n')[0]).join(' | ')}`);
  // a race between two DIFFERENT argument sets on one fresh key: exactly one reservation; the other set is refused or replayed identically
  const k2 = key('i1b');
  const mix = await runAll(Array.from({ length: 40 }, (_, i) => reserveSql(k2, op, i % 2 ? 100 : 101)));
  ok(last(owner(`select count(*) from app.ai_reservations where idempotency_key = '${k2}';`)) === '1', 'one reservation for the racing key');
  const winner = Number(last(owner(`select max_charge_micros from app.ai_reservations where idempotency_key = '${k2}';`)));
  ok(okCount(mix) === 20 && errCount(mix, /idempotency_conflict/) === 20, `the 20 requests that match the winner (${winner}) succeed, the 20 that differ conflict: ${okCount(mix)}/${errCount(mix, /idempotency_conflict/)}`);
  reconciled();
  return `50 identical requests -> 1 reservation (1 original + 49 replays, one id), budget consumed once; 3 changed-argument reuses -> idempotency_conflict; 40 racing requests with two argument sets -> 1 reservation, 20 replays, 20 conflicts`;
});

await check('S1', 'settlement races: concurrent identical settles charge once; different amounts -> one winner; settle vs cancel vs unknown never double-charge or double-release', async () => {
  const op = newOp(1_000_000, 1000); setGlobal(1_000_000);
  // (a) 30 identical settles
  const k1 = key('s1a'); owner(reserveSql(k1, op, 500)); const id1 = resId(k1);
  const a = await runAll(Array.from({ length: 30 }, () => `select app_budget.settle('${id1}', 300);`));
  noDeadlock(a);
  ok(okCount(a, /"status": "settled"/) === 30 && a.filter((r) => /"replayed": false/.test(r.out)).length === 1, 'all 30 report settled, exactly one applied');
  ok(terminals(id1) === 1 && last(owner(`select spent_delta || '/' || released_micros from app.ai_ledger where reservation_id = '${id1}' and kind = 'settle';`)) === '300/200', 'one settle entry: spent 300, released 200');
  // (b) 30 settles with 6 different amounts
  const k2 = key('s1b'); owner(reserveSql(k2, op, 500)); const id2 = resId(k2);
  const b = await runAll(Array.from({ length: 30 }, (_, i) => `select app_budget.settle('${id2}', ${100 + (i % 6) * 50});`));
  const winner = last(owner(`select actual_micros from app.ai_reservations where id = '${id2}';`));
  ok(terminals(id2) === 1 && okCount(b, /"status": "settled"/) === 5 && errCount(b, /settlement_conflict/) === 25, `one amount (${winner}) wins: ${okCount(b, /"status": "settled"/)} successes (the winner's 5 identical requests), ${errCount(b, /settlement_conflict/)} conflicts`);
  // (c) settle vs cancel, 20 each, concurrently
  const k3 = key('s1c'); owner(reserveSql(k3, op, 500)); const id3 = resId(k3);
  const c = await runAll(Array.from({ length: 40 }, (_, i) => (i % 2 ? `select app_budget.settle('${id3}', 450);` : `select app_budget.cancel('${id3}', 'never_dispatched');`)));
  noDeadlock(c);
  const st = status(id3);
  ok(terminals(id3) === 1 && (st === 'settled' || st === 'cancelled'), `exactly one terminal outcome: ${st} x${terminals(id3)}`);
  ok(st === 'settled' ? errCount(c, /invalid_state/) === 20 : errCount(c, /invalid_state/) === 20, `the losing kind is refused (invalid_state) every time: ${errCount(c, /invalid_state/)}`);
  // (d) settle vs mark_unknown vs cancel, mixed
  const k4 = key('s1d'); owner(reserveSql(k4, op, 500)); const id4 = resId(k4);
  const d = await runAll(Array.from({ length: 45 }, (_, i) => [`select app_budget.settle('${id4}', 200);`, `select app_budget.mark_unknown('${id4}', 'timeout');`, `select app_budget.cancel('${id4}', 'provider_confirmed_no_charge');`][i % 3]));
  noDeadlock(d);
  ok(terminals(id4) <= 1, `at most one terminal entry (${terminals(id4)})`);
  const st4 = status(id4);
  const spent = Number(last(owner(`select coalesce(sum(spent_delta), 0) from app.ai_ledger where reservation_id = '${id4}';`)));
  const held = Number(last(owner(`select coalesce(sum(reserved_delta), 0) from app.ai_ledger where reservation_id = '${id4}';`)));
  ok((st4 === 'settled' && spent === 200 && held === 0) || (st4 === 'cancelled' && spent === 0 && held === 0) || (st4 === 'unknown' && spent === 0 && held === 500), `final state ${st4}: spent ${spent}, held ${held}`);
  // (e) recover an unknown one twice over, concurrently: settle(250) x10 and cancel x10
  const k5 = key('s1e'); owner(reserveSql(k5, op, 500)); const id5 = resId(k5); owner(`select app_budget.mark_unknown('${id5}', 'process_crash');`);
  ok(scopeRow(op).split('/')[0] >= '500', 'the unknown reservation still holds its 500');
  const e = await runAll(Array.from({ length: 20 }, (_, i) => (i % 2 ? `select app_budget.settle('${id5}', 250);` : `select app_budget.cancel('${id5}', 'provider_confirmed_no_charge');`)));
  ok(terminals(id5) === 1, 'recovery of an unknown reservation applies exactly once');
  void e;
  reconciled();
  return `(a) 30 identical settles -> 1 applied (spent 300, released 200); (b) 30 settles with 6 amounts -> winner ${winner}, 25 settlement_conflict; (c) 20 settles vs 20 cancels -> ${st}, one terminal entry, losers invalid_state; (d) 15 settle / 15 unknown / 15 cancel -> ${st4}, at most one terminal; (e) concurrent recovery of an unknown reservation applies once; ledger reconciles`;
});

await check('U1', 'unknown outcomes keep their reservation; nothing releases money by itself; UTC rollover neither resets nor loses outstanding obligations', async () => {
  const op = newOp(10_000, 1000); setGlobal(10_000);
  const ka = key('u1a'), kb = key('u1b');
  owner(`select app_budget.reserve_for_day('${ka}', '${op}', '${S1.sid}', '${S1.hash}', 600, current_date - 1);`);
  const ida = resId(ka);
  owner(`select app_budget.mark_unknown('${ida}', 'lease_expired');`);
  owner(`select app_budget.reserve_for_day('${kb}', '${op}', '${S1.sid}', '${S1.hash}', 700, current_date);`);
  const idb = resId(kb);
  owner(`select app_budget.mark_unknown('${idb}', 'timeout');`);
  const y0 = scopeRow(op, 'current_date - 1');
  // hammer both with operations that must NOT release: refused cancels (no confirmation), repeated unknown marks, refused re-reservations; and nothing runs by itself
  const noise = await runAll([...Array.from({ length: 10 }, () => `select app_budget.cancel('${ida}', 'probably_fine');`), ...Array.from({ length: 10 }, () => `select app_budget.mark_unknown('${idb}', 'other');`),
    ...Array.from({ length: 10 }, () => reserveSql(key('u1n'), op, 100))]);
  noDeadlock(noise);
  ok(errCount(noise, /charge_not_ruled_out/) === 10, 'unconfirmed cancels are refused');
  ok(status(ida) === 'unknown' && status(idb) === 'unknown', 'both reservations are still unknown');
  ok(scopeRow(op, 'current_date - 1') === y0 && scopeRow(op).split('/')[0] === String(700 + 100 * okCount(noise.slice(20))), `yesterday's books are unchanged (${y0}); today holds 700 plus today's new reservations`);
  const out = JSON.parse(last(owner(`select app_budget.outstanding();`)));
  ok(out.some((r) => r.reservation_id === ida) && out.some((r) => r.reservation_id === idb) && new Set(out.filter((r) => [ida, idb].includes(r.reservation_id)).map((r) => r.budget_day)).size === 2, 'outstanding() lists both, on two different days');
  // settle yesterday's today: it charges YESTERDAY
  const s = JSON.parse(last(owner(`select app_budget.settle('${ida}', 550);`)));
  ok(s.budget_day === last(owner(`select (current_date - 1)::text;`)), `the settlement keeps the reservation's day: ${s.budget_day}`);
  ok(scopeRow(op, 'current_date - 1') === '0/550/0' && scopeRow(op).split('/')[1] === '0', `yesterday: 0 held / 550 spent; today untouched by it: ${scopeRow(op)}`);
  ok(last(owner(`select (resolved_at::date >= budget_day)::text from app.ai_reservations where id = '${ida}';`)) === 'true', 'the settlement time is recorded separately from the budget day');
  // a new day does not forget, and does not inherit: today's budget is its own
  ok(used('global', 'current_date - 1') >= 550, 'yesterday still shows the spend');
  // overrun: record everything, flag it, refuse more
  const ko = key('u1o'); owner(reserveSql(ko, op, 300)); const ido = resId(ko);
  const o = JSON.parse(last(owner(`select app_budget.settle('${ido}', 20000);`)));
  ok(o.overrun_micros === 19700 && o.actual_micros === 20000, `overrun recorded: ${JSON.stringify(o)}`);
  const refused = await runAll([reserveSql(key('u1r'), op, 10)]);
  ok(errCount(refused, /budget_exhausted/) === 1, `an exhausted budget refuses further reservations: ${refused[0].err.split('\n')[0]}`);
  ok(last(owner(`select (app_budget.reconcile_report(null) -> 'overruns' -> 0 ->> 'overrun_micros') is not null;`)) === 't', 'the overrun is in the report');
  reconciled();
  return 'unknown reservations on yesterday and today stayed reserved through refused cancels and repeated marks; outstanding() spans days; settling yesterday\'s reservation today charged yesterday (550) and left today untouched; an overrun of 19700 (actual 20000 against a hold of 300) was recorded in full, flagged, and the exhausted budget refuses more; ledger reconciles';
});

await check('G1', 'scope integrity on the real stack: the name global is refused, counters cannot be deleted by ordinary DML, a missing counter is reported after real concurrent traffic', async () => {
  const ins = psql(`set role hackass_owner;\ninsert into app.ai_operation_types (op_type, enabled, daily_limit_micros, max_charge_micros) values ('global', true, 1000, 500);`, { tolerate: true });
  ok(ins.status !== 0 && /ai_operation_types_not_reserved_scope/.test(ins.err), `the operation name global must be refused by the database: ${ins.err.slice(-200)}`);
  ok(last(owner(`select count(*) from app.ai_operation_types where op_type = 'global';`)) === '0', 'no operation named global exists');
  const reserve = await runAll([reserveSql(key('g1'), 'global', 10)]);
  ok(/invalid_content/.test(reserve[0].err) && /op_type/.test(reserve[0].err), `reserve refuses global: ${reserve[0].err.split('\n')[0]}`);
  const del = await runAll([`delete from app.ai_budget_days where scope = 'global';`]);
  ok(/record_immutable/.test(del[0].err), `counter deletion must be refused: ${del[0].err.split('\n')[0]}`);
  ok(Number(last(owner(`select count(*) from app.ai_budget_days where scope = 'global';`))) >= 1, 'the global counters are all still there');
  // a counter goes missing behind the system's back (guard switched off by an operator with the right to): the report catches it
  const today = last(owner(`select (clock_timestamp() at time zone 'UTC')::date::text;`));
  const row = last(owner(`select reserved_micros || '/' || spent_micros || '/' || overrun_micros from app.ai_budget_days where scope = 'global' and budget_day = '${today}';`));
  owner(`alter table app.ai_budget_days disable trigger ai_budget_days_no_delete;\ndelete from app.ai_budget_days where scope = 'global' and budget_day = '${today}';\nalter table app.ai_budget_days enable trigger ai_budget_days_no_delete;`);
  const rep = JSON.parse(last(owner(`select app_budget.reconcile_report(null);`)));
  ok(rep.ok === false && rep.missing_counters.some((m) => m.scope === 'global' && m.budget_day === today), `the missing global counter must be reported: ${JSON.stringify(rep.missing_counters).slice(0, 200)}`);
  const [r, sp, ov] = row.split('/').map(Number);
  owner(`insert into app.ai_budget_days (budget_day, scope, reserved_micros, spent_micros, overrun_micros) values ('${today}', 'global', ${r}, ${sp}, ${ov});`);
  reconciled();
  return 'an operation named global is refused by the database and by reserve; DELETE on the counters is refused (PT409 record_immutable); with the guard deliberately switched off, a missing global counter is reported by name and day and the report is not ok; restored, it reconciles';
});

await check('A1', 'no access for members, anon, service_role or the worker login: not through the API, not as tables, not as functions', async () => {
  const m = await confirmedSession(); const t = m.session.access_token;
  const calls = [['reserve', { p_key: 'abcdefgh1', p_op: 'x_y_z', p_submission_id: S1.sid, p_content_hash: S1.hash, p_max: 1 }], ['settle', { p_reservation_id: S1.sid, p_actual: 1 }], ['outstanding', {}]];
  const bad = [];
  for (const [fn, a] of calls) for (const [who, tok] of [['member', t], ['anon', PUB], ['service', SECRET]]) {
    const r = await rpc('app_budget', fn, tok, a);
    if (r.status === 200) bad.push(`${who} ${fn} -> 200`);
  }
  for (const [who, tok] of [['member', t], ['anon', PUB], ['service', SECRET]]) { const r = await rpc('api', 'reserve', tok, {}); if (r.status === 200) bad.push(`${who} api.reserve -> 200`); }
  ok(bad.length === 0, `an unauthorized call succeeded: ${bad.join(', ')}`);
  const pw = randomBytes(18).toString('base64url'); psql(`alter role hackass_worker password '${pw}'`);
  const image = spawnSync(DOCKER, ['inspect', DB_CONTAINER, '--format', '{{.Config.Image}}'], { encoding: 'utf8' }).stdout.trim();
  const stmts = ['ai_budget_global', 'ai_operation_types', 'ai_reservations', 'ai_ledger', 'ai_budget_days'].flatMap((t2) => [`select count(*) from app.${t2};`, `insert into app.${t2} default values;`, `update app.${t2} set updated_at = now();`, `delete from app.${t2};`, `truncate app.${t2};`]);
  stmts.push(`select app_budget.reserve('abcdefgh1', 'x_y_z', gen_random_uuid(), '${'a'.repeat(64)}', 1);`, `select app_budget.settle(gen_random_uuid(), 1);`, `select app_budget.outstanding();`, `select app_budget.reconcile_report(null);`, `select app_budget.today();`, 'set role hackass_owner;');
  const w = spawnSync(DOCKER, ['run', '--rm', '-i', '-e', `PGPASSWORD=${pw}`, '--network', NETWORK, image, 'psql', '-h', DB_CONTAINER, '-U', 'hackass_worker', '-d', 'postgres', '-v', 'ON_ERROR_STOP=0', '-At', '-X'], { input: stmts.join('\n'), encoding: 'utf8', timeout: 90_000 });
  const errs = w.stderr.split('\n').filter((l) => /ERROR/.test(l));
  ok(errs.length === stmts.length && errs.every((e) => /permission denied/i.test(e)), `the worker must be refused on all ${stmts.length} statements, got ${errs.length}: ${errs.slice(0, 2).join(' | ')}`);
  const grants = last(psql(`select count(*) from pg_proc p cross join (values ('authenticated'), ('anon'), ('service_role'), ('hackass_worker'), ('postgres')) r(n) where p.pronamespace = 'app_budget'::regnamespace and has_function_privilege(r.n, p.oid, 'execute');`).out);
  ok(grants === '0', `${grants} execute grants on budget functions`);
  return `member / anon / service key: every schema-qualified and api call refused (9 + 3 calls, none HTTP 200; the schema is not exposed); worker login: ${stmts.length} statements (5 operations on 5 tables, 5 functions, SET ROLE) refused with permission denied; 0 EXECUTE grants on any app_budget function`;
});

await check('R7', 'rollback COMMITTED (data loss documented), the migrations re-applied (supabase migration up), the controls work again', async () => {
  const down = readFileSync(path.join(root, 'supabase/rollbacks/20261018090000_f2d2_down.sql'), 'utf8');
  const probe = () => psql(`select 'tables=' || count(*) from pg_class where relnamespace = 'app'::regnamespace and relname in ('ai_budget_global', 'ai_operation_types', 'ai_reservations', 'ai_ledger', 'ai_budget_days');
select 'schema=' || count(*) from pg_namespace where nspname = 'app_budget';
select 'fns=' || count(*) from pg_proc where pronamespace = 'app_budget'::regnamespace;
select 'ledger=' || count(*) from supabase_migrations.schema_migrations where version like '20261018%';
select 'rows=' || coalesce((select count(*) from app.ai_ledger), 0);`).out.replace(/\n/g, ' ');
  // PX-3a sits above every F2 slice in the ledger, so a COMMITTED rollback goes in true reverse order: PX-3a first (otherwise `supabase migration up` finds a gap and refuses). It is re-applied by the same `migration up`.
  const downPX3a = psql(readFileSync(path.join(root, 'supabase/rollbacks/20261020090000_px3a_down.sql'), 'utf8'));
  ok(!/ERROR/.test(downPX3a.out + (downPX3a.err ?? '')), `the PX-3a rollback failed: ${(downPX3a.out + (downPX3a.err ?? '')).slice(-300)}`);
  const downE = psql(readFileSync(path.join(root, 'supabase/rollbacks/20261019090000_f2e_down.sql'), 'utf8'));
  ok(!/ERROR/.test(downE.out), `the F2-E rollback failed: ${downE.out.slice(-300)}`);
  const before = probe();
  ok(/tables=5 schema=1 fns=\d+ ledger=2 rows=[1-9]/.test(before), `before: ${before}`);
  const rolled = psql(down);
  ok(!/ERROR/.test(rolled.out), `rollback failed: ${rolled.out.slice(-300)}`);
  const mid = psql(`select 'tables=' || count(*) from pg_class where relnamespace = 'app'::regnamespace and relname in ('ai_budget_global', 'ai_operation_types', 'ai_reservations', 'ai_ledger', 'ai_budget_days');
select 'schema=' || count(*) from pg_namespace where nspname = 'app_budget';
select 'ledger=' || count(*) from supabase_migrations.schema_migrations where version like '20261018%';`).out.replace(/\n/g, ' ');
  ok(/tables=0 schema=0 ledger=0/.test(mid), `after the committed rollback: ${mid}`);
  const up = spawnSync(SUPABASE, ['migration', 'up', '--local'], { cwd: root, encoding: 'utf8', timeout: 240_000 });
  ok(up.status === 0, `migration up failed: ${(up.stderr + up.stdout).slice(-400)}`);
  const end = probe();
  ok(/tables=5 schema=1 fns=\d+ ledger=2 rows=0/.test(end), `after re-application: ${end}`);
  // works again from empty
  owner(`insert into app.ai_budget_global (enabled, daily_limit_micros) values (true, 1000);\ninsert into app.ai_operation_types (op_type, enabled, daily_limit_micros, max_charge_micros) values ('after_reapply', true, 1000, 500);`);
  const r = JSON.parse(last(owner(reserveSql(key('r7'), 'after_reapply', 500))));
  ok(r.status === 'reserved', 'a reservation works after re-application');
  ok(last(owner(`select (app_budget.reconcile_report(null) ->> 'ok');`)) === 'true', 'and reconciles');
  return `before: ${before} | the committed rollback removed the schema, 5 tables and the 2 ledger versions (ALL spend history is gone: documented data loss) | after supabase migration up: ${end}; a reservation works again`;
});

const failures = failed();
console.log(`\nF2-D2 budget checks: ${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
console.log('NOT run here (hosted only): the same checks against a hosted project; any provider integration (none exists); a reconciliation scheduler or alerting (none exists).');
process.exit(failures ? 1 : 0);
