import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// GET /api/admin/hacks - Fetch pending hacks for admin review
export async function GET(request: NextRequest) {
  try {
    // In production, you'd verify admin permissions here
    const { data: hacks, error } = await supabase
      .from('hacks')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ hacks });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to fetch pending hacks' },
      { status: 500 }
    );
  }
}
