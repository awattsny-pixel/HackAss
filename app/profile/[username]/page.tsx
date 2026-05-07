import ProfilePage from '@/app/components/Profile/ProfilePage';

interface ProfileRouteProps {
  params: Promise<{ username: string }>;
}

export default async function ProfileRoute({ params }: ProfileRouteProps) {
  return <ProfilePage params={params} />;
}
