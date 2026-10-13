// SERVER-ONLY environment access. This is the ONLY place in src/ that reads process.env (enforced by ESLint), and the
// `server-only` import makes Next.js fail the build if this module is ever pulled into a Client Component. The
// validation logic itself is pure and lives in ./env-validate.ts.
import 'server-only';
import { loadEnv } from './env-validate.ts';
import type { EnvScope, LoadedEnv, ServerEnv } from './env-validate.ts';

export { loadEnv, EnvError, LEGACY_SERVICE_ENV_TOLERATED } from './env-validate.ts';
export type { AppEnvName, EnvScope, LoadedEnv, PublicEnv, ServerEnv } from './env-validate.ts';

// One validated result per scope: a successful 'web' load must never satisfy a later 'worker' request, because the
// worker scope has extra requirements (WORKER_DATABASE_URL). Failures are not cached.
const cache = new Map<EnvScope, LoadedEnv>();
/** Reads and validates process.env once per scope (lazily, so importing this file never fails a build). */
export function getEnv(scope: EnvScope = 'web'): ServerEnv {
  let loaded = cache.get(scope);
  if (!loaded) { loaded = loadEnv(process.env, { scope }); cache.set(scope, loaded); }
  return loaded.env;
}
/** Test seam only. */
export function resetEnvCacheForTests(): void { cache.clear(); }
