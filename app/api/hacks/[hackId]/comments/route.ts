import { serverDb } from '@/app/lib/supabase-server';
import { listPublicComments } from '@/app/lib/public-reads';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ hackId: string }> }
) {
  const { hackId } = await params;
  return listPublicComments(serverDb(), hackId, new URL(request.url).searchParams);
}

// M01-A containment: bespoke-token writes disabled (fails closed, before any DB access).
export async function POST() {
  return Response.json(
    { error: 'temporarily_unavailable', message: 'This endpoint is temporarily unavailable.' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } }
  );
}
