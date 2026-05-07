import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hackId: string }> }
) {
  try {
    const { hackId } = await params;
    console.log('[Comments GET] Starting fetch for hackId:', hackId);
    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '5');
    const offset = parseInt(searchParams.get('offset') || '0');

    console.log('[Comments GET] Fetching comments with limit:', limit, 'offset:', offset);

    // Fetch comments
    const { data: comments, error: commentsError } = await supabase
      .from('comments')
      .select('id, content, created_at, user_id')
      .eq('hack_id', hackId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (commentsError) {
      console.error('[Comments GET] Comments fetch error:', commentsError);
      throw new Error(`Failed to fetch comments: ${commentsError.message}`);
    }

    console.log('[Comments GET] Found', comments?.length || 0, 'comments');

    // Get total count for pagination
    const { count, error: countError } = await supabase
      .from('comments')
      .select('id', { count: 'exact', head: true })
      .eq('hack_id', hackId);

    if (countError) {
      console.error('[Comments GET] Count error:', countError);
      throw new Error(`Failed to get comment count: ${countError.message}`);
    }

    console.log('[Comments GET] Total count:', count);

    // Fetch user data for all comments
    const userIds = [...new Set((comments || []).map(c => c.user_id))];
    console.log('[Comments GET] Unique user IDs:', userIds.length);

    let users: any[] = [];

    // Only fetch users if there are comments with user IDs
    if (userIds.length > 0) {
      console.log('[Comments GET] Fetching user data for IDs:', userIds);
      const { data: usersData, error: usersError } = await supabase
        .from('users')
        .select('id, username, avatar, profile_image_url')
        .in('id', userIds);

      if (usersError) {
        console.error('[Comments GET] Users fetch error:', usersError);
        throw new Error(`Failed to fetch users: ${usersError.message}`);
      }
      users = usersData || [];
      console.log('[Comments GET] Fetched', users.length, 'users');
    }

    // Create user lookup
    const userMap = (users || []).reduce((acc: any, user: any) => {
      acc[user.id] = user;
      return acc;
    }, {});

    const hasMore = offset + limit < (count || 0);

    const responseData = {
      data: (comments || []).map(comment => {
        const user = userMap[comment.user_id];
        return {
          id: comment.id,
          content: comment.content,
          created_at: comment.created_at,
          user_id: comment.user_id,
          users: user ? {
            id: user.id,
            username: user.username,
            avatar: user.profile_image_url || user.avatar,
          } : {
            id: comment.user_id,
            username: 'Unknown',
            avatar: null,
          },
        };
      }),
      meta: {
        hasMore,
        total: count || 0,
        offset,
        limit,
      },
    };

    console.log('[Comments GET] Returning response with', responseData.data.length, 'comments');
    return NextResponse.json(responseData);
  } catch (error) {
    console.error('[Comments GET] Error:', error instanceof Error ? error.message : error);
    console.error('[Comments GET] Full error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Internal server error', details: message },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ hackId: string }> }
) {
  try {
    const { hackId } = await params;
    const body = await request.json();
    const { content } = body;

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

    // Validate content
    if (!content || content.trim().length === 0 || content.length > 500) {
      return NextResponse.json(
        { error: 'Comment must be 1-500 characters' },
        { status: 400 }
      );
    }

    // Insert comment
    const { data: newComment, error: insertError } = await supabase
      .from('comments')
      .insert({
        hack_id: hackId,
        user_id: userId,
        content: content.trim(),
      })
      .select(`
        id,
        content,
        created_at,
        users:user_id (
          id,
          username,
          avatar,
          is_verified
        )
      `)
      .single();

    if (insertError) {
      throw insertError;
    }

    return NextResponse.json({
      id: newComment.id,
      content: newComment.content,
      created_at: newComment.created_at,
      user_id: newComment.users.id,
      users: {
        id: newComment.users.id,
        username: newComment.users.username,
        avatar: newComment.users.avatar,
      },
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating comment:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
