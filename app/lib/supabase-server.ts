import { createClient } from '@supabase/supabase-js';

// Created per request so importing a route never reads env or opens a client.
// Same privilege as before (service role); moving public reads off it is an M01 RLS task.
export function serverDb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}
