#!/usr/bin/env node
// Pre-deploy environment check for the private preview: runs the application's OWN validation (src/platform/env-validate.ts) against the environment it is given,
// and prints variable NAMES and problems only, never a value. Exit 0: valid. Exit 1: invalid. Use it as the host's build/pre-deploy step so a bad configuration
// (a service-level key, a database URL, a missing secret, an unset APP_ENV) stops the deploy before any traffic is served.
//   node scripts/check-env.mjs            (reads the current process environment)
// The health route (/health) answers 503 for the same condition at run time; this check fails earlier.
import { EnvError, loadEnv } from '../src/platform/env-validate.ts';
import { gateModeFrom } from '../src/platform/preview-gate.ts';

const mode = gateModeFrom(process.env.APP_ENV, process.env.PREVIEW_GATE);
try {
  const { warnings } = loadEnv(process.env, { scope: 'web' });
  console.log(`environment OK (gate: ${mode})`);
  for (const w of warnings) console.log(`warning: ${w}`);
  if (mode !== 'preview') console.log('note: the private-preview gate is OPEN in this environment (APP_ENV is local or ci); a deployment must run with the gate closed');
} catch (e) {
  if (!(e instanceof EnvError)) { console.error('environment check failed unexpectedly'); process.exit(1); }
  console.error(`environment INVALID (gate: ${mode}):`);
  for (const i of e.issues) console.error(`  ${i.name}: ${i.problem}`);
  process.exit(1);
}
