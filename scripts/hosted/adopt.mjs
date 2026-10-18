#!/usr/bin/env node
// Authorization S6 (READ-ONLY against the target): `adopt` carries the proven S6/S7 stages (preflight, identity, migrate) of an EARLIER run into a NEW run at the current commit, without repeating
// them and without touching the database: it verifies the live migration ledger (two read queries) and never applies a migration. See lib/adopt.mjs for the rules and what is recorded.
// Usage: node scripts/hosted/adopt.mjs --run-id=<NEW run> --from-run=<source run> --authorized=S6@<sha> [--through=s8]   (--through=s8 also carries S7 part B and S8 progress, see lib/adopt.mjs)   (same environment as the source run; the new run id must be unused)
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { runStage } from './lib/cli.mjs';
import { queryJson, queryText } from './lib/pg.mjs';
import { STAGING, REPO_ROOT } from './lib/config.mjs';
import { LEDGER_EXISTS_SQL, LEDGER_SQL } from './lib/sql.mjs';
import { hashTargets } from './lib/state.mjs';
import { inspectFixtures } from './lib/fixture-inspect.mjs';
import { readSourceRun, migrationChanges, runAdoption, runAdoptionS8 } from './lib/adopt.mjs';

const deps = {
  readSource: readSourceRun,
  changes: migrationChanges,
  repoVersions: () => readdirSync(path.join(REPO_ROOT, 'supabase/migrations')).filter((f) => /^\d{14}_.*\.sql$/.test(f)).map((f) => f.split('_')[0]).sort(),
  queryLedger: async (ctx) => ((await queryText(ctx, 'migrate', LEDGER_EXISTS_SQL)) === 'true' ? queryJson(ctx, 'migrate', LEDGER_SQL) : { count: 0, versions: [], md5: '' }),
};
const through = process.argv.slice(2).find((a) => a.startsWith('--through='))?.split('=')[1] ?? 's7';
if (!['s7', 's8'].includes(through)) { console.error('--through must be s7 or s8'); process.exit(2); }
const body = through === 's8' ? runAdoptionS8 : runAdoption;
const code = await runStage('adopt', process.argv.slice(2), (a) => body({ ...a, repoRoot: REPO_ROOT, expectedRef: a.profile === 'staging' ? STAGING.ref : 'selftest', targetsHash: hashTargets(a.ctx.targets), deps: { ...deps, inspectFixtures } }));
process.exitCode = code;
