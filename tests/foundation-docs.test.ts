// Keeps the local-stack workflow, CI definition and the foundation contract documents consistent with each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f: string) => readFileSync(join(root, f), 'utf8');
type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown>; if?: string };
const ci = yaml.load(read('.github/workflows/ci.yml')) as { permissions: Record<string, string>; jobs: Record<string, { steps: Step[]; 'timeout-minutes'?: number }> };

test('CI: verify job runs the secret scan before lint and every gate in order; database job uses the real local stack with a pinned CLI', () => {
  const runs = ci.jobs.verify.steps.map((s) => s.run).filter(Boolean);
  assert.deepEqual(runs.filter((r) => /^npm (ci|run|test)/.test(r!)).map((r) => r!.replace(' --ignore-scripts', '')), ['npm ci', 'npm run scan:gitleaks', 'npm run scan:secrets', 'npm run lint', 'npm run typecheck', 'npm test', 'npm run build', 'npm run smoke']);
  const db = ci.jobs.database.steps;
  const setup = db.find((s) => s.uses?.startsWith('supabase/setup-cli'));
  assert.ok(setup, 'database job must install the Supabase CLI');
  assert.match(String(setup!.with?.version), /^\d+\.\d+\.\d+$/, 'the CLI version must be pinned exactly');
  assert.equal(setup!.with?.version, '2.120.0');
  assert.ok(db.some((s) => /^supabase start/.test(s.run ?? '')) && db.some((s) => s.run === 'supabase test db'));
  assert.ok(db.some((s) => /^supabase stop/.test(s.run ?? '') && s.if === 'always()'), 'the stack must be stopped even when tests fail');
  assert.deepEqual(ci.permissions, { contents: 'read' });
  for (const job of Object.values(ci.jobs)) assert.ok(job['timeout-minutes'] && job['timeout-minutes'] <= 30);
});

test('the CLI version is pinned identically in CI and in scripts/supabase-cli-pin.json, and CI runs the local Auth checks between the pgTAP tests and the stop step', () => {
  const pinFile = JSON.parse(read('scripts/supabase-cli-pin.json'));
  const db = ci.jobs.database.steps;
  assert.equal(db.find((s) => s.uses?.startsWith('supabase/setup-cli'))!.with?.version, pinFile.version);
  assert.match(read('supabase/config.toml'), new RegExp(`CLI ${pinFile.version.replace(/\./g, '\\.')}`));
  const i = (pred: (s: Step) => boolean) => db.findIndex(pred);
  const spikes = i((s) => /local-auth-spikes\.mjs/.test(s.run ?? '')), f2a = i((s) => /local-f2a-checks\.mjs/.test(s.run ?? ''));
  assert.ok(i((s) => s.run === 'supabase test db') < spikes && spikes < f2a && f2a < i((s) => /^supabase stop/.test(s.run ?? '')), 'pgTAP, then the Auth checks, then the F2-A authority checks, then stop');
});

test('local Supabase config carries the settings the design depends on', () => {
  const toml = read('supabase/config.toml');
  assert.match(toml, /^project_id = "hackass-local"$/m);
  assert.match(toml, /^jwt_expiry = 600$/m);
  const section = (name: string) => toml.slice(toml.indexOf(`[${name}]`)).split(/\n\[/)[0];
  assert.match(section('auth.email'), /enable_confirmations = true/);
  assert.match(section('auth.mfa.totp'), /enroll_enabled = true/);
  assert.match(section('auth.mfa.totp'), /verify_enabled = true/);
  assert.match(toml, /CLI 2\.120\.0/);
});

test('pgTAP platform test exists and checks the real stack (roles, Auth sessions table, extensions); the F2-A schema is applied only through migrations', () => {
  const sql = read('supabase/tests/database/000_platform.test.sql');
  for (const needle of ["has_role('anon'", "has_role('authenticated'", "has_role('service_role'", "has_table('auth', 'sessions'", "'pg_trgm'", "'citext'", 'select plan(9)']) assert.ok(sql.includes(needle), needle);
  assert.equal((sql.match(/^select (has_|ok)/gm) ?? []).length, 9, 'plan count must match the assertions');
  assert.deepEqual(readdirSync(join(root, 'supabase/migrations')).filter((f) => f !== '.gitkeep').map((f) => f.replace(/^\d{14}_/, '')), ['f2a_roles_and_schemas.sql', 'f2a_identity_and_staff.sql', 'f2a_authorization_guards.sql', 'f2b_content_tables.sql', 'f2b_canonical_hash.sql', 'f2b_immutability.sql', 'f2b_content_rpc.sql', 'f2c1_review_tables.sql', 'f2c1_review_rules.sql', 'f2c1_review_rpc.sql', 'f2c2_publication_tables.sql', 'f2c2_publication_rules.sql', 'f2c2_publication_rpc.sql', 'f2d1_jobs_tables.sql', 'f2d1_jobs_rules.sql', 'f2d1_worker_rpc.sql', 'f2d1_utc_boundary.sql', 'f2d2_budget_tables.sql', 'f2d2_budget_functions.sql', 'f2e_catalog_rules.sql', 'f2e_catalog_api.sql', 'px3a_work_tables.sql', 'px3a_work_helpers.sql', 'px3a_work_api.sql', 'px3a_work_erasure.sql'], 'only the F2 and PX-3a migrations exist (checked in detail by f2a-migrations.test.ts)');
});

test('db:test reports BLOCKED (exit 2) with an actionable message when Docker is unavailable, never a silent pass', () => {
  const r = spawnSync(process.execPath, ['scripts/db-test.mjs'], { cwd: root, encoding: 'utf8', env: { PATH: '/nonexistent', HOME: process.env.HOME ?? '', DOCKER_BIN: '/nonexistent/docker', SUPABASE_BIN: '/nonexistent/supabase' } }); // explicit overrides keep this hermetic even on a machine that has Docker Desktop installed
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^BLOCKED\s+Docker is not available/m);
});

test('the ADR records the five F2 invariants and the F2 acceptance contract has a test row for each', () => {
  const adr = read('docs/adr/0001-foundation.md');
  const acceptance = read('docs/foundation/f2-acceptance.md');
  for (const id of ['I-1', 'I-2', 'I-3', 'I-4', 'I-5']) assert.ok(adr.includes(`**${id} `), `ADR missing ${id}`);
  for (const id of ['I-1a', 'I-1b', 'I-1c', 'I-2', 'I-3', 'I-4a', 'I-4b', 'I-4c', 'I-5', 'S-1', 'S-2', 'S-3', 'H-1', 'P-1', 'R-1', 'G-1', 'G-2', 'G-3', 'G-4']) assert.match(acceptance, new RegExp(`\\| ${id} \\|`), `acceptance contract missing ${id}`);
  assert.match(adr.replace(/\s+/g, ' '), /not validated until the real Auth-flow tests pass/, 'the cookie approach must stay described as an experiment');
  assert.ok(existsSync(join(root, 'docs/spikes/f1-hosted-spikes.md')));
  assert.match(read('docs/spikes/f1-hosted-spikes.md'), /BLOCKED — no hosted staging project/);
});

test('the in-repo secret scanner is labelled supplementary in CI, and Gitleaks (pinned) is the primary scan', () => {
  const names = ci.jobs.verify.steps.map((st) => (st as { name?: string }).name ?? '');
  assert.ok(names.some((n) => /^Secret scan \(Gitleaks/.test(n)));
  assert.ok(names.some((n) => /Secret scan \(in-repo scanner, supplementary\)/.test(n)));
  assert.ok(existsSync(join(root, 'docs/security/gitleaks.md')) && !existsSync(join(root, 'docs/proposals')));
});

test('docs/db/hashcanon-1.md names every hashed field in the order the implementation uses, and the golden-vector count matches', () => {
  const doc = read('docs/db/hashcanon-1.md');
  const order = ['category_slug', 'title', 'summary', 'outcome', 'difficulty', 'time_min_minutes', 'time_max_minutes', 'cost_min_cents', 'cost_max_cents', 'currency', 'estimate_basis', 'ai_requirement', 'limitations', 'steps', 'materials', 'requirements', 'tags', 'attributions', 'source_claims', 'assets'];
  const table = doc.slice(doc.indexOf('## The text'));
  let at = 0;
  for (const f of order) { const i = table.indexOf(f, at); assert.ok(i >= at, `${f} missing or out of order in the format table`); at = i; }
  const vectors = JSON.parse(read('tests/fixtures/hashcanon-vectors.json')).vectors.length;
  assert.match(doc, new RegExp(`\\(${vectors}\\)`), 'the document states the number of golden vectors');
  assert.match(read('docs/db/f2b-content.md'), /one lock rule|One lock rule/i);
});

test('docs/db/f2c1-review.md names every approval blocker the SQL can return, and every review function', () => {
  const doc = read('docs/db/f2c1-review.md');
  const rules = read('supabase/migrations/20261015090100_f2c1_review_rules.sql');
  const blockers = [...rules.matchAll(/array_append\(b, '([a-z_]+)(?::)?'/g)].map((m) => m[1]);
  assert.ok(blockers.length >= 6, `found ${blockers.length} blockers`);
  for (const b of new Set(blockers)) assert.ok(doc.includes(b.replace(/_$/, '')) || doc.includes(b), `the docs do not mention the blocker ${b}`);
  for (const fn of ['list_submissions_for_review', 'get_submission_for_review', 'start_review', 'record_risk_assessment', 'record_rights_review', 'record_decision']) assert.ok(doc.includes(fn), fn);
  assert.match(doc, /rollback/i);
});

test('docs/db/f2c2-publication.md names every publication blocker, function, error and snapshot line the SQL can produce, states the lock protocol and the rollback', () => {
  const doc = read('docs/db/f2c2-publication.md');
  const rules = read('supabase/migrations/20261016090100_f2c2_publication_rules.sql');
  const rpc = read('supabase/migrations/20261016090200_f2c2_publication_rpc.sql');
  const blockers = [...rules.matchAll(/array_append\(b, '([a-z_]+)(?::)?'/g)].map((m) => m[1]);
  assert.ok(blockers.includes('decision_not_publish') && blockers.includes('hash_mismatch') && blockers.includes('decision_self_review'), `found ${blockers.join(',')}`);
  for (const b of new Set(blockers)) assert.ok(doc.includes(b), `the docs do not mention the blocker ${b}`);
  for (const fn of ['publish_version', 'withdraw_publication', 'get_publication']) { assert.ok(doc.includes(fn), fn); assert.ok(rpc.includes(`create function api.${fn}(`), fn); }
  // every snapshot line tag the SQL writes is documented, in the same order
  const text = rules.match(/create function app_review\.snapshot_text[\s\S]*?\n\$\$;/)![0];
  const tags = [...text.matchAll(/'(HACKASS-PUB-1|target;|decision;|assessment;|publisher;|rights;)/g)].map((m) => m[1]);
  assert.deepEqual(tags, ['HACKASS-PUB-1', 'target;', 'decision;', 'assessment;', 'publisher;', 'rights;']);
  let at = doc.indexOf('```\nHACKASS-PUB-1');
  assert.ok(at > 0, 'the snapshot format block exists');
  for (const t of tags.slice(1)) { const i = doc.indexOf(`\n${t}`, at); assert.ok(i >= at, `${t} missing or out of order in the format block`); at = i; }
  for (const code of ['hash_mismatch', 'decision_conflict', 'approval_blocked', 'slug_taken', 'snapshot_mismatch', 'publication_withdrawn', 'withdrawal_required', 'pointer_must_be_cleared', 'slug_immutable']) assert.ok(doc.includes(code), code);
  assert.match(doc, /ascending `version_id`/);
  assert.match(doc, /FOR NO KEY UPDATE/);
  assert.match(doc, /rollback/i);
  assert.match(doc, /restores the F2-C1 `lock_submission`/);
});

test('docs/db/f2d1-jobs.md documents every worker function, the lock order with the job row last, the allowlisted subject, the fail-closed error, the rollback and the read-time expiry gate', () => {
  const doc = read('docs/db/f2d1-jobs.md');
  const rpc = read('supabase/migrations/20261017090200_f2d1_worker_rpc.sql');
  for (const fn of [...rpc.matchAll(/create function worker\.(\w+)\(/g)].map((m) => m[1])) assert.ok(doc.includes(fn), fn);
  const rules = read('supabase/migrations/20261017090100_f2d1_jobs_rules.sql');
  const keys = [...rules.match(/create function app_review\.job_subject[\s\S]*?\n\$\$;/)![0].matchAll(/'(\w+)', (?:j|p|exists|\(select)/g)].map((m) => m[1]);
  assert.ok(keys.length >= 8, `found subject keys ${keys.join(',')}`);
  for (const k of new Set(keys)) assert.ok(doc.includes(k), `the docs do not list the subject field ${k}`);
  assert.match(doc, /submission row → hack row → lifecycle row\(s\) → job row/);
  assert.match(doc, /lease_lost/);
  assert.match(doc, /read time/i);
  assert.match(doc, /deliberately left relaxed/);
  assert.match(doc, /rollback/i);
});

test('docs/db/f2d2-ai-budgets.md states the accounting contract: units, rules, every refusal reason, every function, the unknown-outcome recovery path, and the data loss of the rollback', () => {
  const doc = read('docs/db/f2d2-ai-budgets.md');
  const fns = read('supabase/migrations/20261018090100_f2d2_budget_functions.sql');
  for (const f of ['reserve', 'reserve_for_day', 'settle', 'mark_unknown', 'cancel', 'reconcile_report', 'outstanding']) { assert.ok(doc.includes('`' + f), f); assert.ok(fns.includes(`create function app_budget.${f}(`), f); }
  for (const d of [...fns.matchAll(/detail = '([a-z_]+)'/g)].map((m) => m[1]).filter((x) => /budget|unconfigured|disabled|cap|config/.test(x))) assert.ok(doc.includes(d), `the contract does not name the refusal ${d}`);
  for (const e of ['idempotency_conflict', 'settlement_conflict', 'charge_not_ruled_out', 'invalid_amount', 'provider_confirmed_no_charge', 'never_dispatched']) assert.ok(doc.includes(e), e);
  assert.match(doc, /micro-USD/);
  assert.match(doc, /UTC calendar day/);
  assert.match(doc, /Reconciliation recovery path/);
  assert.match(doc, /DATA LOSS|destroys every reservation/i);
  assert.match(doc, /written before the implementation/);
  assert.match(doc, /never `global`/);
  assert.match(doc, /missing_counters/);
  assert.match(doc, /a counter row is never deleted/);
  assert.match(doc, /does \*\*not necessarily exhaust\*\*/);
});

test('docs/db/f2e-public-catalog.md states the contract: every blocker code, the response allowlist, the pagination order and limits, and the rollback', () => {
  const doc = read('docs/db/f2e-public-catalog.md');
  const rules = read('supabase/migrations/20261019090000_f2e_catalog_rules.sql');
  const api = read('supabase/migrations/20261019090100_f2e_catalog_api.sql');
  for (const code of [...rules.matchAll(/'((?:not_current|no_slug|withdrawn|lifecycle_not_approved|content_hash_mismatch|snapshot_mismatch|publication_missing))'/g)].map((m) => m[1])) assert.ok(doc.includes(code), `the contract does not name ${code}`);
  for (const f of ['list_public_hacks', 'get_public_hack']) assert.ok(doc.includes(f) && api.includes(`create function api.${f}(`), f);
  for (const k of ['slug', 'version_id', 'published_at', 'category', 'difficulty', 'time_minutes', 'cost', 'ai_requirement', 'attributions', 'sources', 'steps', 'materials', 'requirements', 'tags']) assert.ok(doc.includes(k), `the allowlist does not name ${k}`);
  assert.match(doc, /published_at desc, slug desc|published_at.*desc.*slug.*desc/s);
  assert.match(doc, /default 25/i);
  assert.match(doc, /100/);
  assert.match(doc, /not_found/);
  assert.match(doc, /no fixed snapshot|not a snapshot|between pages/i);
  assert.match(doc, /rollback/i);
});

test('F2-E migrations: the reads are STABLE and write nothing, the allowlist is built field by field, and only the two catalog functions are granted to anon', () => {
  const rules = read('supabase/migrations/20261019090000_f2e_catalog_rules.sql').replace(/--.*$/gm, '');
  const api = read('supabase/migrations/20261019090100_f2e_catalog_api.sql').replace(/--.*$/gm, '');
  for (const body of [rules, api]) {
    assert.ok(!/\b(insert\s+into|delete\s+from|perform\s+|for\s+update|alter\s+table|create\s+table)\b/i.test(body), 'a read function must not write or lock');
    assert.ok(!/\bupdate\s+app\./i.test(body), 'no update statements');
  }
  for (const f of ['public_blockers', 'public_hack_json']) assert.match(rules.match(new RegExp(`create function app_review\\.${f}[\\s\\S]*?\\$\\$;`))![0], /\bstable\b/);
  for (const f of ['list_public_hacks', 'get_public_hack']) assert.match(api.match(new RegExp(`create function api\\.${f}[\\s\\S]*?\\$\\$;`))![0], /\bstable\b/);
  assert.ok(!/to_jsonb\s*\(|row_to_json|\bjsonb_agg\s*\(\s*\w+\s*\)/i.test(rules), 'the response is never a whole-row serialisation');
  assert.match(rules, /jsonb_build_object\(/);
  assert.match(api, /grant execute on function api\.list_public_hacks\(integer, text, text, timestamptz, text\), api\.get_public_hack\(text\) to anon, authenticated;/);
  assert.equal((api.match(/\bto anon\b/g) ?? []).length, 1);
  assert.ok(!/grant[^;]*app_review\.public_/i.test(rules + api), 'the internal functions are not granted');
  const down = read('supabase/rollbacks/20261019090000_f2e_down.sql').replace(/--.*$/gm, '');
  assert.ok(!/\b(drop\s+table|delete\s+from\s+app\.|truncate)\b/i.test(down), 'the rollback touches no table');
  for (const f of ['api.list_public_hacks', 'api.get_public_hack', 'app_review.public_blockers', 'app_review.public_hack_json']) assert.ok(down.includes(f), f);
  assert.match(down, /version in \('20261019090000', '20261019090100'\)/);
});

test('docs/db/f2e-public-catalog.md does not promise duplicate-free traversal: it states the start-time key, skips, repeats and the exact guarantees', () => {
  const doc = read('docs/db/f2e-public-catalog.md');
  assert.doesNotMatch(doc, /never returns the same hack twice/i);
  for (const needle of [/start time/, /backward/, /Delayed transactions/, /may \*\*skip\*\*/, /may \*\*repeat\*\*/, /within one response/, /de-duplicate by `slug`/]) assert.match(doc, needle);
});

test('docs/foundation/f2-closeout.md reconciles every F2 acceptance row and names the milestone for what remains', () => {
  const acceptance = read('docs/foundation/f2-acceptance.md');
  const closeout = read('docs/foundation/f2-closeout.md');
  const ids = [...acceptance.matchAll(/^\| ([GISHPR]-\d[ab-c]?) \|/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 20, `found ${ids.length} requirement rows`);
  for (const id of ids) assert.ok(closeout.includes(`| ${id} |`), `the closeout does not reconcile ${id}`);
  for (const topic of ['AI job / budget integration', 'Automated-decision restrictions', 'Profile and asset references', 'Worker execution', 'Monitoring and recovery', 'Contributor pagination', 'Catalog performance', 'Hosted verification', 'GitHub CI', 'Legacy credential retirement']) assert.ok(closeout.includes(`| ${topic} |`), topic);
  for (const status of ['satisfied locally', 'hosted verification pending', 'implementation missing', 'explicitly deferred']) assert.ok(closeout.includes(status), status);
  assert.match(closeout, /F2 acceptance as written remains \*\*open\*\*/);
  assert.match(acceptance, /f2-closeout\.md/);
});

test('docs/foundation/f2-closeout.md records the harness diagnosis: the original failure, the established cause, and what was not established', () => {
  const closeout = read('docs/foundation/f2-closeout.md');
  for (const needle of [/kill EPERM/, /8 !== 4/, /zombie/, /What was not established/, /never counted as success|never counted as a successful/]) assert.match(closeout, needle);
});
