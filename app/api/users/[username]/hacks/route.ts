import { serverDb } from '@/app/lib/supabase-server';
import { listUserHacks } from '@/app/lib/public-reads';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ username: string }> }
) {
  const { username } = await params;
  return listUserHacks(serverDb(), username, new URL(request.url).searchParams);
}
