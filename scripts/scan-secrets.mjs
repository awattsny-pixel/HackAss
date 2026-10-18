#!/usr/bin/env node
// Repository secret scanner. High-signal patterns only, no network, no external binary.
//
//   node scripts/scan-secrets.mjs              scan tracked files plus untracked-but-not-ignored files
//   node scripts/scan-secrets.mjs --history    also scan every commit's added lines (known historic exposures are
//                                              reported separately from new ones; see KNOWN_EXPOSED_HISTORY below)
//
// A finding prints the rule, file, line and a short sha-256 fingerprint of the match. The matched text itself is
// NEVER printed. Exit code 1 if any non-allowlisted finding exists.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const RULES = [
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,4000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,4000}/g, note: 'JSON Web Token (may be a service-role or session token)' },
  { id: 'supabase-secret-key', re: /\bsb_secret_[A-Za-z0-9_-]{16,}/g, note: 'Supabase secret API key' },
  { id: 'db-url-with-password', re: /\bpostgres(?:ql)?:\/\/[^\s:@/'"`]{1,200}:[^\s@/'"`]{3,200}@[^\s'"`]{1,300}/g, note: 'database URL with embedded password' },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, note: 'AWS access key id' },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, note: 'private key material' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, note: 'GitHub token' },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, note: 'Slack token' },
  { id: 'stripe-live-key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}/g, note: 'Stripe live key' },
  { id: 'credential-assignment', re: /(?:secret|password|passwd|token|service[_-]?(?:role|key)|api[_-]?key|private[_-]?key)[A-Za-z0-9_]{0,60}\s*[:=]\s*['"]?([A-Za-z0-9_\-/+=.]{24,})/gi, group: 1, note: 'credential-looking assignment' },
];

// Placeholder detection is deliberately narrow: a value is a placeholder only if the WHOLE value is one of these
// forms. Nothing is exempt because of its case, length or a prefix, so a long lowercase credential is still a finding.
const PLACEHOLDER_WORDS = new Set([
  'your', 'my', 'the', 'a', 'an', 'api', 'key', 'secret', 'token', 'password', 'pass', 'passwd', 'here', 'value', 'example', 'placeholder',
  'changeme', 'change', 'me', 'dummy', 'fake', 'test', 'sample', 'replace', 'with', 'insert', 'todo', 'redacted', 'service', 'role', 'anon',
  'supabase', 'project', 'url', 'server', 'only', 'private', 'public', 'xxx', 'xxxx', 'env', 'from', 'goes', 'please', 'real', 'actual', 'paste', 'enter', 'secure',
]);
const PLACEHOLDER_FORMS = [
  /^<[^<>\s][^<>]*>$/,                 // <SUPABASE_ANON_KEY>, <paste your token here>
  /^\$\{[A-Za-z_][A-Za-z0-9_ ]*\}$/,   // ${SECRET_FROM_ENV}
  /^\$[A-Z_][A-Z0-9_]*$/,               // $SECRET_FROM_ENV
  /^process\.env\.[A-Za-z_][A-Za-z0-9_]*$/, // process.env.NAME
  /^[xX*.\-_#]{8,}$/,                   // xxxxxxxx, ********, ........
];
const isPlaceholder = (v) => {
  if (PLACEHOLDER_FORMS.some((re) => re.test(v))) return true;
  const tokens = v.split(/[-_.\s]+/).filter(Boolean);
  // words from the placeholder vocabulary only (your-server-only-secret-key, changeme-changeme-changeme): no digits, no random-looking token
  return tokens.length > 0 && tokens.every((t) => PLACEHOLDER_WORDS.has(t.toLowerCase()));
};
const SAFE_DB_HOSTS = /@(?:localhost|127\.0\.0\.1|\[::1\]|db\.example|example\.(?:com|invalid)|host\b|\$\{)/i;

/** Documentation-style URLs: bracketed/obvious placeholder password, or a placeholder host. */
function isPlaceholderDbUrl(url) {
  let password = '';
  try { password = decodeURIComponent(url.replace(/^postgres(?:ql)?:\/\/[^:]+:/, '').replace(/@[^@]*$/, '')); } catch { return false; }
  const host = url.split('@').slice(1).join('@');
  const placeholderPassword = /^\[[^\]]+\]$/.test(password) || /^<[^>]+>$/.test(password) || isPlaceholder(password);
  const placeholderHost = /^(?:db\.)?(?:x{4,}|your[-_]project[-_a-z]*|project[-_]ref|\[[^\]]+\])\./i.test(host) || /^[^/]*\.example\.(?:com|invalid|test)\b/i.test(host);
  return placeholderPassword || placeholderHost;
}

/** Known exposures already in history. They are reported as "known" (rotate the keys), never as new findings. */
export const KNOWN_EXPOSED_HISTORY = [
  { commit: /^1307cd0/, file: 'SETUP_COMPLETE.md', why: 'an anon-role Supabase key (public by design, but project-identifying) in a planning doc; part of legacy key retirement' },
  { commit: /^c25e780/, file: '.env', why: 'privileged keys committed in the initial commit (credential retirement is an owner task)' },
  { commit: /^1307cd0/, file: '.env', why: 'privileged keys committed again in the Vercel deploy commit' },
];

const fingerprint = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);

// Lines are never skipped. A very long line (minified bundles, one-line JSON) is scanned in overlapping windows so the
// regexes stay linear and a credential straddling a window edge is still seen (the overlap exceeds the longest match any rule can produce, so every match lies whole inside some window).
const WINDOW = 60_000, STEP = 30_000;

export function scanText(text, file, allow = []) {
  const findings = [];
  const seen = new Set();
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (let from = 0; ; from += STEP) {
      const chunk = line.length <= WINDOW ? line : line.slice(from, from + WINDOW);
      scanLine(chunk, i + 1);
      if (line.length <= WINDOW || from + WINDOW >= line.length) break;
    }
  });
  return findings;

  function scanLine(line, lineNo) {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (let m; (m = rule.re.exec(line)); ) {
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
        const value = rule.group ? m[rule.group] : m[0];
        if (rule.id === 'credential-assignment' && isPlaceholder(value)) continue;
        if (rule.id === 'db-url-with-password' && (SAFE_DB_HOSTS.test(m[0]) || isPlaceholderDbUrl(m[0]))) continue;
        const fp = fingerprint(value);
        if (allow.some((a) => a.rule === rule.id && a.file === file && (a.fingerprint === undefined || a.fingerprint === fp))) continue;
        const key = `${rule.id}:${lineNo}:${fp}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ rule: rule.id, file, line: lineNo, fingerprint: fp, note: rule.note });
      }
    }
  }
}

const SKIP_PATH = /(^|\/)(node_modules|\.next|\.git)\//;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|pptx|docx|xlsx|woff2?|ttf|eot|zip|gz|mp4|mov)$/i;

function git(args, cwd, maxBuffer = 256 * 1024 * 1024) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer });
}

const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Scans tracked and untracked-but-not-ignored files. Returns { findings, skipped, unscanned }:
 *   skipped   files excluded by design (dependency/build directories, binary extensions), with counts only
 *   unscanned files that SHOULD have been scanned but could not be (unreadable, over MAX_FILE_BYTES); the CLI treats
 *             any of these as a failure, so nothing is silently missed.
 * Files containing NUL bytes (e.g. UTF-16 text) are scanned as latin1, not skipped.
 */
export function scanWorkingTreeDetailed(root, allow = []) {
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root).split('\0').filter(Boolean);
  const findings = [], unscanned = [];
  const skipped = { 'dependency/build directory': 0, 'binary extension': 0 };
  for (const f of files) {
    if (SKIP_PATH.test(f)) { skipped['dependency/build directory']++; continue; }
    if (BINARY_EXT.test(f)) { skipped['binary extension']++; continue; }
    const abs = path.join(root, f);
    if (!existsSync(abs)) continue; // deleted but still indexed: nothing on disk to scan
    let buf;
    try { buf = readFileSync(abs); } catch (e) { unscanned.push({ file: f, why: `unreadable (${e.code ?? 'error'})` }); continue; }
    if (buf.length > MAX_FILE_BYTES) { unscanned.push({ file: f, why: `larger than ${MAX_FILE_BYTES} bytes` }); continue; }
    findings.push(...scanText(buf.toString(buf.includes(0) ? 'latin1' : 'utf8'), f, allow));
  }
  return { findings, skipped, unscanned };
}
export const scanWorkingTree = (root, allow = []) => scanWorkingTreeDetailed(root, allow).findings;

export function scanHistory(root, allow = []) {
  const out = git(['log', '--all', '-p', '--no-color', '--unified=0', '--format=@@COMMIT %H'], root);
  const findings = [];
  let commit = '', file = '';
  for (const raw of out.split('\n')) {
    if (raw.startsWith('@@COMMIT ')) { commit = raw.slice(9); continue; }
    if (raw.startsWith('+++ b/')) { file = raw.slice(6); continue; }
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    if (BINARY_EXT.test(file)) continue;
    for (const f of scanText(raw.slice(1), file, allow)) {
      const known = KNOWN_EXPOSED_HISTORY.find((k) => k.commit.test(commit) && k.file === file);
      findings.push({ ...f, commit: commit.slice(0, 7), line: undefined, known: known ? known.why : null });
    }
  }
  return findings;
}

function loadAllow(root) {
  const p = path.join(root, '.secret-scan-allow.json');
  if (!existsSync(p)) return [];
  const list = JSON.parse(readFileSync(p, 'utf8'));
  for (const a of list) if (!a.rule || !a.file || !a.reason) throw new Error('every allowlist entry needs rule, file and reason');
  return list;
}

const print = (f) => console.log(`  ${f.rule}  ${f.file}${f.line ? ':' + f.line : ''}${f.commit ? ' @' + f.commit : ''}  fp=${f.fingerprint}  (${f.note})${f.known ? '  [KNOWN: ' + f.known + ']' : ''}`);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const allow = loadAllow(root);
  const { findings: wt, skipped, unscanned } = scanWorkingTreeDetailed(root, allow);
  console.log(`working tree: ${wt.length} finding(s)`);
  wt.forEach(print);
  console.log(`  excluded by design: ${Object.entries(skipped).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  for (const u of unscanned) console.log(`  UNSCANNED  ${u.file}  (${u.why})`);
  let bad = wt.length + unscanned.length;
  if (process.argv.includes('--history')) {
    const h = scanHistory(root, allow);
    const fresh = h.filter((f) => !f.known), known = h.filter((f) => f.known);
    console.log(`history: ${fresh.length} new finding(s), ${known.length} known historic exposure line(s)`);
    fresh.forEach(print);
    if (known.length) console.log(`  known historic exposures (commits ${[...new Set(known.map((k) => k.commit))].join(', ')}): rotate and retire these credentials; they remain readable in git history`);
    bad += fresh.length;
  }
  process.exit(bad ? 1 : 0);
}
