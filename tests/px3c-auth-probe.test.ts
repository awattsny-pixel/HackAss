// The browser harness's Auth health probe must not report a clean result when it could not confirm that its own fixtures were deleted.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = process.cwd();
const probe = await import(pathToFileURL(join(root, 'scripts/lib/auth-probe.mjs')).href);
const LIMITS = { maxMs: 5000, p90Ms: 1500 };

type Del = 'ok' | 'error' | 'throws';
function fakes(opts: { create?: 'ok' | 'error' | 'throws'; signin?: 'ok' | 'error' | 'throws'; del?: Del } = {}) {
  const log: string[] = []; let n = 0;
  const admin = { auth: { admin: {
    createUser: async () => {
      log.push('create');
      if (opts.create === 'throws') throw new Error('network');
      if (opts.create === 'error') return { data: { user: null }, error: { status: 500 } };
      return { data: { user: { id: `user-${++n}` } }, error: null };
    },
    deleteUser: async (id: string) => {
      log.push(`delete:${id}`);
      if (opts.del === 'throws') throw new Error('network');
      return opts.del === 'error' ? { data: null, error: { status: 504 } } : { data: {}, error: null };
    },
  } } };
  const makeAnon = () => ({ auth: { signInWithPassword: async () => {
    log.push('signin');
    if (opts.signin === 'throws') throw new Error('network');
    return opts.signin === 'error' ? { data: null, error: { status: 504 } } : { data: {}, error: null };
  } } });
  return { log, deps: { admin, makeAnon, password: 'x', rand: () => 'r' } };
}
const run = async (o: Parameters<typeof fakes>[0], n = 3) => { const f = fakes(o); const rows = await probe.authProbe(n, f.deps); return { ...f, rows, sum: probe.probeSummary(rows) }; };

test('a clean probe: every call ok and every fixture confirmed deleted', async () => {
  const r = await run({});
  assert.equal(r.sum.errors, 0); assert.equal(r.sum.delete_errors, 0); assert.equal(r.sum.unconfirmed_cleanup, 0);
  assert.equal(probe.probeBlocked(r.sum, LIMITS), false);
  assert.deepEqual(probe.leftBehind(r.rows), []);
});

test('REGRESSION: a deletion that returns an error cannot produce a clean probe', async () => {
  const r = await run({ del: 'error' });
  assert.equal(r.sum.errors, 0, 'create and sign-in were fine, so only the deletion fields can catch this');
  assert.equal(r.sum.delete_errors, 3); assert.equal(r.sum.unconfirmed_cleanup, 3);
  assert.equal(probe.probeBlocked(r.sum, LIMITS), true);
  assert.deepEqual(probe.leftBehind(r.rows), ['user-1', 'user-2', 'user-3']);
});

test('REGRESSION: a deletion that throws is recorded, not propagated, and cannot produce a clean probe', async () => {
  const r = await run({ del: 'throws' });
  assert.equal(r.rows.length, 3, 'the probe keeps going and reports every fixture');
  assert.ok(r.rows.every((x: { delete: string }) => x.delete === 'threw'));
  assert.equal(probe.probeBlocked(r.sum, LIMITS), true);
  assert.equal(probe.leftBehind(r.rows).length, 3);
});

test('cleanup is attempted even when sign-in fails or throws', async () => {
  for (const signin of ['error', 'throws'] as const) {
    const r = await run({ signin }, 1);
    assert.deepEqual(r.log, ['create', 'signin', 'delete:user-1'], `sign-in ${signin}`);
    assert.equal(r.sum.errors, 1); assert.equal(r.sum.unconfirmed_cleanup, 0);
    assert.equal(probe.probeBlocked(r.sum, LIMITS), true, 'a sign-in failure still blocks');
  }
});

test('when creation fails there is nothing to delete, and the probe still blocks', async () => {
  for (const create of ['error', 'throws'] as const) {
    const r = await run({ create }, 1);
    assert.deepEqual(r.log, ['create'], `create ${create}`);
    assert.equal(r.rows[0].delete, 'skipped'); assert.equal(r.sum.unconfirmed_cleanup, 0);
    assert.equal(probe.probeBlocked(r.sum, LIMITS), true);
  }
});

test('the harness uses the module: the gate and the unconfirmed-cleanup report come from it', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(root, 'scripts/px3c-browser-checks.mjs'), 'utf8');
  assert.match(src, /from '\.\/lib\/auth-probe\.mjs'/);
  assert.match(src, /probeBlocked\(sum,/);
  assert.match(src, /PROBE CLEANUP UNCONFIRMED/);
  assert.doesNotMatch(src, /if \(c\.data\?\.user\) await admin\.auth\.admin\.deleteUser/, 'the old unchecked deletion is gone');
  // A helper the harness still calls must still be imported (moving `pct` into the module once left the end-of-run trace line without it).
  const imported = (src.match(/import \{([^}]*)\} from '\.\/lib\/auth-probe\.mjs'/)?.[1] ?? '').split(',').map((x) => x.trim().split(/\s+as\s+/)[0]);
  for (const name of Object.keys(probe)) if (new RegExp(`\\b${name}\\(`).test(src.replace(/import \{[^}]*\} from '\.\/lib\/auth-probe\.mjs'/, ''))) assert.ok(imported.includes(name), `${name} is called by the harness but not imported`);
  assert.ok(imported.includes('pct'), 'the sign-in trace uses pct');
});
