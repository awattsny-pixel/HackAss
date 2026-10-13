# Gitleaks integration

Pinned release **8.30.1** (official repository `gitleaks/gitleaks`). It is the primary secret scan. `scripts/scan-secrets.mjs`
stays as a supplementary check (it adds placeholder hygiene and fingerprint-only output) and does not replace Gitleaks.

## Pin and installation
- `scripts/gitleaks-pin.json` holds the version, the release URL and one SHA-256 per platform archive
  (`linux-x64` for CI, `darwin-x64` for the Intel developer Mac, `darwin-arm64` for Apple-silicon machines).
- `node scripts/install-gitleaks.mjs` downloads the pinned archive, compares its SHA-256 with the pin **before extracting**,
  extracts only the `gitleaks` binary into `.tools/gitleaks/8.30.1/` (git-ignored), and requires the binary to report exactly
  `8.30.1`. A mismatch aborts and leaves nothing behind. CI uses the same script.
- How the digests were established: the release `checksums.txt` and the `linux-x64` and `darwin-x64` archives were downloaded
  from the release, hashed locally, and matched both `checksums.txt` and the digest the GitHub API reports for each asset. The
  `darwin-x64` binary was executed on the Intel development Mac (`uname -m` = x86_64). The `darwin-arm64` digest is copied
  from `checksums.txt` only and was never executed. The Linux binary was not executed in this environment; the CI run is its
  first execution.
- Upgrading means a reviewed commit that changes the pin, followed by a fresh digest check against the release.

## Running it
`npm run scan:gitleaks` (exit 0 clean, 1 findings, 2 BLOCKED when the pinned binary is missing, 3 Gitleaks failed, 8 cleanup
failed). Tree scan: Gitleaks' `dir` mode ignores `.gitignore`, so the wrapper copies exactly the files git would track
(tracked plus untracked-not-ignored) to a temporary directory and scans that; local `.env`/`.next` content is out of scope,
as in a clean CI checkout. History scan: every commit on every ref. Both use `--redact`, the repository's `.gitleaks.toml`, the
reviewed fingerprint list, and `--ignore-gitleaks-allow` (an inline `gitleaks:allow` comment cannot hide a finding). JSON
reports are written to a temporary directory outside the repository and removed afterwards; only rule, file, commit and line
are printed.

## Configuration and the reviewed findings
`.gitleaks.toml` extends the default ruleset and has **no** path, commit or regex allowlists. `.gitleaksignore` lists eight exact
fingerprints (a baseline file would have required committing author names and emails, so the native fingerprint list is used):

| Fingerprint | Finding | Disposition |
|---|---|---|
| `1307cd0…:.env:jwt:5` | JWT in a committed `.env` | real exposure, history; credential retirement is an owner task |
| `c25e780…:.env:jwt:2` | JWT in a committed `.env` | real exposure, history |
| `c25e780…:.env:generic-api-key:3` | key assignment in a committed `.env` | real exposure, history |
| `1307cd0…:SETUP_COMPLETE.md:jwt:104` | anon-role key in a planning doc | public-by-design key, project-identifying; history |
| `c25e780…:API_SPECIFICATION.md:generic-api-key:71` and `:102` | `"token"` in a sample API response | documentation example: 39 characters, JWT-shaped, too short to be a signed token; history |
| `API_SPECIFICATION.md:generic-api-key:71` and `:102` | the same two lines in today's tree | same example |

Review was done on redacted reports; values were never printed. A baselined real exposure is still a real exposure: ignoring
the fingerprint stops the CI noise, it does not remove the secret from git history.

Limit worth knowing: tree-mode fingerprints are `file:rule:line`, so a different secret placed on exactly
`API_SPECIFICATION.md` line 71 or 102 would be ignored by the *tree* scan; the *history* scan still reports it, because its
fingerprint includes the new commit.

## Results
See the review package for the recorded runs. `tests/gitleaks.test.ts` proves, with the real pinned binary: this repository is
clean in tree and history; a newly introduced synthetic secret fails both scans without being printed; a secret deleted from
the tree still fails the history scan; the reviewed list is exact (a new secret in a reviewed file name is still found) and
an inline `gitleaks:allow` hides nothing.
