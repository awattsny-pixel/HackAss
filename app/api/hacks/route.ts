import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

// Use service role key if available (server-side), otherwise fallback to anon key
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// GET /api/hacks - Fetch approved hacks for the feed
export async function GET(request: NextRequest) {
  try {
    const { data: hacks, error } = await supabase
      .from('hacks')
      .select('*')
      .eq('status', 'approved')
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ hacks });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to fetch hacks' },
      { status: 500 }
    );
  }
}

// POST /api/hacks - Submit a new hack
// M01-A containment: unauthenticated writes disabled (fails closed, before any DB access).
export async function POST() {
  return Response.json(
    { error: 'temporarily_unavailable', message: 'This endpoint is temporarily unavailable.' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } }
  );
}
