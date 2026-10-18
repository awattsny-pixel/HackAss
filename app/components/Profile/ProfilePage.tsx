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
  const result = await loadPublicProfilePage(serverDb(), username);
  if (result.status === 'not_found') {
    notFound();
  }
  if (result.status === 'error') {
    // A database failure is not "not found": surface the error boundary (generic message, no details).
    throw new Error('This page is temporarily unavailable.');
  }

  return (
    <div className="bg-black min-h-screen text-white">
      {/* Profile Header */}
      <ProfileHeader user={result.data as unknown as React.ComponentProps<typeof ProfileHeader>['user']} />

      {/* Tabs Section */}
      <ProfileTabs username={username} />
    </div>
  );
}
