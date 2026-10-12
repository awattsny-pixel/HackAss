import Link from 'next/link';

interface ArchivePageProps {
  params: Promise<{ username: string }>;
}

// M01-B: the archive is private to its owner. Without verified identity it cannot be served,
// so this page makes no database access and shows an unavailable state.
export default async function ArchivePage({ params }: ArchivePageProps) {
  const { username } = await params;
  return (
    <div className="bg-black min-h-screen text-white">
      <div className="max-w-7xl mx-auto px-4 py-12">
        <h1 className="text-4xl font-bold mb-2">Archive unavailable</h1>
        <p className="text-gray-400 mb-6">Archives are private and are temporarily unavailable.</p>
        <Link href={`/profile/${encodeURIComponent(username)}`} className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-semibold transition">
          Back to profile
        </Link>
      </div>
    </div>
  );
}
