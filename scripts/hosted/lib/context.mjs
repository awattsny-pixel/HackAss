// The capability that allows any contact with a target. It can only be produced by creating a context from environment values that pass H0 (validateTargets);
// pg.mjs and http.mjs refuse to run without one. A context for the `staging` profile can only name the staging project; for `selftest` only the local stack.
import { validateTargets, REPO_ROOT } from './config.mjs';
import { registerSecret } from './redact.mjs';

const CAP = Symbol('hosted-context');
export class TargetRefused extends Error { constructor(errors) { super(`target validation failed (${errors.length}): ${errors.join('; ')}`); this.errors = errors; } }

export function createContext(rawEnv, { profile, repoRoot = REPO_ROOT, uid } = {}) {
  const { errors, targets } = validateTargets(rawEnv, { profile, repoRoot, uid });
  if (errors.length) throw new TargetRefused(errors);
  for (const k of ['STAGING_PUBLISHABLE_KEY', 'STAGING_SECRET_KEY']) registerSecret(rawEnv[k]);
  return Object.freeze({
    [CAP]: true, profile, targets,
    keys: Object.freeze(Object.fromEntries([['publishable', rawEnv.STAGING_PUBLISHABLE_KEY], ['secret', rawEnv.STAGING_SECRET_KEY]])),
  });
}
export function assertContext(ctx) {
  if (!ctx || ctx[CAP] !== true) throw new Error('no validated target context: nothing may be contacted before H0 passes');
  return ctx;
}
