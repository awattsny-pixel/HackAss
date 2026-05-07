'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import Image from 'next/image';
import HackDetailModal from '@/app/components/HackDetail/HackDetailModal';

type TabType = 'grid' | 'videos' | 'bookmarks' | 'tagged';

interface Hack {
  id: string;
  title: string;
  description: string;
  category: string;
  content_type: string;
  content_thumbnail: string;
  created_at: string;
  worked_votes: number;
  failed_votes: number;
}

interface ProfileTabsProps {
  username: string;
}

const TABS: Array<{ id: TabType; label: string; icon: string }> = [
  { id: 'grid', label: 'Posts', icon: '⊞' },
  { id: 'videos', label: 'Videos', icon: '▶' },
  { id: 'bookmarks', label: 'Saved', icon: '🔖' },
];

export default function ProfileTabs({ username }: ProfileTabsProps) {
  const [activeTab, setActiveTab] = useState<TabType>('grid');
  const [hacks, setHacks] = useState<Hack[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedHackId, setSelectedHackId] = useState<string | null>(null);
  const observerTarget = useRef<HTMLDivElement>(null);

  // Fetch hacks for the active tab
  const fetchHacks = useCallback(
    async (tabId: TabType, nextCursor?: string) => {
      try {
        setLoading(true);
        const params = new URLSearchParams({
          tab: tabId,
          limit: '12',
          ...(nextCursor && { cursor: nextCursor }),
        });

        const response = await fetch(`/api/users/${username}/hacks?${params}`);

        // Handle empty results gracefully
        if (!response.ok) {
          if (response.status === 404) {
            // No hacks found - show empty state
            setHacks(nextCursor ? prev => [...prev] : []);
            setHasMore(false);
            setCursor(null);
            return;
          }
          throw new Error('Failed to fetch hacks');
        }

        const result = await response.json();

        if (nextCursor) {
          // Append to existing hacks (pagination)
          setHacks(prev => [...prev, ...result.data]);
        } else {
          // Replace hacks (tab switch)
          setHacks(result.data || []);
        }

        setHasMore(result.meta?.hasMore ?? false);
        setCursor(result.meta?.cursor ?? null);
      } catch (error) {
        console.error('Error fetching hacks:', error);
        // Don't crash on error - just show empty state
        setHacks([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [username]
  );

  // Fetch initial hacks when tab changes
  useEffect(() => {
    fetchHacks(activeTab);
  }, [activeTab, fetchHacks]);

  // Infinite scroll intersection observer
  useEffect(() => {
    if (!observerTarget.current || !hasMore || loading) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && cursor) {
          fetchHacks(activeTab, cursor);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [activeTab, cursor, hasMore, loading, fetchHacks]);

  return (
    <div className="max-w-7xl mx-auto px-4 pb-16">
      {/* Tab Navigation */}
      <div className="flex gap-8 border-t border-gray-700 mb-12">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`
              py-4 px-2 font-semibold text-sm uppercase tracking-wider transition
              border-t-2 -mt-[1px]
              ${activeTab === tab.id
                ? 'text-white border-t-white'
                : 'text-gray-500 border-t-transparent hover:text-gray-400'
              }
            `}
          >
            <span className="mr-2">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Loading State */}
      {loading && hacks.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-400">Loading hacks...</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && hacks.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-400 text-lg">
            {activeTab === 'grid' && 'No hacks yet'}
            {activeTab === 'videos' && 'No videos yet'}
            {activeTab === 'bookmarks' && 'No saved hacks yet'}
          </p>
        </div>
      )}

      {/* Hacks Grid */}
      {hacks.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1">
          {hacks.map((hack) => (
            <button
              key={hack.id}
              onClick={() => setSelectedHackId(hack.id)}
              className="aspect-square bg-gray-900 hover:bg-gray-800 transition overflow-hidden group relative cursor-pointer text-left"
            >
              {hack.content_thumbnail ? (
                <Image
                  src={hack.content_thumbnail}
                  alt={hack.title}
                  fill
                  sizes="(max-width: 768px) 50vw, (max-width: 1024px) 33vw, 25vw"
                  className="w-full h-full object-cover group-hover:opacity-80 transition"
                />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-gray-800 to-gray-900 flex items-center justify-center text-white text-3xl">
                  🎯
                </div>
              )}

              {/* Hover Overlay - pointer-events-none so it doesn't block clicks */}
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex flex-col items-center justify-center text-white pointer-events-none">
                <p className="text-sm font-semibold text-center line-clamp-2 px-2">
                  {hack.title}
                </p>
                <p className="text-xs text-gray-300 mt-2">{hack.category}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Hack Detail Modal */}
      {selectedHackId && (
        <HackDetailModal
          hackId={selectedHackId}
          isOpen={!!selectedHackId}
          onClose={() => setSelectedHackId(null)}
        />
      )}

      {/* Intersection observer target for infinite scroll */}
      {hasMore && <div ref={observerTarget} className="h-4" />}

      {/* Load more indicator */}
      {loading && hacks.length > 0 && (
        <div className="text-center py-8">
          <p className="text-gray-400 text-sm">Loading more...</p>
        </div>
      )}
    </div>
  );
}
