import { serverDb } from '@/app/lib/supabase-server';
import { getApprovedHackList } from '@/app/lib/public-reads';

// GET /api/hacks - approved hacks only, explicit field allowlist
export async function GET() {
  return getApprovedHackList(serverDb());
}

// POST /api/hacks - Submit a new hack
// M01-A containment: unauthenticated writes disabled (fails closed, before any DB access).
export async function POST() {
  return Response.json(
    { error: 'temporarily_unavailable', message: 'This endpoint is temporarily unavailable.' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } }
  );
}
