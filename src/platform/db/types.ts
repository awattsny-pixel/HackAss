// Database access boundaries. The application runtime has exactly three ways to reach the database, and none of them
// is the Supabase service key. These are opaque, branded handles so a module cannot confuse one mode for another.
import type { SupabaseClient } from '@supabase/supabase-js';

export type PublicDb = { readonly kind: 'public'; readonly client: SupabaseClient };
export type UserDb = { readonly kind: 'user'; readonly client: SupabaseClient };
export type WorkerDb = { readonly kind: 'worker'; call(fn: WorkerFunction, args: readonly unknown[]): Promise<readonly Record<string, unknown>[]> };

/**
 * The complete list of database functions the worker role may execute (schema `worker`). The worker has no table
 * access, so this list is also the list of everything it can do. Keep it in step with the F2 grant allowlist.
 */
export const WORKER_FUNCTIONS = [
  'claim_jobs', 'heartbeat', 'complete_job', 'fail_job', 'release_job', 'get_job_subject',
  'reserve_ai_budget', 'settle_ai_budget', 'record_ai_evaluation', 'record_shadow_decision',
  'record_automated_decision', 'publish_automated', 'mark_invalidated', 'enqueue_followup',
] as const;
export type WorkerFunction = (typeof WORKER_FUNCTIONS)[number];

/** Anything that can run a parameterized query (a `pg` Pool satisfies this). Injected so no driver is bundled yet. */
export interface SqlRunner {
  query(text: string, values: readonly unknown[]): Promise<{ rows: readonly Record<string, unknown>[] }>;
}

/** Cookie access supplied by the framework; the SSR client reads and writes the session through it. */
export interface CookieAdapter {
  getAll(): { name: string; value: string }[];
  setAll(cookies: { name: string; value: string; options?: Record<string, unknown> }[]): void;
}
