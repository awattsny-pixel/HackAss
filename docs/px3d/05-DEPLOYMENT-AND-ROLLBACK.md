# 05 · The exact proposed deployment and rollback procedure

**Proposal only. Nothing below has been run. Each numbered stage is performed only after the owner approves the one private-preview operation (README §4); steps marked ▲ reach outside this machine.** No secret value is ever typed into a command line, chat, repository or log; "operator file" means a `0600` file or a shell variable set by the operator.

## 1. Stage 0 · Local consolidation (no outside effect)
1. New local branch from `main` (`c423aa4`). Commit the slices in 01 §4 in order (C1 … C11), **merge-commit history only**: no squash, no rebase, no history rewrite; recorded SHAs (including `aee5287`) must survive.
2. Before each commit: `node scripts/scan-secrets.mjs` (0 findings), `npx tsc --noEmit`, lint, and the slice's own tests. `git checkout -- tsconfig.json` after any alternate-directory build.
3. Build both variants locally: gated (`APP_ENV=staging`, with `EDGE_LOCK_SECRET`) and open (`APP_ENV=local`); `node scripts/px3e-local-checks.mjs` passes.
4. **Stop** and report the branch SHA. The smoke-test item (04) must be closed before the CI result of Stage 1 is called final.

## 2. Stage 1 ▲ · CI on GitHub
Push only the reviewed branch SHA (the workflow's push filter is `main` and `mhost1-ci-first-run`; any other branch is verified by a **pull request**, whose `pull_request` trigger runs CI). Do not merge on a red run or on a smoke-test flake: the 04 acceptance applies. Merge by **merge commit** after the owner's approval.

## 3. Stage 2 · (removed)
The optional rehearsal on the disposable staging project is **removed**: every pilot tool deliberately refuses the staging project (and the historical staging records stay untouched), the same sequence is already rehearsed on the local pilot stack (`results/local-rollback-and-reapply-rehearsal.txt`), and it adds no evidence the pilot's own checks do not. The stage number is kept so that references to later stages stay valid.

## 4. Stage 3 ▲ · Owner provisioning (owner-side; I do not create accounts or pay)
| Item | Setting |
|---|---|
| Supabase | new project `hackass-pilot`, Pro, one region, **IPv4 add-on on only for the migration window**, `api` exposed after migration, Auth settings per 02 §4.1, custom SMTP per 02 §5 |
| Cloudflare | zone for the pilot domain; proxied `pilot.<domain>` record to the Render service; Access application with an Allow policy for named addresses; request-header rule adding `x-hackass-edge: <EDGE_LOCK_SECRET>`; SSL/TLS Full (strict) |
| Render | Hobby workspace, one web service (Starter), region near the database, **auto-deploy OFF**, health check path `/health`, custom domain, no disk |
| Resend | domain verified (SPF, DKIM, DMARC); SMTP credentials entered into Supabase only |
| Environment (Render; names only; values from the operator's file) | `APP_ENV=production`, `APP_ORIGIN=https://pilot.<domain>`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `CURSOR_SIGNING_SECRET`, `AUTH_THROTTLE_SECRET`, `AUTH_SETUP_MARKER_SECRET`, `EDGE_LOCK_SECRET` (**needed at build time**), `TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip`, `NODE_VERSION=22.23.3`. **Never set:** `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_URL`, `WORKER_DATABASE_URL`, `JOB_ENDPOINT_SECRET`, any database URL, `PREVIEW_GATE=off` |

## 5. Stage 4 ▲ · Pilot database (mutating; one project binding for every tool)
**One binding, enforced by code:** the migration, inventory and RPC tools each refuse to run unless the target is exactly one pilot project: the direct host `db.<ref>.supabase.co` (never a pooler), port 5432, login `postgres`, **database `postgres`** (`PGDATABASE` must be set), `sslmode=verify-full` with a root certificate, **no conflicting libpq overrides** (`PGSERVICE`, `PGSERVICEFILE`, `PGHOSTADDR`, `PGOPTIONS`, `PGSYSCONFDIR` must be unset), and never the disposable staging project (the project that holds the preserved historical records is not a pilot target). The API tool takes the same reference: `PILOT_API_URL` must be exactly `https://<ref>.supabase.co` and `--confirm-pilot <ref>` must equal it; this is checked **before** the secret key file is read or any request is sent.

The operator exports the libpq variables into the shell (never a command line or repository file): `PGHOST=db.<ref>.supabase.co`, `PGPORT=5432`, `PGUSER=postgres`, `PGDATABASE=postgres`, `PGSSLMODE=verify-full`, `PGSSLROOTCERT=<provider CA file>`, `PGPASSWORD` from the operator file.

**Order (each step must pass before the next):**
```bash
# 1. dry run, then apply, then the exact SQL inventory (database only; nothing about the API is needed yet)
node scripts/pilot-apply.mjs --libpq --expect-host db.<ref>.supabase.co
node scripts/pilot-apply.mjs --libpq --expect-host db.<ref>.supabase.co --apply --confirm-pilot <ref>
node scripts/pilot-inventory.mjs --libpq --expect-host db.<ref>.supabase.co
```
2. **Expose only `api`** in the project's API settings, then **read the setting back** and record it (03 P3/P5). The RPC checks go through the API and cannot be meaningful before this: do not run them earlier.
```bash
# 3. only after step 2 is verified; PILOT_API_URL=https://<ref>.supabase.co, key files 0600, values never printed
node scripts/pilot-rpc-checks.mjs --hosted --confirm-pilot <ref>
```
4. Switch the IPv4 add-on off.

**What the RPC checker guarantees:**
* **Deadlines at every call.** Each request is limited to the smaller of 15 s and the time left in the 5-minute run budget, and **is not sent once that budget is spent**; a call inside a running check cannot outlive the run. **Cleanup has a separate, documented allowance of 60 s in total** (each call still at most 15 s), used only after the run phase ends.
* **The first failed check stops the run** (later checks, which mutate, print SKIP and are never executed).
* **Fixtures are tracked before they exist.** Each intended fixture is written to a private record **before** the creating request is sent. If a creation's outcome is unknown (timeout, transport error, server error), cleanup looks the user up by the intended address and removes it if found; if it is not found that is **not** proof (the request may still land), so the fixture is reported **NOT ESTABLISHED CLEAN**. Only a definitive 4xx refusal proves nothing was created.
* **Cleanup is verified, never assumed.** A fixture counts as removed only when its deletion was followed by a confirmed not-found. Any fixture not established gone (a deletion error, a survivor, an unconfirmed removal, an unknown creation, an incomplete lookup) makes the run **exit 3, "CLEANUP INCOMPLETE"**, never "verified clean".
* **Where the identifier goes.** The public log shows only the fixture number, the state and counts. The addresses and ids are written **only to a private file** (0600, in a 0700 directory the checker creates under the operator's temporary directory, or `PILOT_RPC_RECORD_DIR`); its path is printed, its contents are not. The operator uses it to find and delete the fixtures, must not paste, upload or commit it, and deletes it once they are confirmed gone. When every fixture is established gone the checker removes the file itself.
* All 11 member functions need a **recorded successful owner call** (including `delete_my_prompt`) as well as the anonymous and service-role refusals.

Stop conditions: any refusal from the binding, a ledger that is not an exact prefix, an apply error (that file's transaction is rolled back; earlier files stay recorded), an inventory difference, a failing or skipped RPC check, exit 3 (until the fixtures named in the private record are removed no further run is made). Failures are fixed by a reviewed change, never by hand-editing the hosted database.

## 6. Stage 5 ▲ · Deployment with the maintenance gate
**Why the gate must be demonstrably effective.** A Cloudflare Access session already issued to a tester keeps working until its **session duration** ends or the token is revoked; **editing an Allow policy is not by itself proof that existing sessions stop** (the Cloudflare session-management documentation describes session lifetimes and explicit revocation). So the gate is not the policy alone:

1. **Gate = a host-scoped block rule that does not depend on Access state.** A Cloudflare WAF custom rule, prepared in advance and kept **disabled** (availability of custom rules and their count on the owner's Cloudflare plan is **unverified**: confirm it before purchase): *hostname equals `pilot.<domain>` → Block* (a static "maintenance" response is optional). Because it is evaluated for every request to that hostname, it stops new visitors **and** holders of an unexpired Access session. The Access policy is left as it is.
2. **Test it before it is relied on** (a hosted check, separately authorized; 03 M1–M3): with a second browser holding a live Access session for an allowed address and an open session in the application, enable the rule and confirm that the next request from that browser is blocked (page, `/work/**` call and `/auth/**` call), that `/health` from the operator's shell is **also** blocked at the edge (so health is read **directly at the origin with the lock header**, see 4 below), and that disabling the rule restores access without a new login. If the rule does not block an authenticated session, the procedure is **not used** and the owner is told; the fallback is revoking the Access tokens for the application (Zero Trust → user session revocation) **in addition**, recorded in the same check.
3. **Close first.** Enable the block rule. Record the time. Verify from a non-authenticated client and from the authenticated test client that both are blocked.
4. **Deploy.** Render: manual deploy of the exact commit SHA. Build: `npm ci && node scripts/check-env.mjs && npx next build`; a bad environment fails the build before traffic. Render starts the new instance, switches traffic when it is healthy, and sends the old instance its shutdown signal with a **60-second grace period**. A new `/health` boot identifier proves the **new** process is up; it does **not** prove the old one has drained. The operator therefore (a) reads `/health` directly at the origin with the lock header (`x-hackass-edge`), requiring `ready: true`, `gate: preview`, the lock built in and a new boot id, **and** (b) waits until the Render dashboard/events show the previous instance **stopped** (not draining), and in any case at least **90 seconds** after the new instance became live (the 60-second grace plus margin).
5. **Read-only verification while the gate is fully closed.** At the origin with the lock header the operator checks `/health` (above) and that a request **without** the header is a 404. No state-changing call is made at the origin address: those calls compare their `Origin` header with `APP_ORIGIN` (the pilot hostname) and a browser cannot add the lock header, so the journey is tested through the real hostname in step 6.
6. **Restore owner-only access first, then everyone**, and only after 4 and 5 hold (the old process stopped, the new one healthy). (a) Edit the prepared block rule to the **owner-only variant**: *hostname equals `pilot.<domain>` and source IP is not the owner's address → Block*; the owner's session now reaches the application through Access and the edge. (b) The owner runs the smoke journey through the real hostname (sign in, `/spark`, save, reopen). If it fails, switch the rule back to the full block and roll back (§8); no tester was exposed. (c) Only if it passes, **disable the rule** so the named testers regain access. Record the elapsed time; the throttle counters started empty (acknowledged, D3).
7. Repeat for every later deploy and operator-initiated restart. After an unplanned crash restart, check the `/health` boot id and review the period; no gate is possible after the fact.

## 7. Stage 6 ▲ · Hosted checks, internal preview, external gate
Run 03 in the order of its §8, **including the maintenance checks M1–M3 on the authenticated Access session**, which are performed under the separately authorized hosted checks and not before, with owner-controlled members; then the internal preview (owner, CTO); the **external-tester gate** (02 §10) is a separate approval.

## 8. Rollback
| Situation | Action | Who / time | Data effect |
|---|---|---|---|
| Bad deploy | redeploy the previous successful commit in Render (with the §6 maintenance gate) | operator, minutes | none |
| Immediate stop | the **host-scoped WAF block rule** (§6), tested in M1; changing the Access policy alone is not relied on for existing sessions; the origin already refuses non-edge traffic (lock); last resort suspend the Render service | named person, minutes | none |
| Wrong migration found | the PX-3a down script (`supabase/rollbacks/20261020090000_px3a_down.sql`) was rehearsed locally. It **drops `app.saved_prompts` and `app.saved_reflections`** (the saved content; `app_work` holds only helper functions and is **not** an export source). **Export and verify first, §8.1; the down script is not run until the verification passes and the owner chooses** | owner decision | **destroys saved prompts/results**; the alternative is restoring a daily backup (7 days) |
| Edge secret leaked | set a new `EDGE_LOCK_SECRET`, redeploy (§6), update the Cloudflare rule, confirm the old value is refused | operator | none |
| Application secrets leaked | rotate the three secrets, redeploy; cursors and in-flight setup markers are invalidated; **sessions are not** | operator | none |
| Session theft / compromise | **revocation, not rotation:** one account: admin global sign-out; everyone: §9. The provider's signing-key rotation does not sign users out and is not a substitute | named person | members sign in again; content untouched |
| Provider or Auth outage | nothing; the app answers a retryable 503 and writes nothing | wait | none |
| Pilot over | close access, export on request, delete members as asked (03 O10), delete the Supabase project and Render service, remove DNS and the Access application | owner | all deleted; backups age out in 7 days |

### 8.1 Export before a destructive rollback, and its verification
**A destructive rollback is separately authorized** (its own explicit approval naming the project, the export file and the verification result); nothing in this document or in PV-1 authorizes running the down script.
1. **Freeze writes:** close the maintenance gate (§6.3) so no member saves during the export.
2. **Export three tables, not two**, over the direct connection (the §5 binding), to a `0600` file outside the repository: `pg_dump --format=custom --data-only --table=app.accounts --table=app.saved_prompts --table=app.saved_reflections --file=<private path>`. The content tables depend on **`app.accounts`** (`owner_id` references `app.accounts (user_id)`, and a result references its prompt through the composite key `(id, owner_id)`), so the verification restore needs the accounts rows too. (`app.accounts.user_id` is not a foreign key to `auth.users`, so a scratch database can hold it.) The down script does not touch `app.accounts`.
3. **Record complete source facts in the same frozen state, over whole rows, not ids and versions:** for each of the three tables, the row count and one order-independent checksum of the **entire row text**, for example `select count(*), md5(coalesce(string_agg(t::text, E'\n' order by t.id), '')) from app.saved_prompts t;` (use `order by t.user_id` for `app.accounts`). Whole-row text covers every column, including the prompt and reflection text and the timestamps.
4. **Verify the export is restorable and complete:** `pg_restore --list` shows the data entries for the three tables; then restore into a **scratch database** (a local disposable stack with the same 25 migrations applied; never the pilot) **in dependency order inside one transaction**: `pg_restore --data-only --single-transaction --exit-on-error`. Do **not** use `--disable-triggers` or defer/disable constraints: the restore must prove that every foreign key is satisfied (accounts before prompts before results). Any foreign-key error means the export is not usable and is investigated, not worked around. Then recompute step 3 in the scratch database: **all three counts and all three whole-row checksums must equal the source**.
5. **Only then**, and only with the separate authorization above, may `20261020090000_px3a_down.sql` be run. Afterwards confirm the ledger prefix is 21 and mark the four versions reverted. To recover, re-apply the four migrations (which recreate the empty content tables; `app.accounts` is still present) and restore the **two content tables** from the verified export in one transaction with the same options (prompts before results, no trigger or constraint disabling), then repeat step 3 on the pilot and compare.
6. If verification fails at any point, the down script is **not run**. The verified export is member content: keep it `0600`, apply retention and deletion to it, and delete it when the owner decides.

## 9. Mass revocation (operator only, as `postgres`)
`delete from auth.sessions;` ends every session; refresh tokens go with it and still-unexpired access tokens are refused by the database guard. Local proof for a member's rows: `results/pilot-rpc-checks.txt` (R6, R7). The hosted run (03 X5) repeats it on the test members first.

## 10. After each stage
The operator posts a redacted record (outcome, statuses, counts; no values). Nothing proceeds on a hope that a step "probably" worked.
