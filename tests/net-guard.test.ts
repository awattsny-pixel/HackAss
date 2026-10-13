// Tests for the smoke harness network guard. The guard patches the process-wide `net` module, so everything runs
// in a child process (tests/smoke/guard-probe.cjs). Inside it, a RECORDING DOUBLE replaces the real Socket#connect
// before the guard loads, so no destination -- permitted or refused -- is ever actually contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
interface Result { name: string; forwarded: boolean; errorCode: string | null }
interface Probe { results: Result[]; log: { kind: string; target: string }[] }

function probe(mode: 'guard' | 'noguard'): Probe {
  const dir = mkdtempSync(join(tmpdir(), 'hackass-guard-test-'));
  try {
    const logFile = join(dir, 'guard.log');
    writeFileSync(logFile, '');
    const out = execFileSync(process.execPath, ['tests/smoke/guard-probe.cjs', mode], { cwd: root, env: { PATH: process.env.PATH ?? '', SMOKE_NETGUARD_LOG: logFile }, encoding: 'utf8', timeout: 60000 });
    const line = out.split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, `probe produced no result:\n${out}`);
    return JSON.parse(line!.slice('PROBE:'.length)) as Probe;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const guarded = probe('guard');
const control = probe('noguard');
const byName = (p: Probe, name: string) => p.results.find((r) => r.name === name)!;
const allowed = guarded.results.filter((r) => r.name.startsWith('allow:'));
const denied = guarded.results.filter((r) => r.name.startsWith('deny:'));

test('control (no guard): every refused case really reaches Socket#connect, so the cases are not vacuous', () => {
  assert.equal(control.results.length, guarded.results.length);
  for (const r of control.results) assert.equal(r.forwarded, true, `${r.name} never reached connect even without the guard`);
  assert.equal(control.log.length, 0);
});

test('the reported bypass: an external IPv4 address in Node\'s normalized [options, cb] array is refused, not forwarded', () => {
  for (const name of ['deny:ipv4-normalized-array', 'deny:ipv4-normalized-array-callback', 'deny:ipv4-object', 'deny:ipv4-port-host']) {
    const r = byName(guarded, name);
    assert.equal(r.forwarded, false, `${name} was forwarded to the real connect`);
    assert.equal(r.errorCode, 'ESMOKEGUARD', name);
  }
  assert.ok(guarded.log.some((l) => l.target === '198.51.100.1'), 'attempt to 198.51.100.1 was not recorded');
});

test('external numeric IPv4 (public, private, link-local metadata, unspecified) is refused in every call shape', () => {
  for (const r of denied.filter((d) => d.name.startsWith('deny:ipv4'))) {
    assert.equal(r.forwarded, false, r.name);
    assert.equal(r.errorCode, 'ESMOKEGUARD', r.name);
  }
});

test('IPv6 (documentation range, IPv4-mapped external, link-local) is refused', () => {
  for (const r of denied.filter((d) => d.name.startsWith('deny:ipv6'))) {
    assert.equal(r.forwarded, false, r.name);
    assert.equal(r.errorCode, 'ESMOKEGUARD', r.name);
  }
});

test('hostnames are refused: plain, look-alikes of localhost/127.0.0.1, numeric shorthand, and localhost with a custom lookup', () => {
  for (const r of denied.filter((d) => /^deny:(hostname|numeric|localhost)/.test(d.name))) {
    assert.equal(r.forwarded, false, r.name);
    assert.equal(r.errorCode, 'ESMOKEGUARD', r.name);
  }
  assert.ok(guarded.log.some((l) => l.kind === 'connect-custom-lookup'));
});

test('higher-level clients that end in Socket#connect (tls, http, fetch over IPv4 and IPv6) are refused', () => {
  for (const name of ['deny:tls-connect-ip', 'deny:http-request-ip', 'deny:fetch-ipv4', 'deny:fetch-ipv6']) {
    const r = byName(guarded, name);
    assert.equal(r.forwarded, false, `${name} reached the real connect`);
    assert.ok(r.errorCode, `${name} did not fail`);
  }
});

test('permitted loopback destinations are forwarded in every call shape (127/8, ::1 in several spellings, mapped, localhost, unix paths, normalized array)', () => {
  assert.ok(allowed.length >= 14);
  for (const r of allowed) {
    assert.equal(r.forwarded, true, `${r.name} was wrongly blocked`);
    assert.equal(r.errorCode, null, r.name);
  }
});

test('every refused attempt is recorded, and nothing permitted is', () => {
  assert.equal(guarded.log.length, denied.length, `expected one record per refused case, got ${guarded.log.length} for ${denied.length}`);
  const permittedSpellings = new Set(['127.0.0.1', '127.255.255.254', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'localhost']);
  for (const l of guarded.log) {
    // the only logged permitted-looking spelling is `localhost` combined with a custom lookup, which is refused on purpose
    assert.ok(!permittedSpellings.has(l.target) || (l.kind === 'connect-custom-lookup' && l.target === 'localhost'), `permitted destination was logged: ${l.kind} ${l.target}`);
  }
});
