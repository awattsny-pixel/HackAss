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
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, note: 'JSON Web Token (may be a service-role or session token)' },
  { id: 'supabase-secret-key', re: /\bsb_secret_[A-Za-z0-9_-]{16,}/g, note: 'Supabase secret API key' },
  { id: 'db-url-with-password', re: /\bpostgres(?:ql)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]{3,}@[^\s'"`]+/g, note: 'database URL with embedded password' },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, note: 'AWS access key id' },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, note: 'private key material' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, note: 'GitHub token' },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, note: 'Slack token' },
  { id: 'stripe-live-key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}/g, note: 'Stripe live key' },
  { id: 'credential-assignment', re: /\b[A-Za-z0-9_]*(?:secret|password|passwd|service[_-]?(?:role|key)|api[_-]?key|private[_-]?key)[A-Za-z0-9_]*\s*[:=]\s*['"]?([A-Za-z0-9_\-/+=.]{24,})/gi, group: 1, note: 'credential-looking assignment' },
];

// Values that are plainly placeholders, fixtures or variable references rather than secrets.
const PLACEHOLDER = /^(?:your[-_]|dummy|example|changeme|change[-_]me|placeholder|xxx|<|\$\{|process\.env|todo|redacted|fake|test[-_])|[-_]placeholder|\.{3}|^[A-Za-z0-9_]*$(?<=^[a-z_]+$)/i;
const SAFE_DB_HOSTS = /@(?:localhost|127\.0\.0\.1|\[::1\]|db\.example|example\.(?:com|invalid)|host\b|\$\{)/i;

/** Known exposures already in history. They are reported as "known" (rotate the keys), never as new findings. */
export const KNOWN_EXPOSED_HISTORY = [
  { commit: /^1307cd0/, file: 'SETUP_COMPLETE.md', why: 'an anon-role Supabase key (public by design, but project-identifying) in a planning doc; part of legacy key retirement' },
  { commit: /^c25e780/, file: '.env', why: 'privileged keys committed in the initial commit (credential retirement is an owner task)' },
  { commit: /^1307cd0/, file: '.env', why: 'privileged keys committed again in the Vercel deploy commit' },
];

const fingerprint = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const isPlaceholder = (v) => PLACEHOLDER.test(v) || /^(?:[A-Za-z]+[-_]){2,}[A-Za-z]+$/.test(v) && v.length < 40;

/** Documentation-style URLs: bracketed/obvious placeholder password, or a placeholder host. */
function isPlaceholderDbUrl(url) {
  let password = '';
  try { password = decodeURIComponent(url.replace(/^postgres(?:ql)?:\/\/[^:]+:/, '').replace(/@[^@]*$/, '')); } catch { return true; }
  const host = url.split('@').slice(1).join('@');
  return /your|password|placeholder|changeme|example|xxx|\[.*\]/i.test(password) || /xxxx|your|project|\[|example/i.test(host);
}

export function scanText(text, file, allow = []) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.length > 4000) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (let m; (m = rule.re.exec(line)); ) {
        const value = rule.group ? m[rule.group] : m[0];
        if (rule.id === 'credential-assignment' && isPlaceholder(value)) continue;
        if (rule.id === 'db-url-with-password' && (SAFE_DB_HOSTS.test(m[0]) || isPlaceholderDbUrl(m[0]))) continue;
        const fp = fingerprint(value);
        if (allow.some((a) => a.rule === rule.id && a.file === file && (a.fingerprint === undefined || a.fingerprint === fp))) continue;
        findings.push({ rule: rule.id, file, line: i + 1, fingerprint: fp, note: rule.note });
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
      }
    }
  });
  return findings;
}

const SKIP_PATH = /(^|\/)(node_modules|\.next|\.git)\//;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|pptx|docx|xlsx|woff2?|ttf|eot|zip|gz|mp4|mov)$/i;

function git(args, cwd, maxBuffer = 256 * 1024 * 1024) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer });
}

export function scanWorkingTree(root, allow = []) {
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root).split('\0').filter(Boolean);
  const findings = [];
  for (const f of files) {
    if (SKIP_PATH.test(f) || BINARY_EXT.test(f) || f === 'package-lock.json') continue;
    const abs = path.join(root, f);
    if (!existsSync(abs)) continue;
    let buf;
    try { buf = readFileSync(abs); } catch { continue; }
    if (buf.length > 1_000_000 || buf.includes(0)) continue;
    findings.push(...scanText(buf.toString('utf8'), f, allow));
  }
  return findings;
}

export function scanHistory(root, allow = []) {
  const out = git(['log', '--all', '-p', '--no-color', '--unified=0', '--format=@@COMMIT %H'], root);
  const findings = [];
  let commit = '', file = '';
  for (const raw of out.split('\n')) {
    if (raw.startsWith('@@COMMIT ')) { commit = raw.slice(9); continue; }
    if (raw.startsWith('+++ b/')) { file = raw.slice(6); continue; }
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    if (BINARY_EXT.test(file) || file === 'package-lock.json') continue;
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
  const wt = scanWorkingTree(root, allow);
  console.log(`working tree: ${wt.length} finding(s)`);
  wt.forEach(print);
  let bad = wt.length;
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
