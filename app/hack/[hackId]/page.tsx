import { notFound } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import HackDetailContent from '@/app/components/HackDetail/HackDetailContent';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface HackDetailPageProps {
  params: Promise<{ hackId: string }>;
}

export default async function HackDetailPage({ params }: HackDetailPageProps) {
  const { hackId } = await params;

  // Fetch hack detail
  const { data: hack, error } = await supabase
    .from('hacks')
    .select(`
      id,
      title,
      description,
      category,
      difficulty,
      why_it_works,
      content_type,
      content_url,
      content_thumbnail,
      status,
      created_at,
      worked_votes,
      failed_votes,
      view_count,
      share_count,
      like_count,
      bookmark_count,
      user_id,
      source_attribution,
      users!inner (
        id,
        username,
        avatar,
        is_verified,
        real_name,
        bio
      )
    `)
    .eq('id', hackId)
    .eq('status', 'approved')
    .single();

  if (error || !hack) {
    notFound();
  }

  return (
    <div className="bg-black min-h-screen">
      <HackDetailContent hack={hack} />
    </div>
  );
}
