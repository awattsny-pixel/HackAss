#!/usr/bin/env node
// Authorization S9 (MUTATING, repeatable): `cleanup` = H13. It CLOSES the run (no further fixture creation), deletes the synthetic Auth users the run recorded (found again by their exact recorded
// e-mail addresses if their creation was interrupted), confirms no active assignment remains, removes the worker marker and deletes the run's private secrets file. It needs only `preflight`, so a failed
// or interrupted run can always be cleaned up, and each step is attempted even when another fails. Keys, the owner's password file, and the project itself are OWNER actions, listed at the end.
// Usage: node scripts/hosted/cleanup.mjs --run-id=... --authorized=S9@<sha> --confirm-mutating=cleanup [--profile=...] [--owner-deletion-date=YYYY-MM-DD]
import { runStage } from './lib/cli.mjs';
import { runCleanup } from './lib/cleanup.mjs';

const code = await runStage('cleanup', process.argv.slice(2), async ({ ctx, run, flags, say }) => {
  const out = await runCleanup({ ctx, run, say });
  const date = flags['owner-deletion-date']; // already validated as a real, current date by the common entry
  const st = run.state(); st.facts.owner_deletion_date = date ?? null; run.save(st);
  say('SCRIPT cleanup is finished when H13a to H13c all passed. OWNER ACTIONS still open after this stage (not performed or verified by the script):');
  say('  - revoke or rotate the secret key and any other key or token created for the run;');
  say('  - delete the password file(s) and unset every exported secret in the operator shell;');
  say('  - delete the staging project (O9); the synthetic content cannot be deleted by design; until then keep sign-ups closed and point no application at it;');
  say(`  - owner-confirmed project deletion date: ${date ?? 'NOT YET RECORDED (pass --owner-deletion-date=YYYY-MM-DD when the owner confirms)'}`);
  return out;
});
process.exitCode = code;
