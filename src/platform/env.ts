// SERVER-ONLY environment access. This is the ONLY place in src/ that reads process.env (enforced by ESLint), and the
// `server-only` import makes Next.js fail the build if this module is ever pulled into a Client Component. The
// validation logic itself is pure and lives in ./env-validate.ts.
import 'server-only';
import { loadEnv } from './env-validate.ts';
import { gateModeFrom } from './preview-gate.ts';
import type { GateMode } from './preview-gate.ts';
import type { EnvScope, LoadedEnv, ServerEnv } from './env-validate.ts';

export { loadEnv, EnvError, LEGACY_SERVICE_ENV_TOLERATED } from './env-validate.ts';
export type { AppEnvName, EnvScope, LoadedEnv, PublicEnv, ServerEnv, TrustedClientIp } from './env-validate.ts';

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

/** The mode the private-preview gate was BUILT in (next.config.js inlines it at build time); 'unknown' if the build predates the gate. */
export function builtGateMode(): GateMode | 'unknown' { const v = process.env.PX_BUILT_GATE; return v === 'preview' || v === 'open' ? v : 'unknown'; }
/** The mode this process's environment asks for (staging, production, unset and invalid APP_ENV all mean preview). */
export function runtimeGateMode(): GateMode { return gateModeFrom(process.env.APP_ENV, process.env.PREVIEW_GATE); }
/** Whether this build was made with the origin lock (the shared-secret edge header); 'unknown' if the build predates it. */
export function builtEdgeLock(): 'on' | 'off' | 'unknown' { const v = process.env.PX_BUILT_EDGE_LOCK; return v === 'on' || v === 'off' ? v : 'unknown'; }
/** True for staging/production: the environments in which the origin lock is mandatory. */
export function edgeLockRequired(): boolean { return process.env.APP_ENV === 'staging' || process.env.APP_ENV === 'production'; }
