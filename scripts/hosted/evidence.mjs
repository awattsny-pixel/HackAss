#!/usr/bin/env node
// Authorization S9, LOCAL (contacts nothing): `evidence` = H14. Writes the REDACTED record of a finished run. The record is a candidate for a separate, reviewed commit; the raw run directory
// is disposable and is deleted only with --delete-raw, and only after the record was written and re-scanned for secret-shaped text.
// Usage: node scripts/hosted/evidence.mjs --run-id=... [--profile=...] [--out=<file>] [--delete-raw]
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runStage } from './lib/cli.mjs';
import { redact, looksSecret } from './lib/redact.mjs';
import { REPO_ROOT, SUPABASE_CLI_VERSION, PSQL_IMAGE, STAGING } from './lib/config.mjs';

const code = await runStage('evidence', process.argv.slice(2), async ({ run, flags, profile, say }) => {
  const state = run.state(); const results = run.results();
  const date = new Date().toISOString().slice(0, 10);
  const out = flags.out ? path.resolve(flags.out) : profile === 'selftest' ? path.join(run.dir, `${date}-selftest.md`) : path.join(REPO_ROOT, 'docs', 'hosted', 'evidence', `${date}-staging.md`);
  if (profile === 'staging' && !path.resolve(out).startsWith(path.join(REPO_ROOT, 'docs', 'hosted', 'evidence') + path.sep)) throw new Error('staging evidence is written under docs/hosted/evidence/ only');
  if (existsSync(out)) throw new Error(`${out} already exists; evidence is never overwritten`);
  const commits = [...new Set(Object.values(state.stages).map((s) => s.commit).filter(Boolean))];
  const f = state.facts ?? {};
  const lines = [
    `# Hosted verification evidence (${profile}) ${date}`, '',
    `- Run: \`${run.runId}\`; project reference \`${profile === 'staging' ? STAGING.ref : 'local disposable stack'}\``,
    `- Commit(s) tested: ${commits.map((c) => `\`${c}\``).join(', ') || 'none recorded'}`,
    `- Supabase CLI ${SUPABASE_CLI_VERSION}; database client image \`${PSQL_IMAGE}\`; Postgres server ${f.server_version ?? 'not recorded'}; signing keys: ${f.jwks ?? 'not recorded'}`,
    `- Stages: ${Object.entries(state.stages).filter(([k]) => k !== 'evidence').map(([k, v]) => `${k}=${v.status}`).join(', ')}`,
    `- Owner-confirmed project deletion date: ${f.owner_deletion_date ?? 'not recorded'}`, '',
    '| Check | Status | ms | Detail |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.status} | ${r.ms ?? ''} | ${String(r.status === 'FAIL' ? r.error : (r.facts ?? r.reason ?? '')).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`), '',
    results.some((r) => r.status === 'FAIL') ? '## Failed checks\n\n' + results.filter((r) => r.status === 'FAIL').map((r) => `- ${r.id}: ${r.error}`).join('\n') + '\n' : 'No check failed.\n',
  ];
  const body = redact(lines.join('\n'));
  const hits = body.split('\n').filter((l) => looksSecret(l));
  if (hits.length) throw new Error(`${hits.length} line(s) still look secret-shaped after redaction; nothing was written`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, body, { mode: 0o644 });
  say(`wrote ${out} (${results.length} check records)`);
  if (flags['delete-raw']) { if (state.stages.cleanup?.status !== 'done') throw new Error('refusing --delete-raw before cleanup is done'); say('the raw run directory will be deleted when this process exits'); process.once('exit', () => run.destroy()); }
  return { passed: 1, failed: 0 };
});
process.exitCode = code;
