#!/usr/bin/env node
// Installs the pinned Supabase CLI into .tools/supabase/<version>/ (git-ignored), with the same rules as the Gitleaks
// installer: SHA-256 checked against scripts/supabase-cli-pin.json BEFORE extraction, only the `supabase` binary is
// extracted, and it must report exactly the pinned version.   Exit 0 installed/present, 1 failure, 2 unsupported platform.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnsupportedPlatform, sha256 } from './install-gitleaks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const loadPin = (file = path.join(root, 'scripts/supabase-cli-pin.json')) => JSON.parse(readFileSync(file, 'utf8'));
export const binaryPath = (pin, base = root) => path.join(base, '.tools', 'supabase', pin.version, 'supabase');
export function assetFor(pin, platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const asset = pin.assets[key];
  if (!asset) throw new UnsupportedPlatform(`no pinned Supabase CLI asset for ${key}; supported: ${Object.keys(pin.assets).join(', ')}`);
  return { key, ...asset };
}
const defaultFetch = async (url) => {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
const defaultExtract = (archive, dir) => execFileSync('tar', ['-xzf', archive, '-C', dir, 'supabase'], { stdio: 'pipe' });
const defaultVersion = (bin) => execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();

export async function installSupabaseCli({ pin = loadPin(), base = root, platform = process.platform, arch = process.arch, fetchBuffer = defaultFetch, extract = defaultExtract, versionOf = defaultVersion } = {}) {
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
  installSupabaseCli().then(({ bin, downloaded }) => { console.log(`${downloaded ? 'installed' : 'already installed'}: ${path.relative(root, bin)}`); }, (e) => {
    console.error(`${e instanceof UnsupportedPlatform ? 'BLOCKED' : 'FAIL'}  ${e.message}`);
    process.exit(e instanceof UnsupportedPlatform ? 2 : 1);
  });
}
