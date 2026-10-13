# Proposal — Gitleaks CLI integration (UNVERIFIED, for CTO review)

Status: **proposal only. Nothing in this document has been run.** The agreed requirement is Gitleaks in CI. F1 ships the
in-repo scanner (`scripts/scan-secrets.mjs`) as a *supplementary* check; it does not satisfy that requirement and is not
presented as doing so.

## Why it is not integrated yet
A "verified, pinned" integration needs (a) the release binary, (b) its published SHA-256 from the release checksums file,
and (c) a run of the binary against this repository's tree and history. This environment has no Gitleaks binary, no Docker,
and downloading a release artifact needs explicit approval. Committing a version or hash I could not check would be an
unverified pin, which is exactly what the requirement rules out.

## Proposed integration
1. **Install without a third-party action.** A CI step downloads
   `https://github.com/gitleaks/gitleaks/releases/download/v<VERSION>/gitleaks_<VERSION>_linux_x64.tar.gz` with `curl -fsSL`,
   checks it with `sha256sum -c scripts/gitleaks.sha256` (the digest committed in the repository, copied from that release's
   own `checksums.txt` and re-checked against the release page), then extracts the single `gitleaks` binary. Version and
   digest change only by reviewed commit. (`gitleaks/gitleaks-action` is avoided: it needs a licence key for organisation
   repositories and is another moving dependency.)
2. **Two scans**, both failing the job on any finding and both with `--redact` so no value reaches the log:
   - tree: `gitleaks dir . --redact --no-banner --exit-code 1 --config .gitleaks.toml`
   - history: `gitleaks git . --redact --no-banner --exit-code 1 --config .gitleaks.toml --baseline-path .gitleaks-baseline.json`
   (Subcommand names to be confirmed against the pinned binary's `--help`; older 8.x used `detect`.)
3. **`.gitleaks.toml`** extends the default ruleset and carries allowlists that mirror `.secret-scan-allow.json`, each with a
   written reason and pinned to path plus fingerprint/commit, never a blanket regex.
4. **`.gitleaks-baseline.json`** records the *known historic exposures* (commits `c25e780`, `1307cd0`: the old `.env` files and
   one anon key in `SETUP_COMPLETE.md`) so history scans fail only on NEW findings. The baseline is generated once with
   `--redact`, reviewed for the absence of values, and committed. The underlying credentials still need retiring; a baseline
   hides nothing from git history.
5. **Local wrapper** `npm run scan:gitleaks` that exits 2 (BLOCKED, not "passed") when the binary is missing, like `db:test`.
6. CI order: Gitleaks first, then the in-repo scanner (which stays because it also checks placeholder hygiene and prints
   fingerprints only), then lint.

## What I need to finish it (one approval)
Permission to download, into the session scratch directory only, the Gitleaks Linux/amd64 and macOS/arm64 release tarballs
and `checksums.txt` for one chosen release (a few MB, from github.com/gitleaks/gitleaks releases). With that I would:
verify digests, run both scans on the tree and history, produce and review the baseline, plant a synthetic secret to prove
the scan fails, run the CI install step's commands locally, and commit the pinned digest. Until then CI keeps only the
supplementary scanner.

## Alternative if downloads stay unavailable
Pin the official container image by digest (`ghcr.io/zricethezav/gitleaks@sha256:…`) and run it in CI. That trades a binary
checksum for an image digest; it needs the same one-time verification step.
