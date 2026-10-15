# Credential retirement: what the owner must retire and how it will be evidenced

**Scope.** `docs/security/gitleaks.md` records real credentials in git history that were baselined, not retired: "credential retirement is an owner task". This document lists the classes to retire and the evidence that will show it. **It never contains, copies, prints or tests an exposed value**, and nothing in the verification procedure uses one. Rotating or revoking is done by the owner in the provider's own console; I do not hold the access to do it and will not ask for it.

## 1. What was exposed (from the reviewed Gitleaks findings, without opening the values)

| Where (fingerprint from `.gitleaksignore`) | Rule | What it is, as far as the finding shows | Disposition recorded |
|---|---|---|---|
| `1307cd0…:.env:jwt:5` | JWT in a committed `.env` | a JSON Web Token in an environment file | real exposure |
| `c25e780…:.env:jwt:2` | JWT in a committed `.env` | a JSON Web Token in an environment file | real exposure |
| `c25e780…:.env:generic-api-key:3` | key assignment in a committed `.env` | a key-style assignment (provider not identified by the rule) | real exposure |
| `1307cd0…:SETUP_COMPLETE.md:jwt:104` | anon-role key in a planning doc | an `anon`-role JWT | public-by-design key, but project-identifying |
| `c25e780…:API_SPECIFICATION.md:generic-api-key:71`, `:102` | `"token"` in a sample response | 39 characters, JWT-shaped | documentation example; too short to be a signed token |

I have deliberately **not** decoded the committed tokens to learn their role or project. The classes below are therefore what the owner must establish by looking at their own provider consoles and at the committed `.env` file from the owner's side; each class that does not apply is recorded as "not applicable" with the reason.

## 2. Credential classes the owner must retire (or show are not applicable)

| # | Class | Why it matters | How the owner retires it |
|---|---|---|---|
| R1 | the Supabase **`service_role`** JWT (legacy secret key) of the project in the history, if one was in `.env` | bypasses row-level security and is full access to that project's data | rotate the project's JWT secret (which invalidates every legacy JWT key at once), or disable the legacy keys and switch to the new secret key; then confirm the old key is dead |
| R2 | the Supabase **`anon`** JWT (legacy publishable key) of the same project | public by design, but with the project URL it addresses that project; abuse is limited by RLS and rate limits | invalidated by the same JWT-secret rotation; or accepted as public with the reason recorded |
| R3 | the Supabase **JWT signing secret** itself (if the committed JWTs were signed with it and it is the legacy shared secret) | anyone holding it can mint any token for that project | rotation of the secret, or migration to asymmetric signing keys and revocation of the shared secret |
| R4 | the Postgres **database password** of that project, if present in any committed file | direct database login | reset the database password in the dashboard |
| R5 | the **third-party key** behind the `generic-api-key` finding (provider unknown from the finding) | whatever that provider key permits | identify it from the file as the owner sees it, then revoke it at the provider and create a new one if still needed |
| R6 | any **other value in the committed `.env`** at those two commits (for example OAuth client secrets, SMTP passwords, webhook secrets) | same | enumerate the keys of that file from the owner's own copy and retire each one |
| R7 | the **local, untracked `.env`** in the working directory (it exists on the development machine and is not committed) | may hold current credentials; not part of the history exposure, but it must not be reused for staging | confirm it holds nothing that staging will use; staging uses newly created credentials only |
| R8 | the **old Supabase project** as a whole | the strongest retirement is to delete the project, or to confirm it holds no data of value and keep it locked down | owner decision: delete, or retain with all of R1 to R4 done |

**Also record, because it affects the risk, not the retirement:** the two commits that hold these values are ancestors of `origin/main`, so they are already on GitHub's servers; whether the repository is public is not recorded locally (OWNER confirms). Anything that was ever readable (clones, forks, caches, search indexes, CI logs) cannot be recalled. **Rewriting git history does not retire a credential** and does not remove copies already fetched; it is optional hygiene after retirement, not a substitute.

## 3. How retirement will be evidenced (no value ever shown)

Provider-side records are preferred over replaying an old key, because replaying uses the exposed value.

| Credential class | Evidence the owner provides (redacted) |
|---|---|
| R1 to R3 | screenshot or text of the dashboard section showing the legacy API keys **disabled** or the JWT secret **rotation timestamp**, plus the key "created at" or key ID of the **new** keys, with the old key itself never visible |
| R4 | the dashboard's password-reset timestamp (or audit-log entry) |
| R5, R6 | the provider's key list showing the old key revoked or deleted (key name/ID and date only) |
| R7 | the owner's statement that it was reviewed and what class of content it holds (no values) |
| R8 | the deletion confirmation, or the owner's retain-and-secure decision with R1 to R4 evidence |
| optional replay | **the owner**, not me, may run one request with the old public key against the old project and report **only the HTTP status** (expected 401 or an "invalid API key" class of refusal). I will not run or look at it. A 200 means retirement failed |
| exposure window | the owner checks the old project's Auth and API logs (as far as retention allows) for requests outside expected sources between the first commit date and the retirement date, and records "reviewed, nothing unexpected" or the findings |

## 4. What is not evidence

* **A clean secret scan is not proof of retirement.** `npm run scan:gitleaks` and `npm run scan:secrets` only show that no *new* secret was committed; the old findings remain in history and are suppressed by `.gitleaksignore` on purpose.
* A successful CI run, a rewritten history, or the absence of the value from the working tree.
* My inability to authenticate with a value (I never try).

## 5. Gate

* Retirement (R1 to R8, each retired or recorded "not applicable" with a reason) should be **evidenced before the first push to a shared remote and in any case before public release**. Because the values are already on the remote, the practical order is: owner retires, owner supplies the redacted evidence, then the first hosted action is authorized.
* The staging run uses only **newly created** credentials (O1 to O4 in the staging plan) and a denylist (`FORBIDDEN_PROJECT_REFS`) so a mistake cannot point the verification at the old project.
* When evidence is accepted, `docs/security/gitleaks.md` and the closeout matrix row "Legacy credential retirement" are updated in a separate commit; until then the status is "implementation missing (owner action)".
