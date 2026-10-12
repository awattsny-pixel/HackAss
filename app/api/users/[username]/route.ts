import { serverDb } from '@/app/lib/supabase-server';
import { getPublicProfile } from '@/app/lib/public-reads';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ username: string }> }
) {
  const { username } = await params;
  return getPublicProfile(serverDb(), username);
}
