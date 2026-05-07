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
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email, real_name, bio, website_url, avatar, profile_image_url, is_verified, followers_count, following_count')
      .eq('username', username)
      .single();

    if (error || !user) {
      return Response.json({ message: 'User not found' }, { status: 404 });
    }

    const { count: postsCount } = await supabase
      .from('hacks')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('status', 'approved');

    return Response.json({
      id: user.id,
      username: user.username,
      email: user.email,
      real_name: user.real_name,
      bio: user.bio,
      website_url: user.website_url,
      avatar: user.avatar,
      profile_image_url: user.profile_image_url,
      is_verified: user.is_verified,
      followers: user.followers_count || 0,
      following: user.following_count || 0,
      posts: postsCount || 0,
    });
  } catch (error) {
    console.error('Error:', error);
    return Response.json({ message: 'Server error' }, { status: 500 });
  }
}
