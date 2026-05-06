import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// POST /api/admin/hacks/[id]/approve - Approve or reject a hack
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { approved } = await request.json();
    const { id: hackId } = await params;

    if (typeof approved !== 'boolean') {
      return NextResponse.json(
        { error: 'Invalid approval data' },
        { status: 400 }
      );
    }

    // In production, you'd verify admin permissions here

    const newStatus = approved ? 'approved' : 'rejected';

    const { error } = await supabase
      .from('hacks')
      .update({ status: newStatus })
      .eq('id', hackId);

    if (error) {
      console.error('Supabase update error:', error);
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      message: `Hack ${newStatus} successfully`,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error('Approval endpoint error:', errorMessage);
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
