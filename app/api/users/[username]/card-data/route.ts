import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ username: string }> }
) {
  try {
    const { username } = await params;

    // Get user data
    const { data: user } = await supabase
      .from('users')
      .select('id, username, avatar, profile_image_url, bio, is_verified')
      .eq('username', username)
      .single();

    if (!user) {
      return Response.json({ message: 'User not found' }, { status: 404 });
    }

    // Get user stats (followers, following, posts count)
    const { data: stats } = await supabase
      .from('user_stats')
      .select('followers, following, hacks_count')
      .eq('id', user.id)
      .single();

    // Get recent hacks
    const { data: recentHacks } = await supabase
      .from('hacks')
      .select('id, title, content_thumbnail')
      .eq('user_id', user.id)
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(6);

    // Check if current user is following (if authenticated)
    let isFollowing = false;
    const authHeader = request.headers.get('authorization');
    if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      const { data: authData } = await supabase
        .from('auth_tokens')
        .select('user_id')
        .eq('token', token)
        .single();

      if (authData) {
        const { data: followData } = await supabase
          .from('follows')
          .select('id')
          .eq('follower_id', authData.user_id)
          .eq('following_id', user.id)
          .single();
        isFollowing = !!followData;
      }
    }

    return Response.json({
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      profile_image_small_url: user.profile_image_url,
      is_verified: user.is_verified,
      bio: user.bio,
      posts: stats?.hacks_count || 0,
      followers: stats?.followers || 0,
      following: stats?.following || 0,
      recentHacks: (recentHacks || []).map(hack => ({
        id: hack.id,
        title: hack.title,
        content_thumbnail: hack.content_thumbnail,
      })),
      isFollowing,
    });
  } catch (error) {
    console.error('Error:', error);
    return Response.json({ message: 'Server error' }, { status: 500 });
  }
}
