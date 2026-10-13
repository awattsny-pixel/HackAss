// The secret scanner (scripts/scan-secrets.mjs). Every synthetic credential is assembled at run time so that this
// file itself contains nothing the scanner would flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scanner = await import(pathToFileURL(join(root, 'scripts/scan-secrets.mjs')).href);
const { scanText, scanWorkingTree, scanWorkingTreeDetailed, scanHistory, RULES } = scanner;

const synthetic: Record<string, string> = {
  jwt: ['eyJ' + 'a'.repeat(14), 'eyJ' + 'b'.repeat(14), 'c'.repeat(14)].join('.'),
  'supabase-secret-key': 'sb_' + 'secret_' + 'A1b2'.repeat(6),
  'db-url-with-password': 'postgres' + '://app_user:' + 'Zq81vN4kx' + '@db.internal-host.test:5432/app',
  'aws-access-key': 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP',
  'private-key-block': '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  'github-token': 'gh' + 'p_' + 'a1B2c3'.repeat(7),
  'slack-token': 'xo' + 'xb-' + '1234567890-abcdefghij',
  'stripe-live-key': 's' + 'k_' + 'live_' + 'a1B2c3d4'.repeat(3),
  'credential-assignment': 'const apiKey = "' + 'k9X2mQ7vL4'.repeat(3) + '";',
};

test('every rule detects its synthetic credential, reports a fingerprint, and never echoes the value', () => {
  assert.deepEqual(Object.keys(synthetic).sort(), RULES.map((r: { id: string }) => r.id).sort(), 'add a synthetic case for every rule');
  for (const [rule, value] of Object.entries(synthetic)) {
    const text = rule === 'credential-assignment' ? `line one\n${value}\n` : `line one\nconst x = ${JSON.stringify(value)};\n`; // the assignment sample already contains its own quotes
    const findings = scanText(text, 'src/example.ts');
    assert.ok(findings.some((f: { rule: string }) => f.rule === rule), `${rule} not detected`);
    const f = findings.find((x: { rule: string }) => x.rule === rule);
    assert.equal(f.file, 'src/example.ts');
    assert.equal(f.line, 2);
    assert.match(f.fingerprint, /^[0-9a-f]{10}$/);
    assert.ok(!JSON.stringify(findings).includes(value), `${rule}: the finding contains the secret value`);
  }
});

test('placeholders, variable references and loopback database URLs are not findings', () => {
  const clean = [
    'SUPABASE_SERVICE_ROLE_KEY=your-server-only-secret-key', 'password: "dummy-service"', 'apiKey: process.env.SOME_KEY_NAME_THAT_IS_LONG_ENOUGH',
    'DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.xxxx.supabase.co:5432/postgres', 'postgres://user:pw@localhost:5432/test', 'postgres://user:pw@127.0.0.1:5432/test',
    'const secret = "${SECRET_VALUE_FROM_ENV_VARIABLES}";', 'CURSOR_SIGNING_SECRET=changeme-changeme-changeme-changeme', 'token = "<paste your token here please>"',
  ];
  for (const line of clean) assert.deepEqual(scanText(line + '\n', 'docs/x.md'), [], line);
});

test('an allowlist entry suppresses exactly its rule, file and fingerprint', () => {
  const value = synthetic.jwt;
  const [f] = scanText(`${value}\n`, 'docs/a.md');
  const allow = [{ rule: 'jwt', file: 'docs/a.md', fingerprint: f.fingerprint, reason: 'test' }];
  assert.deepEqual(scanText(`${value}\n`, 'docs/a.md', allow), []);
  assert.equal(scanText(`${value}\n`, 'docs/other.md', allow).length, 1, 'another file is still flagged');
  assert.equal(scanText(`${value}x\n`, 'docs/a.md', allow).length, 1, 'a different value is still flagged');
});

test('the committed allowlist has a written reason for every entry', () => {
  const entries = JSON.parse(readFileSync(join(root, '.secret-scan-allow.json'), 'utf8'));
  assert.ok(entries.length <= 4, 'keep the allowlist small');
  for (const e of entries) { assert.ok(e.rule && e.file && e.fingerprint, JSON.stringify(e)); assert.ok(String(e.reason).length > 40, `reason too thin: ${e.file}`); }
});

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hackass-scan-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('working-tree scan covers tracked and untracked-but-not-ignored files, and skips ignored files and node_modules', () => {
  const r = tempRepo();
  try {
    writeFileSync(join(r.dir, '.gitignore'), 'ignored.env\nnode_modules/\n');
    writeFileSync(join(r.dir, 'tracked.ts'), `export const a = "${synthetic['supabase-secret-key']}";\n`);
    writeFileSync(join(r.dir, 'untracked.ts'), `export const b = "${synthetic['github-token']}";\n`);
    writeFileSync(join(r.dir, 'ignored.env'), `KEY=${synthetic.jwt}\n`);
    mkdirSync(join(r.dir, 'node_modules'));
    writeFileSync(join(r.dir, 'node_modules', 'dep.js'), `module.exports = "${synthetic.jwt}";\n`);
    r.git('add', 'tracked.ts', '.gitignore');
    const files = scanWorkingTree(r.dir).map((f: { file: string }) => f.file).sort();
    assert.deepEqual(files, ['tracked.ts', 'untracked.ts']);
  } finally { r.cleanup(); }
});

test('history scan finds a credential that was committed and later deleted, and keeps known historic exposures apart', () => {
  const r = tempRepo();
  try {
    writeFileSync(join(r.dir, 'config.ts'), `export const k = "${synthetic['stripe-live-key']}";\n`);
    r.git('add', '.'); r.git('commit', '-q', '-m', 'add');
    writeFileSync(join(r.dir, 'config.ts'), 'export const k = process.env.K;\n');
    r.git('commit', '-q', '-am', 'remove');
    assert.equal(scanWorkingTree(r.dir).length, 0, 'the working tree is clean');
    const hist = scanHistory(r.dir);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].rule, 'stripe-live-key');
    assert.equal(hist[0].known, null, 'an unknown historic exposure is a NEW finding');
    assert.ok(!JSON.stringify(hist).includes(synthetic['stripe-live-key']));
  } finally { r.cleanup(); }
});

test('this repository: working tree is clean, and the history scan recognises the known .env exposure without printing it', () => {
  const out = execFileSync(process.execPath, ['scripts/scan-secrets.mjs', '--history'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /working tree: 0 finding\(s\)/);
  assert.match(out, /history: 0 new finding\(s\), \d+ known historic exposure line\(s\)/);
  assert.match(out, /rotate and retire these credentials/);
  const known = Number(out.match(/(\d+) known historic exposure/)![1]);
  assert.ok(known >= 3, 'the scanner should see the historic .env exposure');
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.eyJ/.test(out), 'the scanner output contains a token');
});

// ---- corrective slice: no silent misses ---------------------------------------------------------------------------

test('long lines are scanned: a credential after 5,000 and 50,000 characters, and one straddling a window edge, is found', () => {
  const secret = synthetic['supabase-secret-key'];
  for (const pad of [4001, 5000, 50_000, 3_000_000]) {
    const line = `${'x '.repeat(pad / 2)}"${secret}"`;
    const f = scanText(line + '\n', 'dist/bundle.js');
    assert.equal(f.length, 1, `pad ${pad}`);
    assert.equal(f[0].line, 1);
  }
  // straddling every window boundary offset near the edge (window 60000, step 30000)
  for (const offset of [29900, 29990, 30000, 59990, 60000, 89990, 90000]) {
    const line = `${'a'.repeat(offset)}"${secret}"`.replace(/a(?="sb_)/, ' '); // keep the key delimited
    assert.equal(scanText(line + '\n', 'x.js').filter((f: { rule: string }) => f.rule === 'supabase-secret-key').length, 1, `offset ${offset}`);
  }
  // a JWT far longer than a typical one, placed across an edge, is still seen exactly once
  const bigJwt = ['eyJ' + 'a'.repeat(1500), 'eyJ' + 'b'.repeat(1500), 'c'.repeat(300)].join('.');
  for (const pad of [5000, 29000, 58000, 59900]) assert.equal(scanText(`${' '.repeat(pad)}${bigJwt}\n`, 'x.js').filter((f: { rule: string }) => f.rule === 'jwt').length, 1, `jwt pad ${pad}`);
});

test('scanning pathological long lines stays fast (no quadratic regex behaviour)', () => {
  for (const unit of ['a', 'secret', 'secret=', 'password_', 'a ']) {
    const t = Date.now();
    scanText(unit.repeat(Math.ceil(3_000_000 / unit.length)) + '\n', 'x.txt');
    assert.ok(Date.now() - t < 3000, `${JSON.stringify(unit)} took ${Date.now() - t}ms`);
  }
});

test('long lowercase credentials are findings; only whole-value placeholder forms are exempt', () => {
  const lower = 'qwertyuiopasdfghjklzxcvbnm';
  const random = 'k9x2mq7vl4'.repeat(3);
  const flagged = [`apiKey = "${lower}"`, `PASSWORD=${random}`, `secret: ${'abcdefghijklmnopqrstuvwxyz'}`,
    // prefixes that used to be exempt no longer exempt the rest of the value
    `token = "test-${random}"`, `API_KEY=fake_${random}`, `secret="dummy${random}"`, `password = "your${random}"`, `api_key=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx${random}`];
  for (const line of flagged) assert.equal(scanText(line + '\n', 'x.env').length, 1, line);
  const exempt = ['SERVICE_KEY=your-server-only-secret-key', 'API_KEY=changeme-changeme-changeme-changeme', 'password = "your_password_goes_here_please"', 'secret=xxxxxxxxxxxxxxxxxxxxxxxxx', 'api_key=********************************', 'JWT_SECRET=process.env.JWT_SECRET_VALUE_FOR_APP'];
  for (const line of exempt) assert.deepEqual(scanText(line + '\n', 'x.env'), [], line);
});

test('database URLs: a real-looking password is a finding even when it contains "password", "example" or "project"; documentation forms are not', () => {
  const url = (pw: string, host: string) => ['postgres', '://app:', pw, '@', host].join('');
  for (const bad of [url('mypassword9Zq81', 'db.internal-host.test:5432/app'), url('Zq81vN4kx-example', 'db.internal-host.test:5432/app'), url('Zq81vN4kx', 'project-db.internal-host.test:5432/app'), url('Zq81vN4kx', 'db.prod.internal-host.test/app')]) {
    assert.equal(scanText(bad + '\n', 'x.md').filter((f: { rule: string }) => f.rule === 'db-url-with-password').length, 1, bad.replace(/:[^:@]+@/, ':<pw>@'));
  }
  for (const ok of [url('[YOUR-PASSWORD]', 'db.xxxxxxxxxxxx.supabase.co:5432/postgres'), url('<password>', 'host.example.com/db'), url('your_password', 'db.example.invalid/x'), url('pw', 'localhost/x')]) {
    assert.deepEqual(scanText(ok + '\n', 'x.md'), [], ok.replace(/:[^:@]+@/, ':<pw>@'));
  }
});

test('working-tree scan has no silent skips: large files and NUL-containing files are scanned, the lockfile is scanned, unreadable files are reported', () => {
  const r = tempRepo();
  try {
    const secret = synthetic['github-token'];
    writeFileSync(join(r.dir, 'big.json'), `${'{"a":1},\n'.repeat(200_000)}{"k":"${secret}"}\n`); // ~1.8 MB
    writeFileSync(join(r.dir, 'utf16.txt'), Buffer.from(`\0${secret}\0`, 'latin1'));
    writeFileSync(join(r.dir, 'package-lock.json'), `{"x":"${synthetic['stripe-live-key']}"}\n`);
    writeFileSync(join(r.dir, 'locked.txt'), 'x\n');
    chmodSync(join(r.dir, 'locked.txt'), 0o000);
    const { findings, unscanned, skipped } = scanWorkingTreeDetailed(r.dir);
    const byFile = (n: string) => findings.filter((f: { file: string }) => f.file === n).length;
    assert.equal(byFile('big.json'), 1, 'a file over 1 MB must be scanned');
    assert.equal(byFile('utf16.txt'), 1, 'a file containing NUL bytes must be scanned');
    assert.equal(byFile('package-lock.json'), 1, 'the lockfile must be scanned');
    if (process.getuid?.() !== 0) assert.deepEqual(unscanned.map((u: { file: string }) => u.file), ['locked.txt'], 'an unreadable file is reported, not ignored');
    assert.equal(skipped['binary extension'], 0);
  } finally { try { chmodSync(join(r.dir, 'locked.txt'), 0o600); } catch { /* absent */ } r.cleanup(); }
});

test('the CLI exits nonzero when a file could not be scanned', () => {
  if (process.getuid?.() === 0) return; // root can read everything
  const r = tempRepo();
  try {
    mkdirSync(join(r.dir, 'scripts'));
    writeFileSync(join(r.dir, 'scripts/scan-secrets.mjs'), readFileSync(join(root, 'scripts/scan-secrets.mjs')));
    writeFileSync(join(r.dir, 'locked.txt'), 'x\n');
    chmodSync(join(r.dir, 'locked.txt'), 0o000);
    const res = spawnSync(process.execPath, ['scripts/scan-secrets.mjs'], { cwd: r.dir, encoding: 'utf8' });
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stdout, /UNSCANNED\s+locked\.txt/);
  } finally { try { chmodSync(join(r.dir, 'locked.txt'), 0o600); } catch { /* absent */ } r.cleanup(); }
});
