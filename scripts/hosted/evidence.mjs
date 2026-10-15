#!/usr/bin/env node
// Authorization S9, LOCAL (contacts nothing): `evidence` = H14. Writes the REDACTED record of a run, finished OR NOT: a failed or interrupted run gets its evidence too. The record states the OUTCOME
// (COMPLETE, INCOMPLETE or FAILED), lists every required check with PASS, FAIL or NOT RUN, names script cleanup separately from the owner's outstanding cleanup, and is re-scanned for
// secret-shaped text. Secrets registered by earlier processes of the run are still removed after cleanup deleted the secrets file (salted hashes only are kept).
// The raw run directory is disposable and is deleted only with --delete-raw, and only once script cleanup is done.
// Usage: node scripts/hosted/evidence.mjs --run-id=... [--profile=...] [--out=<file>] [--delete-raw]
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runStage } from './lib/cli.mjs';
import { redact, looksSecret } from './lib/redact.mjs';
import { evaluateRun } from './lib/evidence-model.mjs';
import { REPO_ROOT, SUPABASE_CLI_VERSION, PSQL_IMAGE, STAGING } from './lib/config.mjs';

const cell = (x) => String(x ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = await runStage('evidence', process.argv.slice(2), async ({ run, flags, profile, say }) => {
  const state = run.state(); const results = run.results();
  const ev = evaluateRun(state, results);
  const date = new Date().toISOString().slice(0, 10);
  const name = `${date}-${profile === 'staging' ? 'staging' : 'selftest'}-${run.runId}.md`;
  const out = flags.out ? path.resolve(flags.out) : profile === 'selftest' ? path.join(run.dir, name) : path.join(REPO_ROOT, 'docs', 'hosted', 'evidence', name);
  if (profile === 'staging' && !path.resolve(out).startsWith(path.join(REPO_ROOT, 'docs', 'hosted', 'evidence') + path.sep)) throw new Error('staging evidence is written under docs/hosted/evidence/ only');
  if (existsSync(out)) throw new Error(`${out} already exists; evidence is never overwritten`);
  const commits = [...new Set(Object.values(state.stages).map((s) => s.commit).filter(Boolean))];
  const f = state.facts ?? {};
  const byId = new Map(ev.rows.map((r) => [r.id, r]));
  const lines = [
    `# Hosted verification evidence (${profile}) ${date}`, '',
    `- **Outcome: ${ev.outcome}**${ev.reasons.length ? ` (${ev.reasons.join('; ')})` : ''}`,
    `- Run: \`${run.runId}\`; project reference \`${profile === 'staging' ? STAGING.ref : 'local disposable stack'}\`; bound to commit \`${state.binding?.commit ?? 'none recorded'}\``,
    `- Commit(s) recorded by stages: ${commits.map((c) => `\`${c}\``).join(', ') || 'none recorded'}`,
    `- Supabase CLI ${SUPABASE_CLI_VERSION}; database client image \`${PSQL_IMAGE}\`; Postgres server ${f.server_version ?? 'not recorded'}; signing keys: ${f.jwks ?? 'not recorded'}`,
    `- Stages: ${Object.entries(state.stages).filter(([k]) => k !== 'evidence').map(([k, v]) => `${k}=${v.status}`).join(', ') || 'none started'}`,
    `- Script cleanup (H13a to H13c): ${ev.scriptCleanupDone ? 'DONE' : 'NOT DONE'}; the run was ${state.closed ? 'closed to further fixture creation' : 'NOT closed'}`,
    `- Owner-confirmed project deletion date: ${ev.ownerDate ?? (f.owner_deletion_date ? `INVALID (${f.owner_deletion_date})` : 'NOT RECORDED')}`, '',
    '## Owner cleanup outstanding (not performed or verified by the scripts)', '', ...ev.ownerActions.map((a) => `- ${a}`), '',
    '## Checks', '', '| Check | Status | ms | Detail |', '|---|---|---|---|',
    ...ev.rows.map((r) => `| ${r.id} | ${r.status} | ${r.record?.ms ?? ''} | ${cell(r.status === 'FAIL' ? (results.filter((x) => x.id === r.id && x.status === 'FAIL').at(-1)?.error) : r.status === 'NOT RUN' ? (r.id === 'H8-default' ? 'the hosted 15-minute MFA test was not run (stage session-checks needs --default-window); required for full acceptance' : 'not run') : (r.record?.facts ?? ''))} |`),
    ...results.filter((r) => !byId.has(r.id) && r.id !== 'STAGE-ERROR').map((r) => `| ${r.id} | ${r.status} | ${r.ms ?? ''} | ${cell(r.status === 'FAIL' ? r.error : (r.facts ?? r.reason))} |`), '',
    ev.stageErrors.length ? `## Unexpected stage errors\n\n${ev.stageErrors.map((e) => `- ${e.stage}: ${e.error}`).join('\n')}\n` : '',
    ev.fails.length ? `## Failed checks\n\n${ev.fails.map((id) => `- ${id}: ${results.filter((x) => x.id === id && x.status === 'FAIL').at(-1)?.error}`).join('\n')}\n` : '',
  ];
  const body = redact(lines.join('\n'));
  const hits = body.split('\n').filter((l) => looksSecret(l));
  if (hits.length) throw new Error(`${hits.length} line(s) still look secret-shaped after redaction; nothing was written`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, body, { mode: 0o644 });
  say(`wrote ${out} (outcome ${ev.outcome}; ${ev.rows.length} required checks, ${ev.notRun.length} not run)`);
  if (flags['delete-raw']) { if (!ev.scriptCleanupDone) throw new Error('refusing --delete-raw before script cleanup is done'); say('the raw run directory will be deleted when this process exits'); process.once('exit', () => run.destroy()); }
  return { passed: 1, failed: 0 };
});
process.exitCode = code;
