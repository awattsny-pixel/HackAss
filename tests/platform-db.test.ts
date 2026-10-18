import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dbModule from '../src/platform/db/index.ts';
import { WORKER_FUNCTIONS } from '../src/platform/db/types.ts';
import { createPublicDb, createUserDb, createWorkerDb } from '../src/platform/db/clients.ts';
import type { SqlRunner } from '../src/platform/db/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = { appEnv: 'local' as const, supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'anon-key-for-tests', appOrigin: 'http://localhost:3000' };
const recorder = () => { const calls: { text: string; values: readonly unknown[] }[] = []; const runner: SqlRunner = { query: async (text, values) => { calls.push({ text, values }); return { rows: [{ ok: true }] }; } }; return { calls, runner }; };

test('there is no way to obtain a service-level client from the database module', () => {
  for (const name of Object.keys(dbModule)) assert.ok(!/service|admin|superuser|root/i.test(name), `suspicious export: ${name}`);
  assert.deepEqual(Object.keys(dbModule).sort(), ['WORKER_FUNCTIONS', 'createPublicDb', 'createUserDb', 'createWorkerDb']);
  for (const f of ['clients.ts', 'types.ts', 'index.ts']) assert.ok(!/SERVICE_ROLE|service_role/i.test(readFileSync(join(root, 'src/platform/db', f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), `${f} mentions a service key`);
});

test('worker calls: allow-listed functions only, always parameterized, argument count bounded', async () => {
  const { calls, runner } = recorder();
  const db = createWorkerDb(runner);
  const canary = "x'; drop table jobs; --";
  const rows = await db.call('claim_jobs', ['worker-1', 5, 60, canary]);
  assert.deepEqual(rows, [{ ok: true }]);
  assert.equal(calls[0].text, 'select * from worker.claim_jobs($1, $2, $3, $4)');
  assert.ok(!calls[0].text.includes(canary), 'argument values must travel as parameters, not SQL text');
  assert.deepEqual(calls[0].values, ['worker-1', 5, 60, canary]);
  await db.call('heartbeat', []);
  assert.equal(calls[1].text, 'select * from worker.heartbeat()');
  for (const bad of ['claim_jobs; drop table jobs', 'pg_sleep', 'public.hacks', '', 'CLAIM_JOBS', 'claim_jobs ']) {
    await assert.rejects(() => db.call(bad as never, []), /not allow-listed/, bad);
  }
  await assert.rejects(() => db.call('claim_jobs', Array.from({ length: 13 }, (_, i) => i)), /too many arguments/);
  assert.equal(calls.length, 2, 'rejected calls must never reach the runner');
});

test('the worker function allow-list is exactly the documented set (and each name is a plain identifier)', () => {
  assert.deepEqual([...WORKER_FUNCTIONS].sort(), ['claim_jobs', 'complete_job', 'enqueue_followup', 'fail_job', 'get_job_subject', 'heartbeat', 'mark_invalidated', 'publish_automated', 'record_ai_evaluation', 'record_automated_decision', 'record_shadow_decision', 'release_job', 'reserve_ai_budget', 'settle_ai_budget'].sort());
  for (const f of WORKER_FUNCTIONS) assert.match(f, /^[a-z][a-z_]*$/);
});

test('public and user clients are constructed without any network access, and never persist sessions in the public case', () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('network used during construction'); }) as typeof fetch;
  try {
    const pub = createPublicDb(env);
    assert.equal(pub.kind, 'public');
    let wrote = 0;
    const user = createUserDb(env, { getAll: () => [], setAll: () => { wrote++; } });
    assert.equal(user.kind, 'user');
    assert.equal(wrote, 0, 'constructing a client must not write cookies');
  } finally { globalThis.fetch = realFetch; }
});

test('user-client cookie policy is server-side and HttpOnly (experiment: pinned in source until the real Auth spike validates it)', () => {
  const src = readFileSync(join(root, 'src/platform/db/clients.ts'), 'utf8');
  assert.match(src, /httpOnly: true/);
  assert.match(src, /sameSite: 'lax'/);
  assert.match(src, /EXPERIMENT/);
  assert.ok(!/createBrowserClient/.test(src));
});
