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

    // Check if like already exists
    const { data: existingLike } = await supabase
      .from('likes')
      .select('id')
      .eq('hack_id', hackId)
      .eq('user_id', userId)
      .single();

    if (existingLike) {
      // Unlike: delete the like
      const { error: unlikeError } = await supabase
        .from('likes')
        .delete()
        .eq('hack_id', hackId)
        .eq('user_id', userId);

      if (unlikeError) {
        throw unlikeError;
      }

      // Get updated like count
      const { data: hack, error: fetchError } = await supabase
        .from('hacks')
        .select('like_count')
        .eq('id', hackId)
        .single();

      if (fetchError) {
        throw fetchError;
      }

      return NextResponse.json({
        data: {
          liked: false,
          like_count: hack?.like_count || 0,
        },
      });
    } else {
      // Like: insert new like
      const { error: likeError } = await supabase
        .from('likes')
        .insert({
          hack_id: hackId,
          user_id: userId,
        });

      if (likeError) {
        throw likeError;
      }

      // Get updated like count
      const { data: hack, error: fetchError } = await supabase
        .from('hacks')
        .select('like_count')
        .eq('id', hackId)
        .single();

      if (fetchError) {
        throw fetchError;
      }

      return NextResponse.json({
        data: {
          liked: true,
          like_count: hack?.like_count || 0,
        },
      });
    }
  } catch (error) {
    console.error('Error toggling like:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
