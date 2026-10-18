#!/usr/bin/env node
// Runs the pinned Gitleaks binary over (1) the working tree and (2) the full git history.
//
//   npm run scan:gitleaks
//
// Tree scan: Gitleaks' `dir` mode does not honour .gitignore, so the files git would track (tracked + untracked but not
// ignored) are copied to a temporary directory and scanned there. This keeps local `.env`/`.next` content out of scope
// and makes a local run equal to a clean CI checkout.
// History scan: `gitleaks git` over every commit on every ref.
// Both use .gitleaks.toml and the reviewed fingerprint list (.gitleaksignore; inline `gitleaks:allow` comments are NOT honoured), redact all secrets, and write their JSON reports to a temporary
// directory OUTSIDE the repository, which is removed afterwards. Only rule, file, commit and line are printed.
//
// Exit codes: 0 clean · 1 findings · 2 BLOCKED (binary missing or not the pinned version) · 3 Gitleaks itself failed ·
// 8 cleanup failed (outranks the others).
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryPath, loadPin } from './install-gitleaks.mjs';

export const EXIT = { OK: 0, FINDINGS: 1, BLOCKED: 2, TOOL_FAILED: 3, CLEANUP_FAILED: 8 };
const FINDINGS_EXIT = 10; // Gitleaks' own exit code for "leaks found", distinct from its generic error code 1
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const defaultExec = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, ...opts });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? (r.error.code ?? String(r.error.message)) : null };
};

export function resolveBinary({ env = process.env, pin = loadPin(), base = root, exec = defaultExec, exists = existsSync } = {}) {
  const candidates = [env.GITLEAKS_BIN, binaryPath(pin, base), 'gitleaks'].filter(Boolean);
  const seen = [];
  for (const bin of candidates) {
    if (bin !== 'gitleaks' && !exists(bin)) continue;
    const r = exec(bin, ['version'], {});
    const version = r.status === 0 ? r.stdout.trim() : null;
    if (version === pin.version) return { bin };
    if (version) seen.push(`${bin} is ${version}`);
  }
  return { blocked: `Gitleaks ${pin.version} (pinned) was not found${seen.length ? ` (${seen.join('; ')})` : ''}. Run \`node scripts/install-gitleaks.mjs\`.` };
}

/** Copies exactly the files git would track into `dest`, keeping relative paths. */
function stageTree(rootDir, dest) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: rootDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
  for (const f of files) {
    const src = path.join(rootDir, f);
    if (!existsSync(src)) continue;
    mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    cpSync(src, path.join(dest, f));
  }
}

const describe = (f) => `  ${f.RuleID}  ${f.File}${f.StartLine ? ':' + f.StartLine : ''}${f.Commit ? ' @' + String(f.Commit).slice(0, 7) : ''}`;

export function runGitleaks({ rootDir = root, exec = defaultExec, env = process.env, pin = loadPin(), log = { info: console.log, error: console.error }, resolve = resolveBinary } = {}) {
  const resolved = resolve({ env, pin, base: rootDir, exec });
  if (resolved.blocked) { log.error(`BLOCKED  ${resolved.blocked}`); return EXIT.BLOCKED; }
  const tmp = mkdtempSync(path.join(tmpdir(), 'hackass-gitleaks-'));
  let result = EXIT.OK;
  try {
    const common = ['--config', path.join(rootDir, '.gitleaks.toml'), '--gitleaks-ignore-path', path.join(rootDir, '.gitleaksignore'), '--ignore-gitleaks-allow', '--redact', '--no-banner', '--no-color', '--exit-code', String(FINDINGS_EXIT), '-f', 'json'];
    const stage = path.join(tmp, 'tree');
    mkdirSync(stage);
    stageTree(rootDir, stage);
    const scans = [
      { name: 'working tree', args: ['dir', '.', ...common, '-r', path.join(tmp, 'tree.json')], cwd: stage, report: path.join(tmp, 'tree.json') },
      { name: 'git history', args: ['git', '.', ...common, '-r', path.join(tmp, 'history.json')], cwd: rootDir, report: path.join(tmp, 'history.json') },
    ];
    for (const s of scans) {
      const r = exec(resolved.bin, s.args, { cwd: s.cwd });
      if (r.status !== 0 && r.status !== FINDINGS_EXIT) { log.error(`FAIL  gitleaks ${s.name} scan did not complete (exit ${r.status ?? r.error})`); result = result || EXIT.TOOL_FAILED; continue; }
      let findings = [];
      try { findings = existsSync(s.report) ? JSON.parse(readFileSync(s.report, 'utf8')) : []; if (!Array.isArray(findings)) throw new Error('not an array'); } catch { log.error(`FAIL  gitleaks ${s.name} report unreadable`); result = result || EXIT.TOOL_FAILED; continue; }
      if (r.status === FINDINGS_EXIT && findings.length === 0) { log.error(`FAIL  gitleaks ${s.name}: leaks reported but no report entries`); result = result || EXIT.TOOL_FAILED; continue; }
      log.info(`gitleaks ${s.name}: ${findings.length} new finding(s) (version ${pin.version}, reviewed fingerprints applied)`);
      for (const f of findings) log.info(describe(f));
      if (findings.length) result = EXIT.FINDINGS;
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { log.error(`FAIL  cleanup failed: ${e.message}`); result = EXIT.CLEANUP_FAILED; }
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = runGitleaks();
