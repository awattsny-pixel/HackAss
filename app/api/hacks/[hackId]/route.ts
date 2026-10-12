import { serverDb } from '@/app/lib/supabase-server';
import { getPublicHack } from '@/app/lib/public-reads';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ hackId: string }> }
) {
  const { hackId } = await params;
  return getPublicHack(serverDb(), hackId);
}
