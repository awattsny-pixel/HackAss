// PURE environment validation: takes a plain object and returns typed configuration or throws EnvError. It reads
// nothing from the process and imports no server-only module, so it is unit-testable anywhere. The server-only reader
// (the only code that touches process.env) is ./env.ts. Validation reports variable NAMES and problems, never
// values, so a bad deployment cannot leak a secret into logs or error pages.
import { z } from 'zod';
import { EDGE_LOCK_SECRET_PATTERN, gateModeFrom } from './preview-gate.ts';

export type AppEnvName = 'local' | 'ci' | 'staging' | 'production';
export type EnvScope = 'web' | 'worker';

export interface PublicEnv {
  readonly appEnv: AppEnvName;
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
  readonly appOrigin: string;
}
/** Where the client address may be read from (see src/modules/identity/throttle.ts). Never taken from a client-controlled header unless the operator names one. */
export type TrustedClientIp = { readonly kind: 'none' } | { readonly kind: 'header'; readonly name: string } | { readonly kind: 'forwarded-for'; readonly trustedHops: number };
export interface ServerEnv extends PublicEnv {
  readonly cursorSigningSecret: string;
  /** Keys the hashes of client addresses and emails in the auth throttle. Null when unset: the auth handlers then refuse to run (fail closed). */
  readonly authThrottleSecret: string | null;
  /** Signs the short-lived "set your password first" marker (a UX consistency rule, not an authorization boundary). */
  readonly authSetupMarkerSecret: string | null;
  readonly trustedClientIp: TrustedClientIp;
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

/** Names that must be ABSENT from a private-preview web environment: the preview talks to the database only through the member's own session, so it never holds a service-level key, a worker URL or a database URL. */
export const PREVIEW_FORBIDDEN_NAMES: readonly string[] = Object.freeze([
  'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_DB_URL', 'WORKER_DATABASE_URL', 'JOB_ENDPOINT_SECRET', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING',
]);

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
  // The private-preview gate decides the mode (staging, production, unset and invalid APP_ENV all fail closed into preview). In preview mode the legacy service-level names are NOT tolerated.
  const gate = gateModeFrom(source.APP_ENV, source.PREVIEW_GATE);
  const preview = scope === 'web' && gate === 'preview';
  const legacy = preview ? 'forbid' : (opts.legacy ?? (LEGACY_SERVICE_ENV_TOLERATED ? 'tolerate' : 'forbid'));
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

  // 1b. Private preview: names that must be absent, and the gate switch itself.
  const gateSwitch = get('PREVIEW_GATE');
  if (gateSwitch !== undefined && gateSwitch !== 'on' && gateSwitch !== 'off') add('PREVIEW_GATE', 'must be on or off');
  if (gateSwitch === 'off' && source.APP_ENV !== 'local' && source.APP_ENV !== 'ci') add('PREVIEW_GATE', 'may be off only when APP_ENV is local or ci');
  if (preview) for (const name of PREVIEW_FORBIDDEN_NAMES) if (get(name) !== undefined && !issues.some((i) => i.name === name)) add(name, 'must not be set in a private-preview web environment');

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
  const authThrottleSecret = secret('AUTH_THROTTLE_SECRET', false);
  const authSetupMarkerSecret = secret('AUTH_SETUP_MARKER_SECRET', false);
  // Client address source: at most one of a named header (set by infrastructure we control) or a count of trusted proxy hops.
  let trustedClientIp: TrustedClientIp = { kind: 'none' };
  const ipHeader = get('TRUSTED_CLIENT_IP_HEADER'); const ipHops = get('TRUSTED_PROXY_HOPS');
  if (ipHeader && ipHops) add('TRUSTED_CLIENT_IP_HEADER', 'set either TRUSTED_CLIENT_IP_HEADER or TRUSTED_PROXY_HOPS, not both');
  else if (ipHeader) { if (/^[a-z0-9-]{1,64}$/i.test(ipHeader)) trustedClientIp = { kind: 'header', name: ipHeader.toLowerCase() }; else add('TRUSTED_CLIENT_IP_HEADER', 'must be a plain header name'); }
  else if (ipHops) { const n = Number(ipHops); if (Number.isInteger(n) && n >= 1 && n <= 5) trustedClientIp = { kind: 'forwarded-for', trustedHops: n }; else add('TRUSTED_PROXY_HOPS', 'must be an integer from 1 to 5'); }

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

  // 7. Private preview requirements: the throttle and the setup marker are keyed, and the client address has a declared source (otherwise every tester would share one bucket and could lock the others out).
  if (preview) {
    if (!authThrottleSecret) add('AUTH_THROTTLE_SECRET', 'is required in a private-preview environment (sign-in and saved-work writes fail closed without it)');
    if (!authSetupMarkerSecret) add('AUTH_SETUP_MARKER_SECRET', 'is required in a private-preview environment');
    // The origin lock: mandatory in staging/production. The VALUE is compiled into the build (next.config.js); here it is only checked to be present and well-formed so a deployment cannot go out without it.
    const edgeLock = get('EDGE_LOCK_SECRET');
    if (edgeLock !== undefined && !EDGE_LOCK_SECRET_PATTERN.test(edgeLock)) add('EDGE_LOCK_SECRET', 'must be 32 to 128 characters of A-Z a-z 0-9 _ -');
    if (edgeLock === undefined && (appEnv === 'staging' || appEnv === 'production')) add('EDGE_LOCK_SECRET', 'is required in staging and production (the origin lock: the edge adds it as a header, the build refuses requests without it)');
    if (trustedClientIp.kind === 'none') add('TRUSTED_CLIENT_IP_HEADER', 'set TRUSTED_CLIENT_IP_HEADER or TRUSTED_PROXY_HOPS in a private-preview environment');
  }

  if (issues.length) throw new EnvError(issues);
  return {
    env: { appEnv, supabaseUrl, supabasePublishableKey: publishable as string, appOrigin, cursorSigningSecret: cursorSigningSecret as string, authThrottleSecret, authSetupMarkerSecret, trustedClientIp, jobEndpointSecret, workerDatabaseUrl },
    warnings,
  };
}
