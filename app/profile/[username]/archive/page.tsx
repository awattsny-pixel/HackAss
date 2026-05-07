import { notFound } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import Image from 'next/image';
import Link from 'next/link';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface Hack {
  id: string;
  title: string;
  description: string;
  category: string;
  content_type: string;
  content_thumbnail: string;
  created_at: string;
}

interface ArchivePageProps {
  params: Promise<{ username: string }>;
}

export default async function ArchivePage({ params }: ArchivePageProps) {
  const { username } = await params;

  // Get user by username
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id')
    .eq('username', username)
    .single();

  if (userError || !user) {
    notFound();
  }

  // Get archived hacks
  const { data: archivedHacks, error: hacksError } = await supabase
    .from('archive')
    .select(`
      hack_id,
      hacks (
        id,
        title,
        description,
        category,
        content_type,
        content_thumbnail,
        created_at
      )
    `)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (hacksError) {
    notFound();
  }

  const hacks = (archivedHacks || [])
    .flatMap(item => item.hacks || []) as Hack[];

  return (
    <div className="bg-black min-h-screen text-white">
      {/* Header */}
      <div className="max-w-7xl mx-auto px-4 py-12">
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">Archived Posts</h1>
          <p className="text-gray-400">Your saved hacks that you've archived</p>
        </div>

        {/* Hacks Grid */}
        {hacks.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1">
            {hacks.map((hack) => (
              <Link
                key={hack.id}
                href={`/hack/${hack.id}`}
                className="aspect-square bg-gray-900 hover:bg-gray-800 transition overflow-hidden group relative"
              >
                {hack.content_thumbnail ? (
                  <Image
                    src={hack.content_thumbnail}
                    alt={hack.title}
                    fill
                    className="w-full h-full object-cover group-hover:opacity-80 transition"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-gray-800 to-gray-900 flex items-center justify-center text-white text-3xl">
                    🎯
                  </div>
                )}

                {/* Hover Overlay */}
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex flex-col items-center justify-center text-white">
                  <p className="text-sm font-semibold text-center line-clamp-2 px-2">
                    {hack.title}
                  </p>
                  <p className="text-xs text-gray-300 mt-2">{hack.category}</p>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="text-center py-16">
            <p className="text-gray-400 text-lg mb-4">No archived hacks yet</p>
            <Link
              href={`/profile/${username}`}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-semibold transition"
            >
              Back to profile
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
