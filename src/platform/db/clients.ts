// Client factories for the three database modes. There is deliberately no factory for a service-level client.
//
// STATUS: createUserDb is an EXPERIMENT. It follows the server-centric design in the foundation document (the browser
// never holds a Supabase client). It is not used by any route and has not been validated against a real Auth flow;
// do not treat the HttpOnly-cookie approach as proven until the F1 Auth spike passes against a real Supabase stack.
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import type { PublicEnv } from '../env.ts';
import { WORKER_FUNCTIONS, type CookieAdapter, type PublicDb, type SqlRunner, type UserDb, type WorkerDb, type WorkerFunction } from './types.ts';

export function createPublicDb(env: Pick<PublicEnv, 'supabaseUrl' | 'supabasePublishableKey'>): PublicDb {
  const client = createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return { kind: 'public', client };
}

export function createUserDb(env: PublicEnv, cookies: CookieAdapter): UserDb {
  const client = createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookies: { getAll: () => cookies.getAll(), setAll: (list) => cookies.setAll(list) },
    cookieOptions: { httpOnly: true, secure: env.appEnv === 'staging' || env.appEnv === 'production', sameSite: 'lax', path: '/' },
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
