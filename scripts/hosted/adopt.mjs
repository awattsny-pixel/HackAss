#!/usr/bin/env node
// Authorization S6 (READ-ONLY against the target): `adopt` carries the proven S6/S7 stages (preflight, identity, migrate) of an EARLIER run into a NEW run at the current commit, without repeating
// them and without touching the database: it verifies the live migration ledger (two read queries) and never applies a migration. See lib/adopt.mjs for the rules and what is recorded.
// Usage: node scripts/hosted/adopt.mjs --run-id=<NEW run> --from-run=<source run> --authorized=S6@<sha>   (same environment as the source run; the new run id must be unused)
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { runStage } from './lib/cli.mjs';
import { queryJson, queryText } from './lib/pg.mjs';
import { STAGING, REPO_ROOT } from './lib/config.mjs';
import { LEDGER_EXISTS_SQL, LEDGER_SQL } from './lib/sql.mjs';
import { hashTargets } from './lib/state.mjs';
import { readSourceRun, migrationChanges, runAdoption } from './lib/adopt.mjs';

const deps = {
  readSource: readSourceRun,
  changes: migrationChanges,
  repoVersions: () => readdirSync(path.join(REPO_ROOT, 'supabase/migrations')).filter((f) => /^\d{14}_.*\.sql$/.test(f)).map((f) => f.split('_')[0]).sort(),
  queryLedger: async (ctx) => ((await queryText(ctx, 'migrate', LEDGER_EXISTS_SQL)) === 'true' ? queryJson(ctx, 'migrate', LEDGER_SQL) : { count: 0, versions: [], md5: '' }),
};
const code = await runStage('adopt', process.argv.slice(2), (a) => runAdoption({ ...a, repoRoot: REPO_ROOT, expectedRef: a.profile === 'staging' ? STAGING.ref : 'selftest', targetsHash: hashTargets(a.ctx.targets), deps }));
process.exitCode = code;
