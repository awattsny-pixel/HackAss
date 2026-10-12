import { notFound } from 'next/navigation';
import ProfileHeader from './ProfileHeader';
import ProfileTabs from './ProfileTabs';
import { serverDb } from '@/app/lib/supabase-server';
import { loadPublicProfilePage } from '@/app/lib/public-reads';

interface ProfilePageProps {
  params: Promise<{ username: string }>;
}

export default async function ProfilePage({ params }: ProfilePageProps) {
  const { username } = await params;

  // Explicit public projection (no select('*') from user_stats; no real_name, bio, website_url).
  const userData = await loadPublicProfilePage(serverDb(), username);
  if (!userData) {
    notFound();
  }

  return (
    <div className="bg-black min-h-screen text-white">
      {/* Profile Header */}
      <ProfileHeader user={userData as unknown as React.ComponentProps<typeof ProfileHeader>['user']} />

      {/* Tabs Section */}
      <ProfileTabs username={username} />
    </div>
  );
}
