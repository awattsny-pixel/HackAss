import { notFound } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import ProfileHeader from './ProfileHeader';
import ProfileTabs from './ProfileTabs';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface ProfilePageProps {
  params: Promise<{ username: string }>;
}

export default async function ProfilePage({ params }: ProfilePageProps) {
  const { username } = await params;

  // Fetch user profile data - try user_stats first, fall back to users table
  const { data: userStats, error: statsError } = await supabase
    .from('user_stats')
    .select('*')
    .eq('username', username)
    .single();

  let userData = userStats;

  // If user_stats doesn't have the user, fetch from users table
  if (statsError || !userStats) {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select(`
        id,
        username,
        real_name,
        bio,
        is_verified,
        avatar,
        profile_image_url,
        followers_count,
        following_count
      `)
      .eq('username', username)
      .single();

    if (userError || !user) {
      notFound();
    }

    // Get post count from hacks table
    const { count: postsCount } = await supabase
      .from('hacks')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('status', 'approved');

    userData = {
      id: user.id,
      username: user.username,
      real_name: user.real_name,
      bio: user.bio,
      is_verified: user.is_verified,
      avatar: user.avatar,
      profile_image_url: user.profile_image_url,
      followers: user.followers_count || 0,
      following: user.following_count || 0,
      posts: postsCount || 0,
    };
  }

  if (!userData) {
    notFound();
  }

  return (
    <div className="bg-black min-h-screen text-white">
      {/* Profile Header */}
      <ProfileHeader user={userData} />

      {/* Tabs Section */}
      <ProfileTabs username={username} />
    </div>
  );
}
