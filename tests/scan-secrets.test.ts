// The secret scanner (scripts/scan-secrets.mjs). Every synthetic credential is assembled at run time so that this
// file itself contains nothing the scanner would flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scanner = await import(pathToFileURL(join(root, 'scripts/scan-secrets.mjs')).href);
const { scanText, scanWorkingTree, scanHistory, RULES } = scanner;

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
    'const secret = "${SECRET_VALUE_FROM_ENV_VARIABLES}";', 'CURSOR_SIGNING_SECRET=changeme-changeme-changeme-123', 'token = "<paste your token here please>"',
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
  assert.ok(entries.length <= 3, 'keep the allowlist small');
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
