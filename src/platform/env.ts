// Validated environment configuration. This file is the ONLY place in src/ that reads process.env (enforced by
// ESLint). Validation reports variable NAMES and problems, never values, so a bad deployment cannot leak a secret
// into logs or error pages.
import { z } from 'zod';

export type AppEnvName = 'local' | 'ci' | 'staging' | 'production';
export type EnvScope = 'web' | 'worker';

export interface PublicEnv {
  readonly appEnv: AppEnvName;
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
  readonly appOrigin: string;
}
export interface ServerEnv extends PublicEnv {
  readonly cursorSigningSecret: string;
  readonly jobEndpointSecret: string | null;
  readonly workerDatabaseUrl: string | null;
}
export interface LoadedEnv {
  readonly env: ServerEnv;
  /** Non-fatal findings, e.g. legacy variables still tolerated while legacy routes exist. Names only. */
  readonly warnings: readonly string[];
}

export class EnvError extends Error {
  readonly issues: readonly { name: string; problem: string }[];
  constructor(issues: readonly { name: string; problem: string }[]) {
    super(`Invalid environment configuration: ${issues.map((i) => `${i.name}: ${i.problem}`).join('; ')}`);
    this.name = 'EnvError';
    this.issues = issues;
  }
}

/**
 * The legacy read routes still need the old service-role variable names until slice F5 replaces them. While this is
 * true those names produce a WARNING; once it is false they are a hard error. tests/platform-env.test.ts fails if
 * this constant is still true after the last legacy importer is gone (and vice versa), so the exception cannot linger.
 */
export const LEGACY_SERVICE_ENV_TOLERATED = true;

const FORBIDDEN_NAME = /(SERVICE_ROLE|SERVICE_KEY|SERVICE_SECRET|SUPABASE_SECRET|JWT_SECRET)/i;
const SECRETISH_PUBLIC_NAME = /(SECRET|SERVICE|PRIVATE|PASSWORD|PASSWD|TOKEN|WORKER|DATABASE)/i;
const LEGACY_NAMES = new Set(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_URL']);

const appEnvSchema = z.enum(['local', 'ci', 'staging', 'production']);
const isLocalHost = (u: URL) => u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';

function decodeJwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const json = JSON.parse(new TextDecoder().decode(bytes));
    return typeof json?.role === 'string' ? json.role : null;
  } catch { return null; }
}

const isServiceLevelKey = (v: string): boolean => v.startsWith('sb_secret_') || decodeJwtRole(v) === 'service_role';

export function loadEnv(
  source: Readonly<Record<string, string | undefined>>,
  opts: { scope?: EnvScope; legacy?: 'tolerate' | 'forbid' } = {},
): LoadedEnv {
  const scope = opts.scope ?? 'web';
  const legacy = opts.legacy ?? (LEGACY_SERVICE_ENV_TOLERATED ? 'tolerate' : 'forbid');
  const issues: { name: string; problem: string }[] = [];
  const warnings: string[] = [];
  const add = (name: string, problem: string) => issues.push({ name, problem });
  const get = (name: string) => { const v = source[name]; return v === undefined || v === '' ? undefined : v; };

  // 1. Names that must never exist in an application environment, and public names that look secret.
  for (const name of Object.keys(source)) {
    if (source[name] === undefined || source[name] === '') continue;
    if (FORBIDDEN_NAME.test(name)) {
      if (legacy === 'tolerate' && LEGACY_NAMES.has(name)) warnings.push(`${name} is a legacy service credential name; it must be removed when legacy routes are retired`);
      else add(name, 'service-level credentials must not be present in an application environment');
    }
    if (name.startsWith('NEXT_PUBLIC_') && SECRETISH_PUBLIC_NAME.test(name.slice('NEXT_PUBLIC_'.length))) add(name, 'a NEXT_PUBLIC_ variable must not carry secret material');
    // NEXT_PUBLIC_ values are inlined into the browser bundle, so no such variable may HOLD a service-level key,
    // whatever it is called and whether or not anything reads it (an unused legacy value still ships).
    if (name.startsWith('NEXT_PUBLIC_') && isServiceLevelKey(source[name] as string)) add(name, 'holds a service-level key; only a publishable/anon key may be public');
  }

  // 2. App environment name
  const appEnvParsed = appEnvSchema.safeParse(get('APP_ENV'));
  if (!appEnvParsed.success) add('APP_ENV', 'must be one of local, ci, staging, production');
  const appEnv = appEnvParsed.success ? appEnvParsed.data : 'local';
  const strict = appEnv === 'staging' || appEnv === 'production';

  // 3. URLs
  const urlVar = (name: string, requireOrigin: boolean): string => {
    const raw = get(name);
    if (!raw) { add(name, 'is required'); return ''; }
    let u: URL;
    try { u = new URL(raw); } catch { add(name, 'must be a valid URL'); return ''; }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !strict && isLocalHost(u))) add(name, strict ? 'must use https' : 'must use https (http is allowed only for localhost in local/ci)');
    if (u.username || u.password) add(name, 'must not embed credentials');
    if (requireOrigin && (u.pathname !== '/' || u.search || u.hash)) add(name, 'must be an origin only (no path, query or fragment)');
    return requireOrigin ? u.origin : raw.replace(/\/+$/, '');
  };
  const supabaseUrl = urlVar('NEXT_PUBLIC_SUPABASE_URL', false);
  const appOrigin = urlVar('APP_ORIGIN', true);

  // 4. Public key: new name preferred, legacy anon name accepted; never a service-level key.
  // Both names are validated (see the NEXT_PUBLIC_ loop above), not just the one that is used.
  const publishable = get('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY') ?? get('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (!publishable) add('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'is required (the legacy NEXT_PUBLIC_SUPABASE_ANON_KEY name is also accepted)');

  // 5. Server secrets
  const secret = (name: string, required: boolean): string | null => {
    const v = get(name);
    if (!v) { if (required) add(name, 'is required'); return null; }
    if (v.length < 32) add(name, 'must be at least 32 characters');
    return v;
  };
  const cursorSigningSecret = secret('CURSOR_SIGNING_SECRET', true);
  const jobEndpointSecret = secret('JOB_ENDPOINT_SECRET', false);

  // 6. Worker database URL: the dedicated role only, never a general or privileged one.
  let workerDatabaseUrl: string | null = null;
  const wdu = get('WORKER_DATABASE_URL');
  if (!wdu) { if (scope === 'worker') add('WORKER_DATABASE_URL', 'is required for the worker'); }
  else {
    try {
      const u = new URL(wdu);
      if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') add('WORKER_DATABASE_URL', 'must be a postgres:// URL');
      else if (!/^hackass_worker(\.|$)/.test(decodeURIComponent(u.username))) add('WORKER_DATABASE_URL', 'must connect as the dedicated hackass_worker role');
      else if (!u.password) add('WORKER_DATABASE_URL', 'must include the role password');
      else workerDatabaseUrl = wdu;
    } catch { add('WORKER_DATABASE_URL', 'must be a valid URL'); }
  }

  if (issues.length) throw new EnvError(issues);
  return {
    env: { appEnv, supabaseUrl, supabasePublishableKey: publishable as string, appOrigin, cursorSigningSecret: cursorSigningSecret as string, jobEndpointSecret, workerDatabaseUrl },
    warnings,
  };
}

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
