import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// POST /api/hacks/[hackId]/validate - Record a user's validation vote
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ hackId: string }> }
) {
  try {
    const { worked } = await request.json();
    const { hackId } = await params;

    if (typeof worked !== 'boolean') {
      return NextResponse.json(
        { error: 'Invalid validation data' },
        { status: 400 }
      );
    }

    // Fetch current values with defaults for NULL columns
    const { data: hacks } = await supabase
      .from('hacks')
      .select('worked_votes, failed_votes, unique_users_who_validated')
      .eq('id', hackId);

    if (!hacks || hacks.length === 0) {
      return NextResponse.json(
        { error: 'Hack not found' },
        { status: 404 }
      );
    }

    const hack = hacks[0];
    const worked_votes = (hack.worked_votes || 0) + (worked ? 1 : 0);
    const failed_votes = (hack.failed_votes || 0) + (worked ? 0 : 1);
    const unique_users = (hack.unique_users_who_validated || 0) + 1;

    const { error: updateError } = await supabase
      .from('hacks')
      .update({
        worked_votes,
        failed_votes,
        unique_users_who_validated: unique_users,
      })
      .eq('id', hackId);

    if (updateError) {
      console.error('Update error:', updateError);
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      message: 'Validation recorded',
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to record validation' },
      { status: 500 }
    );
  }
}
