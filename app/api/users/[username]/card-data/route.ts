import { serverDb } from '@/app/lib/supabase-server';
import { getCardData } from '@/app/lib/public-reads';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ username: string }> }
) {
  const { username } = await params;
  return getCardData(serverDb(), username);
}
