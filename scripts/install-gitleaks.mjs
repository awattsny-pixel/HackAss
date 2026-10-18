#!/usr/bin/env node
// Installs the pinned Gitleaks release into .tools/gitleaks/<version>/ (git-ignored). The archive is downloaded from the
// pinned release URL, its SHA-256 is compared with scripts/gitleaks-pin.json BEFORE anything is extracted, and the
// installed binary must report exactly the pinned version. A digest mismatch aborts and leaves no binary behind.
//
//   node scripts/install-gitleaks.mjs        exit 0 installed/already present, 1 failure, 2 unsupported platform
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const loadPin = (file = path.join(root, 'scripts/gitleaks-pin.json')) => JSON.parse(readFileSync(file, 'utf8'));
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const binaryPath = (pin, base = root) => path.join(base, '.tools', 'gitleaks', pin.version, 'gitleaks');

export class UnsupportedPlatform extends Error {}
export function assetFor(pin, platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const asset = pin.assets[key];
  if (!asset) throw new UnsupportedPlatform(`no pinned Gitleaks asset for ${key}; supported: ${Object.keys(pin.assets).join(', ')}`);
  return { key, ...asset };
}

const defaultFetch = async (url) => {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
const defaultExtract = (archive, dir) => execFileSync('tar', ['-xzf', archive, '-C', dir, 'gitleaks'], { stdio: 'pipe' });
const defaultVersion = (bin) => execFileSync(bin, ['version'], { encoding: 'utf8', timeout: 20_000 }).trim();

/** Everything external is injectable so tests exercise the verification logic with doubles. */
export async function installGitleaks({ pin = loadPin(), base = root, platform = process.platform, arch = process.arch, fetchBuffer = defaultFetch, extract = defaultExtract, versionOf = defaultVersion } = {}) {
  const asset = assetFor(pin, platform, arch);
  const bin = binaryPath(pin, base);
  if (existsSync(bin)) { try { if (versionOf(bin) === pin.version) return { bin, downloaded: false }; } catch { /* reinstall below */ } }
  const dir = path.dirname(bin);
  const data = await fetchBuffer(`${pin.downloadBase}${asset.file}`);
  const got = sha256(data);
  if (got !== asset.sha256) throw new Error(`SHA-256 mismatch for ${asset.file}: expected ${asset.sha256}, got ${got}; nothing was installed`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, asset.file);
  try {
    writeFileSync(archive, data);
    extract(archive, dir);
    chmodSync(bin, 0o755);
    const v = versionOf(bin);
    if (v !== pin.version) throw new Error(`installed binary reports version ${JSON.stringify(v)}, pinned ${pin.version}`);
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  finally { rmSync(archive, { force: true }); }
  return { bin, downloaded: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  installGitleaks().then(({ bin, downloaded }) => { console.log(`${downloaded ? 'installed' : 'already installed'}: ${path.relative(root, bin)}`); }, (e) => {
    console.error(`${e instanceof UnsupportedPlatform ? 'BLOCKED' : 'FAIL'}  ${e.message}`);
    process.exit(e instanceof UnsupportedPlatform ? 2 : 1);
  });
}
