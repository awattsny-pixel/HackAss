// Keeps the M-HOST preparation documents (docs/hosted) consistent with the repository they describe: the migration list, the CI workflow, the
// credential findings, the closeout corrections, the function allowlist, and the rule that no secret or live target appears in them. These are
// documentation checks only; nothing here contacts a hosted system.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const hostedFiles = readdirSync(join(root, 'docs/hosted')).filter((f) => f.endsWith('.md'));
const workflowText = read('.github/workflows/ci.yml');
const workflow = yaml.load(workflowText) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, { 'runs-on': string; steps: Array<{ uses?: string; with?: Record<string, unknown> }> }> };
const section = (doc: string, from: string, to: string) => {
  const a = doc.indexOf(from);
  const b = to ? doc.indexOf(to, a + from.length) : doc.length;
  assert.ok(a >= 0 && b > a, `section ${from} .. ${to} not found`);
  return doc.slice(a, b);
};
const procedure = () => read('docs/hosted/verification-procedure.md');
const checkBody = (id: string) => {
  const doc = procedure();
  const a = doc.indexOf(`### ${id}.`);
  assert.ok(a >= 0, `${id} missing`);
  const rest = doc.slice(a + 5);
  const next = rest.search(/^### H\d+\.|^## /m);
  return doc.slice(a, next < 0 ? doc.length : a + 5 + next);
};

test('docs/hosted holds the preparation documents and says nothing was executed', () => {
  assert.deepEqual(hostedFiles.sort(), ['README.md', 'approval-summary.md', 'ci-review.md', 'credential-retirement.md', 'staging-plan.md', 'verification-procedure.md']);
  assert.match(read('docs/hosted/README.md'), /Status: prepared, not executed/);
  assert.match(read('docs/hosted/README.md'), /No hosted system was contacted|no hosted system was contacted/);
});

test('no hosted preparation document contains a secret, a connection string with a password, a JWT, or a live project reference', () => {
  for (const f of hostedFiles) {
    const t = read(`docs/hosted/${f}`);
    assert.doesNotMatch(t, /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, `${f}: JWT-shaped value`);
    assert.doesNotMatch(t, /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@]+@/, `${f}: connection string with a password`);
    assert.doesNotMatch(t, /sb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}/, `${f}: Supabase key`);
    assert.doesNotMatch(t, /[a-z]{20}\.supabase\.co/, `${f}: a concrete project host`);
    assert.doesNotMatch(t.replaceAll('266ec02e4e55b91420d51dc8cf907c7b8ac4540e', ''), /\b[0-9a-f]{40}\b/, `${f}: a full commit-hash-sized hex string other than the accepted base commit (use the 7-character form for history references)`);
  }
});

test('the staging plan lists exactly the migration files, in filename order', () => {
  const files = readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
  const listed = [...read('docs/hosted/staging-plan.md').matchAll(/^\d+\. `(\d{14}_[a-z0-9_]+\.sql)`$/gm)].map((m) => m[1]);
  assert.deepEqual(listed, files);
  assert.equal(files.length, 21);
});

test('the staging plan fixes the database major version, the worker connection method and the Auth values from the repository configuration', () => {
  const plan = read('docs/hosted/staging-plan.md');
  const toml = read('supabase/config.toml');
  assert.match(toml, /^major_version = 17$/m);
  assert.match(plan, /Postgres major version \| \*\*17\*\*/);
  assert.match(plan, /hackass_worker\.<project-ref>/);
  assert.match(plan, /transaction mode/);
  assert.match(plan, /session mode/);
  assert.match(toml, /^jwt_expiry = 600$/m);
  assert.match(plan, /\*\*600 s\*\*/);
  assert.match(plan, /created without a password/i);
});

test('the exposed schema is configured AFTER the migrations create it: the plan and the procedure agree on the order', () => {
  const plan = read('docs/hosted/staging-plan.md');
  const doc = procedure();
  const row = plan.split('\n').find((l) => l.startsWith('| Exposed schemas'))!;
  assert.match(row, /\*\*`api` only\*\*/);
  assert.match(row, /after the migrations have created `api`/);
  assert.match(row, /step H2b/);
  assert.match(plan, /\| O6b \| after the migrations \(H2a\)/);
  assert.match(checkBody('H2'), /### H2\./);
  const h2 = checkBody('H2');
  assert.ok(h2.indexOf('*H2a') < h2.indexOf('*H2b') && h2.indexOf('*H2b') < h2.indexOf('*H2c'), 'H2a, H2b, H2c are in order');
  assert.match(h2, /can only be set to `api` \*\*now\*\*/);
  assert.match(h2, /No HTTP-based check \(H5b onward\) runs before H2b passes/);
  assert.match(doc, /H2b immediately after H2a and before any HTTP check that needs `api`/);
  assert.equal(readdirSync(join(root, 'supabase/migrations')).some((f) => /create schema api/i.test(read(`supabase/migrations/${f}`))), true, 'a migration creates schema api');
});

test('database secrets never appear in an argument: a verified password-file method, with the forbidden forms listed only as "never"', () => {
  const doc = procedure();
  const method = section(doc, '### 0.2 Database connection method', '## 1. Forbidden against staging');
  for (const needle of [/PGPASSFILE/, /`0600`/, /outside the repository/, /\|\s*password inside the `--db-url` argument\s*\|.*visible in `ps`/, /SUPABASE_DB_PASSWORD.*fails/s, /Never:/, /Not verified/]) assert.match(method, needle);
  for (const [i, line] of doc.split('\n').entries()) {
    if (/supabase db push/.test(line) && /--db-url/.test(line)) {
      assert.doesNotMatch(line, /:\/\/[^/\s"]*:[^@\s"]*@/, `line ${i + 1}: a password inside the URL`);
      assert.match(line, /sslmode=require/, `line ${i + 1}: db push URL without sslmode`);
    }
  }
  // the commands in the checks use the password file; PGPASSWORD / SUPABASE_DB_PASSWORD / --debug appear only in verified-results or "never" text
  const checks = section(doc, '## 3. Checks', '## 4. Summary of classifications');
  for (const bad of ['PGPASSWORD=', 'SUPABASE_DB_PASSWORD', '--debug', 'STAGING_DB_PASSWORD', 'STAGING_WORKER_PASSWORD']) assert.ok(!checks.includes(bad), `${bad} used in a check`);
  assert.ok((checks.match(/PGPASSFILE="\$STAGING_PGPASSFILE"/g) ?? []).length >= 3);
  for (const f of ['staging-plan.md', 'README.md']) assert.ok(!/STAGING_DB_PASSWORD|STAGING_WORKER_PASSWORD/.test(read(`docs/hosted/${f}`)), `${f} still describes password environment variables`);
});

test('H0 validates the API URL, the database login, BOTH pooler endpoints, the worker login and the password file, and H1b/H2c prove the live targets match', () => {
  const h0 = checkBody('H0');
  for (const needle of [/\*\*API:\*\*/, /\*\*Database \(migration login\):\*\*/, /Pooler transaction endpoint and pooler session endpoint/, /\*\*Worker login:\*\*/, /\*\*Password file:\*\*/, /FORBIDDEN_PROJECT_REFS/, /does not establish that the database connections reach the same project/]) assert.match(h0, needle);
  assert.match(h0, /6543/);
  assert.match(h0, /5432/);
  const h1 = checkBody('H1');
  assert.match(h1, /\*H1b \(mutating, minimal\)/);
  assert.match(h1, /\*\*1 on all three\*\* endpoints/);
  assert.match(h1, /migration endpoint, the pooler session endpoint and the pooler transaction endpoint/);
  const h2 = checkBody('H2');
  assert.match(h2, /hackass\.staging_marker/);
  assert.match(h2, /each\*\* of the pooler transaction and session endpoints/);
  assert.match(checkBody('H13'), /reset hackass\.staging_marker/);
});

test('every hosted check is classified read-only or mutating, and the forbidden-against-staging list names the local destructive tooling', () => {
  const doc = procedure();
  const ids = [...doc.matchAll(/^### (H\d+)\./gm)].map((m) => m[1]);
  assert.deepEqual(ids, Array.from({ length: 15 }, (_, i) => `H${i}`));
  const summary = section(doc, '## 4. Summary of classifications', '## 5. Order and gating');
  for (const id of ids) {
    const rows = summary.split('\n').filter((l) => new RegExp(`^\\| ${id}[abc]? `).test(l));
    assert.ok(rows.length >= 1, `${id} is missing from the classification table`);
    assert.ok(rows.every((r) => /read-only|mutating|local|owner mutation/.test(r)), `${id} has an unclassified row`);
  }
  for (const sub of ['H1a', 'H1b', 'H2a', 'H2b', 'H2c', 'H5a', 'H5b']) assert.ok(summary.includes(`| ${sub} `), `${sub} is missing from the classification table`);
  for (const id of ids) assert.match(checkBody(id), /read-only|Read-only|mutating|Mutating|\(local/, `check section without a classification: ${id}`);
  const forbidden = section(doc, '## 1. Forbidden against staging', '## 2. Fixture users');
  for (const needle of ['supabase db reset', 'supabase stop --no-backup', 'scripts/local-f2*-checks.mjs', 'supabase/rollbacks/', 'supabase link', 'R6, R7, R8']) assert.ok(forbidden.includes(needle), needle);
  assert.match(doc, /FORBIDDEN_PROJECT_REFS/);
});

test('the hosted procedure never instructs a local destructive command against staging: such commands appear only in the forbidden list or in "never" text', () => {
  const doc = procedure();
  const outside = doc.replace(section(doc, '## 1. Forbidden against staging', '## 2. Fixture users'), '');
  for (const bad of ['supabase db reset', 'supabase stop', 'db push --linked', 'supabase link', 'rollbacks/20']) {
    for (const line of outside.split('\n')) if (line.includes(bad)) assert.match(line, /alternative|writes the project reference|never|Never|not |forbidden|Forbidden/, `unexpected use of "${bad}": ${line.slice(0, 100)}`);
  }
});

test('the fixture sequence is executable: dedicated users for sign-out, staff removal and MFA; every later check signs in afresh', () => {
  const doc = procedure();
  const fixtures = section(doc, '## 2. Fixture users', '## 3. Checks');
  for (const u of ['`ident`', '`b1`', '`b2`', '`s-sess`', '`s-rm`', '`s-mfa`', '`s-rev`']) assert.ok(fixtures.includes(u), u);
  assert.match(fixtures, /dedicated/i);
  assert.match(fixtures, /\*\*own fresh sign-in\*\*/);
  assert.match(checkBody('H6'), /no later check uses `s-sess`/);
  assert.match(checkBody('H6'), /every later check signs in its own users afresh/);
  assert.match(checkBody('H7'), /Create `s-rm`/);
  assert.match(checkBody('H7'), /`s-rm` is not used again/);
  assert.match(checkBody('H8'), /Create `s-mfa` with an active staff assignment \(it is \*\*not\*\* the user of H7/);
  assert.doesNotMatch(checkBody('H7'), /s-mfa/);
  assert.doesNotMatch(checkBody('H8'), /s-rm/);
  assert.match(checkBody('H8'), /overlap H6, H7 and H9/);
  assert.doesNotMatch(checkBody('H7'), /H8 steps 1 to 3/);
});

test('H10 builds a due job with an explicit, narrowly scoped procedure (an expiry date, one scoped update, exactly one due job)', () => {
  const h10 = checkBody('H10');
  for (const needle of [/neither present nor claimable just because a publication was made/, /expires_on \+ 1 day/, /\*\*tomorrow \(UTC\)\*\*/, /exactly one `queued` row/, /count\(\*\) from app\.jobs where status = 'queued' and available_at <= now\(\)` is \*\*0\*\*/,
    /update app\.jobs set available_at = pg_catalog\.now\(\) - interval '1 minute'/, /where id = '<J job id>' and target_publication_id = '<J publication id>' and status = 'queued'/, /exactly one returned row/, /no trigger is disabled/,
    /is `1` and that id is `J`'s job/, /claim returns exactly `J`'s job/, /still_eligible/, /lease_lost/]) assert.match(h10, needle);
  const rules = read('supabase/migrations/20261017090100_f2d1_jobs_rules.sql');
  assert.match(rules, /t := \(e \+ 1\)::timestamp at time zone 'UTC'/, 'the scheduling rule the procedure relies on still exists');
  assert.match(rules, /if e is null then return; end if;/, 'no expiry, no job');
  assert.match(read('scripts/local-f2d1-checks.mjs'), /update app\.jobs set available_at = now\(\) - interval '1 minute' where target_publication_id/, 'the local checks use the same scoped statement');
});

test('H11 keeps enough eligible publications for multiple pages after hiding two', () => {
  const h11 = checkBody('H11');
  for (const needle of [/`P1`, `P2`, `P3`.*\*\*stay eligible\*\*/, /`P4` will be \*\*withdrawn\*\*/, /`P5` will have its rights \*\*revoked\*\*/, /six eligible publications at the start and \*\*four \(`P1`, `P2`, `P3`, `J`\) at the end\*\*/,
    /exactly \*\*3 pages\*\*/, /exactly \*\*4 pages\*\*/, /2 pages \(3 then 1\)/, /`P4` and `P5` absent/, /recomputed client-side/]) assert.match(h11, needle);
});

test('H12 separates forbidden data access from permitted metadata, checks the metadata against the function allowlist, and proves credentials work first', () => {
  const h12 = checkBody('H12');
  for (const needle of [/Phase 1: the credential works on an allowed endpoint/, /Phase 2: forbidden data access/, /Phase 3: metadata that is permitted to be visible \(HTTP 200 is acceptable here\)/, /every one returns a non-2xx status/, /inconclusive/,
    /GET \/auth\/v1\/admin\/users\?per_page=1/, /subset of the 19 `api` functions/, /\*\*no\*\* table path/]) assert.match(h12, needle);
  assert.doesNotMatch(h12, /never 200 with rows/);
  // the 19-function allowlist in the document equals the api functions in the golden inventory
  const golden = read('supabase/tests/database/010_roles_and_grants.test.sql');
  const apiGolden = [...new Set([...golden.matchAll(/(?:^|\$golden\$)api\.([a-z_]+)\(/gm)].map((m) => m[1]))].sort();
  const listText = h12.slice(h12.indexOf('subset of the 19'), h12.indexOf('for the anonymous credential'));
  const inDoc = [...listText.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => n !== 'api').sort();
  assert.deepEqual(inDoc, apiGolden);
  assert.equal(inDoc.length, 19);
  // anonymous may execute exactly the two public reads
  assert.match(golden, /api\.get_public_hack\(text\) owner=hackass_owner definer=true vol=s search_path="" execute=anon,authenticated,hackass_owner/);
  assert.match(golden, /api\.list_public_hacks\(integer,text,text,timestamp with time zone,text\) owner=hackass_owner definer=true vol=s search_path="" execute=anon,authenticated,hackass_owner/);
  assert.match(h12, /only `get_public_hack` and `list_public_hacks`|only functions `anon` may execute/);
});

test('raw output is disposable and redacted evidence is retained: the three documents say the same thing', () => {
  const h14 = checkBody('H14');
  for (const needle of [/\*\*Raw output\*\*.*\*\*disposable\*\*/s, /never committed, attached, uploaded or sent/, /deleted once the redacted record has been reviewed/, /\*\*Redacted evidence\*\* is the \*\*retained\*\* record/, /kept with the repository after the staging project is gone/]) assert.match(h14, needle);
  const plan = read('docs/hosted/staging-plan.md');
  assert.match(plan, /\*\*Raw output is disposable; redacted evidence is retained\.\*\*/);
  assert.match(plan, /The redacted evidence is \*\*not\*\* deleted/);
  const approval = read('docs/hosted/approval-summary.md');
  assert.match(approval, /\*\*raw, unredacted\*\* run output.*\(disposable; never committed\)/);
  assert.match(approval, /\*\*Keep\*\* the redacted verification evidence/);
  assert.match(read('docs/hosted/README.md'), /Raw run output is disposable and never kept; only redacted evidence is retained/);
});

test('the CI review matches the workflow: triggers, permissions, action references, runtime versions and the absence of secrets and deployment steps', () => {
  const review = read('docs/hosted/ci-review.md');
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const uses = [...new Set(Object.values(workflow.jobs).flatMap((j) => j.steps.map((s) => s.uses).filter(Boolean)))] as string[];
  assert.ok(uses.length >= 3);
  for (const u of uses) assert.ok(review.includes(u.split('@')[0]) && review.includes(`@${u.split('@')[1]}`), `the review does not mention ${u}`);
  for (const u of uses) assert.match(u, /@v\d+$/, `${u} is unexpectedly pinned differently from the reviewed tag form (update ci-review.md)`);
  assert.ok(Object.values(workflow.jobs).every((j) => j['runs-on'] === 'ubuntu-latest'));
  assert.match(review, /ubuntu-latest/);
  assert.match(review, /22\.23\.3/);
  assert.equal(read('.nvmrc').trim(), '22.23.3');
  assert.match(review, /2\.120\.0/);
  assert.doesNotMatch(workflowText.replace(/^\s*#.*$/gm, ''), /secrets\.|vars\.|environment:|deploy|id-token|contents: write|packages: write|upload-artifact|gh release|git push/i);
  assert.match(review, /every branch and every tag/);
  for (const q of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']) assert.ok(review.includes(`| ${q} |`), q);
  assert.match(review, /plausible and must be treated as likely/);
});

test('looking up the commit behind a public action tag needs no special permission, in the CI review and the approval summary', () => {
  const review = read('docs/hosted/ci-review.md');
  const approval = read('docs/hosted/approval-summary.md');
  assert.match(review, /read-only lookup against the \*\*public\*\* action repositories/);
  assert.match(review, /needs no credentials, no access to this repository and no special permission/);
  assert.match(approval, /read-only lookup of public action repositories and needs no special permission/);
  for (const f of hostedFiles) assert.doesNotMatch(read(`docs/hosted/${f}`), /authorize that lookup|authorization to contact GitHub for the commit SHAs|after authorization\./, `${f}: still requires permission for the public lookup`);
});

test('the same three push prerequisites (deployment controls, credential-retirement evidence, final workflow commit reviewed) appear in every document that gates a push', () => {
  for (const f of ['README.md', 'ci-review.md', 'credential-retirement.md', 'approval-summary.md']) {
    const t = read(`docs/hosted/${f}`);
    assert.match(t, /Push prerequisites \(all three, for every push to any shared remote\)/, `${f}: push prerequisites`);
    assert.match(t, /\*\*P1 deployment controls\*\*/, `${f}: P1`);
    assert.match(t, /\*\*P2 credential-retirement evidence\*\*/, `${f}: P2`);
    assert.match(t, /\*\*P3 final workflow commit reviewed\*\*/, `${f}: P3`);
  }
  const approval = read('docs/hosted/approval-summary.md');
  const s3 = approval.split('\n').find((l) => l.startsWith('| S3 '))!;
  assert.match(s3, /P1 deployment controls, P2 credential-retirement evidence, P3 final workflow commit reviewed/);
  assert.match(approval, /\*\*the final workflow commit\*\*/);
  assert.doesNotMatch(approval, /\| Commit to be pushed \| the tip of `mhost0-preflight`/);
  assert.match(read('docs/hosted/credential-retirement.md'), /is \*\*push prerequisite P2\*\*/);
});

test('the deployment-trigger evidence quoted in the CI review still exists in the repository', () => {
  assert.match(read('SETUP_COMPLETE.md'), /Vercel auto-deploys on git push/);
  assert.equal(read('README.md').split('\n')[0], '// Deployment trigger');
  assert.match(read('PROJECT_STATUS.md'), /Frontend: Vercel/);
});

test('the credential-retirement document covers every baselined finding without containing a value, and ties R3 to an exposed secret or established compromise', () => {
  const doc = read('docs/hosted/credential-retirement.md');
  const ignore = read('.gitleaksignore').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.equal(ignore.length, 6);
  for (const l of ignore) {
    const [commit, file, rule] = l.split(':');
    assert.ok(doc.includes(`${commit.slice(0, 7)}`), `the document does not cover the finding in ${commit.slice(0, 7)}`);
    assert.ok(doc.includes(file), `the document does not name ${file}`);
    assert.ok(rule.length > 0);
  }
  for (const needle of [/never contains, copies, prints or tests an exposed value/, /A clean secret scan is not proof of retirement/, /Rewriting git history does not retire a credential/, /service_role/, /database password/]) assert.match(doc, needle);
  assert.match(doc, /A signed JWT is not the same as an exposed signing secret/);
  assert.match(doc, /R3 applies only when the signing secret itself appears in committed files/);
  assert.match(doc, /or when compromise is otherwise established/);
  const r3 = doc.split('\n').find((l) => l.startsWith('| R3 | the Supabase'))!;
  assert.match(r3, /only if the secret itself was exposed or its compromise is otherwise established/);
  assert.doesNotMatch(r3, /if the committed JWTs were signed with it/);
  assert.match(doc, /recorded "not applicable" with that reason/);
});

test('the approval summary names the base commit, the proposed remote branch, the unresolved dependencies, cost, cleanup and per-step authorization', () => {
  const doc = read('docs/hosted/approval-summary.md');
  for (const needle of [/266ec02e4e55b91420d51dc8cf907c7b8ac4540e/, /mhost1-ci-first-run/, /refs\/heads\/mhost1-ci-first-run/, /Deployment integration on push/, /Expected cost/, /Cleanup responsibilities/, /separately authorizable/, /Nothing in this document is authorized/, /not yet identified; not created/]) assert.match(doc, needle);
  for (const u of ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8']) assert.ok(doc.includes(`| ${u} |`), u);
  for (const s of ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']) assert.ok(doc.includes(`| ${s} |`), s);
});

test('the three documentation corrections from the F2-F review are applied to the closeout', () => {
  const c = read('docs/foundation/f2-closeout.md');
  assert.match(c, /`npm test` 201\/201 at `266ec02`/);
  assert.doesNotMatch(c, /191\/191 \(plus new harness tests\)/);
  assert.match(c, /real-stack check `E4` in `scripts\/local-f2e-checks\.mjs`/);
  assert.match(c, /invoking the migration runner again applies nothing that the ledger already records/);
  assert.match(c, /not required to tolerate their raw SQL being executed twice/);
  assert.doesNotMatch(c, /replay-twice test/);
});
