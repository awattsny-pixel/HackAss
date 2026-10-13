// Gitleaks integration: the pinned install, the scan wrapper, the reviewed-fingerprint list, and real scans.
// Parts 1-3 use doubles and need no binary. Part 4 runs the real pinned binary against this repository and against
// temporary repositories holding a synthetic secret; if the binary is absent it is SKIPPED with a visible reason, except
// when REQUIRE_GITLEAKS=1 (set in CI), where absence is a failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const installer = await import(pathToFileURL(join(root, 'scripts/install-gitleaks.mjs')).href);
const scanner = await import(pathToFileURL(join(root, 'scripts/scan-gitleaks.mjs')).href);
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const pin = JSON.parse(read('scripts/gitleaks-pin.json'));

// ---- 1. the pin ---------------------------------------------------------------------------------------------------

test('pin: exact version, official release URL, one 64-hex SHA-256 per platform asset, file names carry the version', () => {
  assert.match(pin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pin.downloadBase, `https://github.com/gitleaks/gitleaks/releases/download/v${pin.version}/`);
  assert.match(pin.checksumsFileSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(pin.assets).sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64']);
  for (const [key, a] of Object.entries(pin.assets) as [string, { file: string; sha256: string }][]) {
    assert.match(a.sha256, /^[0-9a-f]{64}$/, key);
    assert.equal(a.file, `gitleaks_${pin.version}_${key.replace('-', '_')}.tar.gz`, key);
  }
});

test('CI installs the pinned version with the repository script and runs the scan; nothing downloads "latest" or uses a third-party action', () => {
  const ci = yaml.load(read('.github/workflows/ci.yml')) as { jobs: Record<string, { steps: { run?: string; uses?: string; with?: Record<string, unknown> }[] }> };
  const steps = ci.jobs.verify.steps;
  const idx = (needle: string) => steps.findIndex((s) => s.run === needle);
  assert.ok(idx('node scripts/install-gitleaks.mjs') >= 0 && idx('npm run scan:gitleaks') > idx('node scripts/install-gitleaks.mjs'));
  assert.ok(idx('npm run scan:gitleaks') < idx('npm run scan:secrets'), 'Gitleaks runs before the supplementary scanner');
  const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout'))!;
  assert.equal(checkout.with?.['fetch-depth'], 0, 'the history scan needs full history');
  const text = read('.github/workflows/ci.yml');
  assert.ok(!/gitleaks-action|releases\/latest|gitleaks\/gitleaks@/i.test(text));
  const testStep = steps.find((s) => s.run === 'npm test') as { env?: Record<string, string> };
  assert.equal((testStep as { env?: Record<string, string> }).env?.REQUIRE_GITLEAKS, '1', 'CI must not skip the real-binary tests');
});

// ---- 2. the installer, with doubles ---------------------------------------------------------------------------------

function fakePin(data: Buffer) {
  return { version: '9.9.9', downloadBase: 'https://example.invalid/dl/', assets: { 'linux-x64': { file: 'g.tar.gz', sha256: createHash('sha256').update(data).digest('hex') } } };
}
const tmp = () => mkdtempSync(join(tmpdir(), 'hackass-gl-install-'));

test('installer: a wrong digest is refused before anything is written or extracted', async () => {
  const base = tmp();
  try {
    const good = Buffer.from('archive-bytes');
    let extracted = false;
    await assert.rejects(() => installer.installGitleaks({ pin: fakePin(good), base, platform: 'linux', arch: 'x64', fetchBuffer: async () => Buffer.from('tampered'), extract: () => { extracted = true; }, versionOf: () => '9.9.9' }), /SHA-256 mismatch/);
    assert.equal(extracted, false);
    assert.equal(existsSync(join(base, '.tools')), false, 'nothing may be left behind');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('installer: a matching digest installs only from the pinned URL; a reported version other than the pin is removed again; a present binary is not re-downloaded', async () => {
  const base = tmp();
  try {
    const data = Buffer.from('archive-bytes');
    const urls: string[] = [];
    const extract = (_a: string, dir: string) => writeFileSync(join(dir, 'gitleaks'), '#!/bin/sh\n');
    const ok = await installer.installGitleaks({ pin: fakePin(data), base, platform: 'linux', arch: 'x64', fetchBuffer: async (u: string) => { urls.push(u); return data; }, extract, versionOf: () => '9.9.9' });
    assert.deepEqual(urls, ['https://example.invalid/dl/g.tar.gz']);
    assert.equal(ok.downloaded, true);
    assert.deepEqual(readdirSync(join(base, '.tools/gitleaks/9.9.9')), ['gitleaks'], 'the archive is removed after extraction');
    const again = await installer.installGitleaks({ pin: fakePin(data), base, platform: 'linux', arch: 'x64', fetchBuffer: async () => { throw new Error('must not download'); }, extract, versionOf: () => '9.9.9' });
    assert.equal(again.downloaded, false);
    rmSync(join(base, '.tools'), { recursive: true, force: true });
    await assert.rejects(() => installer.installGitleaks({ pin: fakePin(data), base, platform: 'linux', arch: 'x64', fetchBuffer: async () => data, extract, versionOf: () => '1.0.0' }), /reports version/);
    assert.equal(existsSync(join(base, '.tools/gitleaks/9.9.9')), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('installer: an unsupported platform is a distinct BLOCKED error, never a download', async () => {
  await assert.rejects(() => installer.installGitleaks({ pin: fakePin(Buffer.from('x')), base: tmp(), platform: 'win32', arch: 'x64', fetchBuffer: async () => { throw new Error('must not download'); } }), installer.UnsupportedPlatform);
  assert.equal(installer.assetFor(pin, 'darwin', 'x64').file, `gitleaks_${pin.version}_darwin_x64.tar.gz`);
});

// ---- 3. the wrapper, with doubles; and the reviewed fingerprint list ----------------------------------------------

type Exec = (cmd: string, args: string[], opts: { cwd?: string }) => { status: number | null; stdout: string; stderr: string; error: string | null };
function wrapper(behaviour: (scan: 'dir' | 'git', reportPath: string) => { status: number | null; report?: unknown }) {
  const logs: string[] = [];
  const seenReports: string[] = [];
  const exec: Exec = (_cmd, args) => {
    const report = args[args.indexOf('-r') + 1];
    seenReports.push(report);
    const r = behaviour(args[0] as 'dir' | 'git', report);
    if (r.report !== undefined) writeFileSync(report, JSON.stringify(r.report));
    return { status: r.status, stdout: '', stderr: '', error: null };
  };
  const run = (resolved: { bin?: string; blocked?: string } = { bin: 'fake-gitleaks' }) => scanner.runGitleaks({ rootDir: root, exec, pin, resolve: () => resolved, log: { info: (m: string) => logs.push(m), error: (m: string) => logs.push(m) } });
  return { run, logs, seenReports };
}
const finding = { RuleID: 'github-pat', File: 'src/x.ts', StartLine: 3, Commit: 'abcdef1234567890' };

test('wrapper: clean scans exit 0; scans use the config, the fingerprint list, redaction, no inline allow, and write reports outside the repository', () => {
  const calls: string[][] = [];
  const exit = scanner.runGitleaks({ rootDir: root, pin, resolve: () => ({ bin: 'fake' }), log: { info: () => {}, error: () => {} }, exec: (_c: string, args: string[]) => { calls.push(args); return { status: 0, stdout: '', stderr: '', error: null }; } });
  assert.equal(exit, 0);
  assert.deepEqual(calls.map((a) => a[0]), ['dir', 'git']);
  for (const a of calls) {
    for (const flag of ['--redact', '--no-banner', '--ignore-gitleaks-allow']) assert.ok(a.includes(flag), `${a[0]} lacks ${flag}`);
    assert.equal(a[a.indexOf('--config') + 1], join(root, '.gitleaks.toml'));
    assert.equal(a[a.indexOf('--gitleaks-ignore-path') + 1], join(root, '.gitleaksignore'));
    assert.ok(!a[a.indexOf('-r') + 1].startsWith(root), 'reports must live outside the repository');
  }
});

test('wrapper: findings exit 1 and are listed by rule/file/commit/line; tool failure exits 3; inconsistent output exits 3; a missing binary is BLOCKED (2)', () => {
  const found = wrapper((scan) => scan === 'git' ? { status: 10, report: [finding] } : { status: 0, report: [] });
  assert.equal(found.run(), 1);
  assert.ok(found.logs.some((l) => /github-pat\s+src\/x\.ts:3 @abcdef1/.test(l)));
  assert.equal(wrapper(() => ({ status: 1 })).run(), 3, 'a gitleaks crash is not a finding and not a pass');
  assert.equal(wrapper(() => ({ status: 10, report: [] })).run(), 3, 'leaks reported without entries is inconsistent');
  assert.equal(wrapper(() => ({ status: 0, report: '{broken' as unknown as object })).run(), 3);
  const blocked = wrapper(() => ({ status: 0 }));
  assert.equal(blocked.run({ blocked: 'not installed' }), 2);
  assert.match(blocked.logs.join('\n'), /^BLOCKED/);
  assert.equal(blocked.seenReports.length, 0, 'nothing runs when blocked');
});

test('wrapper: temporary reports and the staged tree are removed afterwards', () => {
  const w = wrapper(() => ({ status: 0, report: [] }));
  w.run();
  for (const r of w.seenReports) assert.equal(existsSync(r), false, 'report left behind');
  assert.equal(existsSync(join(w.seenReports[0], '..')), false, 'temp directory left behind');
});

test('resolveBinary: only the pinned version is accepted', () => {
  const exec = (bin: string) => ({ status: 0, stdout: bin === 'old' ? '8.0.0\n' : `${pin.version}\n`, stderr: '', error: null });
  assert.notEqual(scanner.resolveBinary({ env: { GITLEAKS_BIN: 'old' }, pin, base: tmp(), exec, exists: () => true }).bin, 'old', 'a wrong-version override is never used');
  const wrong = scanner.resolveBinary({ env: {}, pin, base: tmp(), exec: () => ({ status: 0, stdout: '8.0.0', stderr: '', error: null }), exists: () => true });
  assert.match(wrong.blocked, /pinned/);
  assert.match(scanner.resolveBinary({ env: {}, pin, base: tmp(), exec: () => ({ status: null, stdout: '', stderr: '', error: 'ENOENT' }), exists: () => false }).blocked, /was not found/);
});

const REVIEWED = [
  '1307cd05dee946353af37ed48495ae78cdf4e5d9:.env:jwt:5',
  'c25e78061ffd8ddda046f787d31a13bd68723daa:.env:jwt:2',
  'c25e78061ffd8ddda046f787d31a13bd68723daa:.env:generic-api-key:3',
  '1307cd05dee946353af37ed48495ae78cdf4e5d9:SETUP_COMPLETE.md:jwt:104',
  'c25e78061ffd8ddda046f787d31a13bd68723daa:API_SPECIFICATION.md:generic-api-key:71',
  'c25e78061ffd8ddda046f787d31a13bd68723daa:API_SPECIFICATION.md:generic-api-key:102',
];

test('reviewed fingerprints: exactly the six reviewed historic findings, and no working-tree exemption, each a full exact fingerprint, no wildcards; the config has no allowlists', () => {
  const entries = read('.gitleaksignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.deepEqual([...entries].sort(), [...REVIEWED].sort(), 'changing the reviewed set requires changing this test (a review step)');
  for (const e of entries) assert.match(e, /^(?:[0-9a-f]{40}:)?[A-Za-z0-9_.\/-]+:[a-z0-9-]+:\d+$/, e);
  const toml = read('.gitleaks.toml');
  assert.ok(entries.every((e) => /^[0-9a-f]{40}:/.test(e)), 'every exemption is pinned to a commit; there are no working-tree exemptions');
  assert.match(toml, /useDefault = true/);
  assert.ok(!/\[\[?allowlists?\]?\]|^\s*(paths|commits|regexes|stopwords)\s*=/m.test(toml), 'no path/commit/regex allowlists');
});

// ---- 4. the real binary -------------------------------------------------------------------------------------------

const resolved = scanner.resolveBinary();
const real = resolved.bin as string | undefined;
const needReal = process.env.REQUIRE_GITLEAKS === '1';
const realTest = (name: string, fn: () => void) => {
  if (real) return test(name, fn);
  if (needReal) return test(name, () => assert.fail(`REQUIRE_GITLEAKS=1 but the pinned binary is unavailable: ${resolved.blocked}`));
  return test(name, { skip: `pinned Gitleaks not installed (${resolved.blocked})` }, () => {});
};

function scanRepo(dir: string) {
  const logs: string[] = [];
  const code = scanner.runGitleaks({ rootDir: dir, pin, resolve: () => ({ bin: real }), log: { info: (m: string) => logs.push(m), error: (m: string) => logs.push(m) } });
  return { code, out: logs.join('\n') };
}
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hackass-gl-repo-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  for (const f of ['.gitleaks.toml', '.gitleaksignore']) writeFileSync(join(dir, f), read(f));
  writeFileSync(join(dir, 'readme.md'), 'clean file\n');
  git('add', '.'); git('commit', '-q', '-m', 'clean');
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
// assembled at run time and random: this file contains no secret-shaped literal
const syntheticToken = () => 'gh' + 'p_' + randomBytes(27).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 36).padEnd(36, 'k');

realTest('real binary: this repository is clean in the working tree and in full history (only the six reviewed historic findings are suppressed)', () => {
  const r = scanRepo(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /working tree: 0 new finding/);
  assert.match(r.out, /git history: 0 new finding/);
});

realTest('real binary: a newly introduced synthetic secret fails BOTH the tree scan and the history scan, and is never printed', () => {
  const r = tempRepo();
  try {
    const secret = syntheticToken();
    writeFileSync(join(r.dir, 'config.ts'), `export const token = "${secret}";\n`);
    r.git('add', '.'); r.git('commit', '-q', '-m', 'add secret');
    const res = scanRepo(r.dir);
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /working tree: [1-9]\d* new finding/, res.out);
    assert.match(res.out, /git history: [1-9]\d* new finding/, res.out);
    assert.match(res.out, /config\.ts/);
    assert.ok(!res.out.includes(secret) && !res.out.includes(secret.slice(4, 20)), 'the secret value must never be printed');
  } finally { r.cleanup(); }
});

realTest('real binary: a secret deleted from the tree still fails the history scan, and the tree scan alone is clean', () => {
  const r = tempRepo();
  try {
    writeFileSync(join(r.dir, 'config.ts'), `export const token = "${syntheticToken()}";\n`);
    r.git('add', '.'); r.git('commit', '-q', '-m', 'add secret');
    writeFileSync(join(r.dir, 'config.ts'), 'export const token = process.env.T;\n');
    r.git('commit', '-q', '-am', 'remove secret');
    const res = scanRepo(r.dir);
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /working tree: 0 new finding/);
    assert.match(res.out, /git history: [1-9]\d* new finding/);
  } finally { r.cleanup(); }
});

realTest('real binary: the reviewed list is exact, not broad (a new secret in a reviewed FILE, at a new commit, is still found; inline gitleaks:allow does not hide a secret)', () => {
  const r = tempRepo();
  try {
    mkdirSync(join(r.dir, 'sub'));
    writeFileSync(join(r.dir, 'SETUP_COMPLETE.md'), `# notes\n\nkey: "${syntheticToken()}"\n`);
    writeFileSync(join(r.dir, 'allowed.ts'), `export const t = "${syntheticToken()}"; // gitleaks:allow\n`);
    r.git('add', '.'); r.git('commit', '-q', '-m', 'new secrets in a reviewed file name, and an inline allow');
    const res = scanRepo(r.dir);
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /SETUP_COMPLETE\.md/);
    assert.match(res.out, /allowed\.ts/, 'gitleaks:allow must not suppress findings');
  } finally { r.cleanup(); }
});

realTest('real binary: a new synthetic secret at the exact former documentation-example locations fails the tree scan BEFORE it is committed', () => {
  for (const line of [71, 102]) {
    const r = tempRepo();
    try {
      // the repository's real API_SPECIFICATION.md (placeholders), committed clean
      writeFileSync(join(r.dir, 'API_SPECIFICATION.md'), read('API_SPECIFICATION.md'));
      r.git('add', '.'); r.git('commit', '-q', '-m', 'spec');
      assert.equal(scanRepo(r.dir).code, 0, 'the placeholder document is clean');
      const lines = readFileSync(join(r.dir, 'API_SPECIFICATION.md'), 'utf8').split('\n');
      assert.match(lines[line - 1], /"token": "<JWT-PLACEHOLDER>"/, `line ${line} should hold the placeholder`);
      const seg = (n: number) => randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9]/g, 'q');
      const secret = `eyJ${seg(10)}.eyJ${seg(12)}.${seg(14)}`;
      lines[line - 1] = `  "token": "${secret}",`;
      writeFileSync(join(r.dir, 'API_SPECIFICATION.md'), lines.join('\n')); // modified, NOT committed
      const res = scanRepo(r.dir);
      assert.equal(res.code, 1, res.out);
      assert.match(res.out, new RegExp(`working tree: [1-9]\\d* new finding[\\s\\S]*API_SPECIFICATION\\.md:${line}`), res.out);
      assert.match(res.out, /git history: 0 new finding/, 'nothing is committed yet');
      assert.ok(!res.out.includes(secret));
    } finally { r.cleanup(); }
  }
});
