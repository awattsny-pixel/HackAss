import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ hackId: string }> }
) {
  try {
    const { hackId } = await params;

    // Get current user from auth header
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const token = authHeader.replace('Bearer ', '');

    // Look up user by token
    const { data: authTokenData, error: tokenError } = await supabase
      .from('auth_tokens')
      .select('user_id')
      .eq('token', token)
      .single();

    if (tokenError || !authTokenData) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const userId = authTokenData.user_id;

    // Check if bookmark already exists
    const { data: existingBookmark } = await supabase
      .from('bookmarks')
      .select('id')
      .eq('hack_id', hackId)
      .eq('user_id', userId)
      .single();

    if (existingBookmark) {
      // Remove bookmark
      const { error: removeError } = await supabase
        .from('bookmarks')
        .delete()
        .eq('hack_id', hackId)
        .eq('user_id', userId);

      if (removeError) {
        throw removeError;
      }

      // Get updated bookmark count
      const { data: hack, error: fetchError } = await supabase
        .from('hacks')
        .select('bookmark_count')
        .eq('id', hackId)
        .single();

      if (fetchError) {
        throw fetchError;
      }

      return NextResponse.json({
        data: {
          bookmarked: false,
          bookmark_count: hack?.bookmark_count || 0,
        },
      });
    } else {
      // Add bookmark
      const { error: bookmarkError } = await supabase
        .from('bookmarks')
        .insert({
          hack_id: hackId,
          user_id: userId,
        });

      if (bookmarkError) {
        throw bookmarkError;
      }

      // Get updated bookmark count
      const { data: hack, error: fetchError } = await supabase
        .from('hacks')
        .select('bookmark_count')
        .eq('id', hackId)
        .single();

      if (fetchError) {
        throw fetchError;
      }

      return NextResponse.json({
        data: {
          bookmarked: true,
          bookmark_count: hack?.bookmark_count || 0,
        },
      });
    }
  } catch (error) {
    console.error('Error toggling bookmark:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
