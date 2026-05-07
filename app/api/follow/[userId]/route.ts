import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(
  request: NextRequest,
  { params }: { params: { userId: string } }
) {
  try {
    const { userId } = params;

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

    const followerId = authTokenData.user_id;

    // Don't allow following yourself
    if (followerId === userId) {
      return NextResponse.json(
        { error: 'Cannot follow yourself' },
        { status: 400 }
      );
    }

    // Check if follow relationship already exists
    const { data: existingFollow } = await supabase
      .from('follows')
      .select('id')
      .eq('follower_id', followerId)
      .eq('following_id', userId)
      .single();

    if (existingFollow) {
      return NextResponse.json(
        { error: 'Already following this user' },
        { status: 400 }
      );
    }

    // Create follow relationship
    const { error: followError } = await supabase
      .from('follows')
      .insert({
        follower_id: followerId,
        following_id: userId,
      });

    if (followError) {
      throw followError;
    }

    // Get updated follower count
    const { data: updatedUser, error: fetchError } = await supabase
      .from('user_stats')
      .select('followers, following')
      .eq('id', userId)
      .single();

    if (fetchError) {
      throw fetchError;
    }

    return NextResponse.json({
      data: {
        success: true,
        followers: updatedUser?.followers || 0,
        following: updatedUser?.following || 0,
      },
    });
  } catch (error) {
    console.error('Error following user:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { userId: string } }
) {
  try {
    const { userId } = params;

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

    const followerId = authTokenData.user_id;

    // Delete follow relationship
    const { error: unfollowError } = await supabase
      .from('follows')
      .delete()
      .eq('follower_id', followerId)
      .eq('following_id', userId);

    if (unfollowError) {
      throw unfollowError;
    }

    // Get updated follower count
    const { data: updatedUser, error: fetchError } = await supabase
      .from('user_stats')
      .select('followers, following')
      .eq('id', userId)
      .single();

    if (fetchError) {
      throw fetchError;
    }

    return NextResponse.json({
      data: {
        success: true,
        followers: updatedUser?.followers || 0,
        following: updatedUser?.following || 0,
      },
    });
  } catch (error) {
    console.error('Error unfollowing user:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
