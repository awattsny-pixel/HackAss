// Client factories for the three database modes. There is deliberately no factory for a service-level client.
//
// STATUS: createUserDb is an EXPERIMENT. It follows the server-centric design in the foundation document (the browser
// never holds a Supabase client). It is not used by any route and has not been validated against a real Auth flow;
// do not treat the HttpOnly-cookie approach as proven until the F1 Auth spike passes against a real Supabase stack.
import 'server-only'; // Next.js fails the build if a Client Component ever imports this module
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import type { PublicEnv } from '../env-validate.ts';
import { WORKER_FUNCTIONS, type CookieAdapter, type DbClientOptions, type PublicDb, type SqlRunner, type UserDb, type WorkerDb, type WorkerFunction } from './types.ts';

export function createPublicDb(env: Pick<PublicEnv, 'supabaseUrl' | 'supabasePublishableKey'>, opts: DbClientOptions = {}): PublicDb {
  const client = createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(opts.fetch ? { global: { fetch: opts.fetch } } : {}),
  });
  return { kind: 'public', client };
}

/** Session cookie lifetime. PROVISIONAL: it matches the pilot's proposed 7-day overall session limit; enforcement of that limit is the Auth provider's and is not yet confirmed. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function createUserDb(env: PublicEnv, cookies: CookieAdapter, opts: DbClientOptions = {}): UserDb {
  const client = createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    // The library writes its own long default lifetime on the session cookies; cap every positive lifetime so the cookie never outlives the provisional session limit.
    cookies: { getAll: () => cookies.getAll(), setAll: (list) => cookies.setAll(list.map((c) => (typeof c.options?.maxAge === 'number' && c.options.maxAge > SESSION_COOKIE_MAX_AGE_SECONDS ? { ...c, options: { ...c.options, maxAge: SESSION_COOKIE_MAX_AGE_SECONDS } } : c))) },
    cookieOptions: { httpOnly: true, secure: env.appEnv === 'staging' || env.appEnv === 'production', sameSite: 'lax', path: '/', maxAge: SESSION_COOKIE_MAX_AGE_SECONDS },
    ...(opts.fetch ? { global: { fetch: opts.fetch } } : {}),
  });
  return { kind: 'user', client };
}

const FN_SET: ReadonlySet<string> = new Set(WORKER_FUNCTIONS);
const MAX_ARGS = 12;

/** Calls `worker.<fn>($1..$n)` for allow-listed functions only. No caller-supplied SQL ever reaches the runner. */
export function createWorkerDb(runner: SqlRunner): WorkerDb {
  return {
    kind: 'worker',
    async call(fn: WorkerFunction, args: readonly unknown[]) {
      if (!FN_SET.has(fn)) throw new Error('worker function is not allow-listed');
      if (args.length > MAX_ARGS) throw new Error('too many arguments');
      const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
      const result = await runner.query(`select * from worker.${fn}(${placeholders})`, args);
      return result.rows;
    },
  };
}
