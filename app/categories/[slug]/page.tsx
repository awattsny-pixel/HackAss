'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import HackCard, { Hack } from '../../components/HackCard';
import HackDetailModal from '../../components/HackDetail/HackDetailModal';

const CATEGORY_CONFIG: Record<string, { color: string; icon: string; description: string; gradient: string }> = {
  cooking: {
    color: 'orange',
    icon: '🍳',
    description: 'Kitchen hacks that actually work',
    gradient: 'from-orange-500/10 to-amber-500/10'
  },
  cleaning: {
    color: 'emerald',
    icon: '✨',
    description: 'Clean faster, smarter, better',
    gradient: 'from-emerald-500/10 to-teal-500/10'
  },
  money: {
    color: 'cyan',
    icon: '💰',
    description: 'Save money with these simple tricks',
    gradient: 'from-cyan-500/10 to-blue-500/10'
  },
  travel: {
    color: 'indigo',
    icon: '✈️',
    description: 'Travel smarter, save money',
    gradient: 'from-indigo-500/10 to-purple-500/10'
  },
  productivity: {
    color: 'yellow',
    icon: '⚡',
    description: 'Work smarter, not harder',
    gradient: 'from-yellow-500/10 to-orange-500/10'
  },
  home: {
    color: 'rose',
    icon: '🏠',
    description: 'Home improvement hacks',
    gradient: 'from-rose-500/10 to-pink-500/10'
  },
  laundry: {
    color: 'blue',
    icon: '👕',
    description: 'Laundry hacks for stains and wrinkles',
    gradient: 'from-blue-500/10 to-cyan-500/10'
  },
  tech: {
    color: 'violet',
    icon: '💻',
    description: 'Tech tips and tricks',
    gradient: 'from-violet-500/10 to-purple-500/10'
  },
  beauty: {
    color: 'pink',
    icon: '💄',
    description: 'Beauty and skincare hacks',
    gradient: 'from-pink-500/10 to-rose-500/10'
  },
  fitness: {
    color: 'green',
    icon: '💪',
    description: 'Get fit faster with these hacks',
    gradient: 'from-green-500/10 to-emerald-500/10'
  },
};

export default function CategoryPage() {
  const params = useParams();
  const slug = params.slug as string;
  const category = slug.charAt(0).toUpperCase() + slug.slice(1);
  const config = CATEGORY_CONFIG[slug] || CATEGORY_CONFIG.cooking;

  const [hacks, setHacks] = useState<Hack[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedHackId, setSelectedHackId] = useState<string | null>(null);

  useEffect(() => {
    const fetchHacks = async () => {
      try {
        const response = await fetch('/api/hacks');
        if (!response.ok) throw new Error('Failed to fetch');
        const data = await response.json();
        const filtered = (data.hacks || []).filter((h: Hack) =>
          h.category.toLowerCase() === slug.toLowerCase()
        );
        setHacks(filtered);
      } catch (err) {
        console.error('Error fetching hacks:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchHacks();
  }, [slug]);

  return (
    <div className="min-h-screen bg-black">
      {/* Header */}
      <header className="sticky top-[60px] z-40 bg-black border-b border-gray-800">
        <div className={`bg-gradient-to-br ${config.gradient}`}>
          <div className="max-w-7xl mx-auto px-4 py-12">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-5xl mb-3">{config.icon}</div>
                <h1 className="text-4xl md:text-5xl font-bold text-white mb-2">{category} Hacks</h1>
                <p className="text-lg text-gray-400">{config.description}</p>
              </div>
              <Link
                href="/submit"
                className="bg-blue-600 text-white font-semibold px-6 py-3 rounded-lg hover:bg-blue-700 transition"
              >
                + Share Hack
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Loading State */}
        {loading && (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        )}

        {/* Hacks Grid */}
        {!loading && hacks.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {hacks.map((hack) => (
              <div
                key={hack.id}
                onClick={() => setSelectedHackId(hack.id)}
                className="cursor-pointer"
              >
                <HackCard hack={hack} onVote={() => {}} />
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {!loading && hacks.length === 0 && (
          <div className="text-center py-12">
            <div className="text-6xl mb-4">{config.icon}</div>
            <p className="text-gray-400 mb-6 text-lg">No hacks found in this category yet.</p>
            <Link
              href="/submit"
              className="inline-block bg-blue-600 text-white font-semibold px-6 py-3 rounded-lg hover:bg-blue-700 transition"
            >
              Be the first to share a {category.toLowerCase()} hack
            </Link>
          </div>
        )}

        {/* Browse All Link */}
        <div className="mt-12 text-center">
          <Link href="/browse" className="text-blue-400 hover:text-blue-300 font-semibold transition">
            ← Back to all hacks
          </Link>
        </div>
      </div>

      {/* Hack Detail Modal */}
      {selectedHackId && (
        <HackDetailModal
          hackId={selectedHackId}
          isOpen={!!selectedHackId}
          onClose={() => setSelectedHackId(null)}
        />
      )}
    </div>
  );
}
