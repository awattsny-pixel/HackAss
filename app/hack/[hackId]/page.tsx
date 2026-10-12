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
  const result = await loadPublicHackPage(serverDb(), hackId);
  if (result.status === 'not_found') {
    notFound();
  }
  if (result.status === 'error') {
    // A database failure is not "not found": surface the error boundary (generic message, no details).
    throw new Error('This page is temporarily unavailable.');
  }

  return (
    <div className="bg-black min-h-screen">
      <HackDetailContent hack={result.data as unknown as React.ComponentProps<typeof HackDetailContent>['hack']} />
    </div>
  );
}
