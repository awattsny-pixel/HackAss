import EditProfileForm from './EditProfileForm';

interface EditProfilePageProps {
  params: Promise<{ username: string }>;
}

export default async function EditProfilePage({ params }: EditProfilePageProps) {
  const { username } = await params;

  return <EditProfileForm username={username} />;
}
