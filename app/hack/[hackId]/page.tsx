import { notFound } from 'next/navigation';
import HackDetailContent from '@/app/components/HackDetail/HackDetailContent';
import { serverDb } from '@/app/lib/supabase-server';
import { loadPublicHackPage } from '@/app/lib/public-reads';

interface HackDetailPageProps {
  params: Promise<{ hackId: string }>;
}

export default async function HackDetailPage({ params }: HackDetailPageProps) {
  const { hackId } = await params;

  // Approved hacks only, explicit public projection (no status, real_name, bio).
  const hack = await loadPublicHackPage(serverDb(), hackId);
  if (!hack) {
    notFound();
  }

  return (
    <div className="bg-black min-h-screen">
      <HackDetailContent hack={hack as unknown as React.ComponentProps<typeof HackDetailContent>['hack']} />
    </div>
  );
}
