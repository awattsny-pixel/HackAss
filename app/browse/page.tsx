'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import HackCard, { Hack } from '../components/HackCard';

const CATEGORIES = [
  'All',
  'Cooking',
  'Cleaning',
  'Money',
  'Travel',
  'Productivity',
  'Home',
  'Laundry',
  'Tech',
  'Beauty',
  'Fitness',
];

const SORT_OPTIONS = [
  { label: 'Best', value: 'best' },
  { label: 'Trending', value: 'trending' },
  { label: 'Newest', value: 'newest' },
];

export default function BrowsePage() {
  const [hacks, setHacks] = useState<Hack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedSort, setSelectedSort] = useState('best');

  const fetchHacks = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/hacks');

      if (!response.ok) {
        throw new Error('Failed to fetch hacks');
      }

      const data = await response.json();
      let newHacks = data.hacks || [];

      // Sort client-side
      if (selectedSort === 'best') {
        newHacks = newHacks.sort((a, b) => {
          const aRate = a.worked_votes / (a.worked_votes + a.failed_votes) || 0;
          const bRate = b.worked_votes / (b.worked_votes + b.failed_votes) || 0;
          return bRate - aRate;
        });
      } else if (selectedSort === 'trending') {
        newHacks = newHacks.sort(
          (a, b) =>
            (b.worked_votes + b.failed_votes) - (a.worked_votes + a.failed_votes)
        );
      } else if (selectedSort === 'newest') {
        newHacks = newHacks.sort(
          (a, b) =>
            new Date(b.created_at).getTime() -
            new Date(a.created_at).getTime()
        );
      }

      setHacks(newHacks);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load hacks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHacks();
  }, [selectedCategory, selectedSort]);

  const filteredHacks =
    selectedCategory === 'All'
      ? hacks
      : hacks.filter((h) => h.category === selectedCategory);

  return (
    <div className="min-h-screen bg-black">
      {/* Header */}
      <header className="bg-black border-b border-gray-800 sticky top-[60px] z-40">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-3xl font-bold text-white">Browse Hacks</h1>
            <Link
              href="/submit"
              className="bg-blue-600 text-white font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 transition"
            >
              + Share Hack
            </Link>
          </div>

          <p className="text-gray-400 text-sm">
            Ranked hacks. Real people. Real results.
          </p>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Filters */}
        <div className="mb-8 space-y-4">
          {/* Category Filter */}
          <div>
            <label className="block text-sm font-semibold text-gray-300 mb-3">
              Category
            </label>
            <div className="flex overflow-x-auto gap-2 pb-2">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-4 py-2 rounded-full font-semibold whitespace-nowrap transition ${
                    selectedCategory === cat
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Sort Options */}
          <div>
            <label className="block text-sm font-semibold text-gray-300 mb-3">
              Sort by
            </label>
            <div className="flex gap-2">
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setSelectedSort(opt.value)}
                  className={`px-4 py-2 rounded-lg font-semibold transition ${
                    selectedSort === opt.value
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Error State */}
        {error && (
          <div className="bg-red-900/20 border border-red-800 text-red-400 px-4 py-3 rounded-lg mb-8">
            {error}
          </div>
        )}

        {/* Hacks Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          {filteredHacks.map((hack) => (
            <HackCard key={hack.id} hack={hack} onVote={() => fetchHacks()} />
          ))}
        </div>

        {/* Loading State */}
        {loading && (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        )}

        {/* Empty State */}
        {!loading && filteredHacks.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-400 mb-4">No hacks found in this category.</p>
            <Link
              href="/submit"
              className="inline-block bg-blue-600 text-white font-semibold px-6 py-2 rounded-lg hover:bg-blue-700 transition"
            >
              Be the first to share
            </Link>
          </div>
        )}

        {/* Refresh Button */}
        {!loading && filteredHacks.length > 0 && (
          <div className="flex justify-center">
            <button
              onClick={() => fetchHacks()}
              className="bg-gray-800 text-gray-300 font-semibold px-6 py-2 rounded-lg hover:bg-gray-700 transition"
            >
              Refresh Feed
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
