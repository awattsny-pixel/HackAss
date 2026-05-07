'use client';

import { useState, useCallback } from 'react';
import { useAuth } from '@/app/context/AuthContext';
import { useRouter } from 'next/navigation';

interface EngagementBarProps {
  hackId: string;
  initialLiked: boolean;
  initialBookmarked: boolean;
  initialLikeCount: number;
  initialBookmarkCount: number;
  shareCount: number;
  commentCount: number;
  onLikeChange?: (liked: boolean) => void;
  onBookmarkChange?: (bookmarked: boolean) => void;
}

export default function EngagementBar({
  hackId,
  initialLiked,
  initialBookmarked,
  initialLikeCount,
  initialBookmarkCount,
  shareCount,
  commentCount,
  onLikeChange,
  onBookmarkChange,
}: EngagementBarProps) {
  const { user } = useAuth();
  const router = useRouter();
  const [liked, setLiked] = useState(initialLiked);
  const [bookmarked, setBookmarked] = useState(initialBookmarked);
  const [likeCount, setLikeCount] = useState(initialLikeCount);
  const [bookmarkCount, setBookmarkCount] = useState(initialBookmarkCount);
  const [likeLoading, setLikeLoading] = useState(false);
  const [bookmarkLoading, setBookmarkLoading] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  const handleLike = useCallback(async () => {
    if (!user) {
      router.push('/auth/login');
      return;
    }

    setLikeLoading(true);
    try {
      const token = localStorage.getItem('auth_token');
      if (!token) {
        router.push('/auth/login');
        setLikeLoading(false);
        return;
      }

      const response = await fetch(`/api/hacks/${hackId}/like`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const newLiked = !liked;
        setLiked(newLiked);
        setLikeCount(prev => newLiked ? prev + 1 : prev - 1);
        onLikeChange?.(newLiked);
      }
    } catch (error) {
      console.error('Error toggling like:', error);
    } finally {
      setLikeLoading(false);
    }
  }, [hackId, liked, user, router, onLikeChange]);

  const handleBookmark = useCallback(async () => {
    if (!user) {
      router.push('/auth/login');
      return;
    }

    setBookmarkLoading(true);
    try {
      const token = localStorage.getItem('auth_token');
      if (!token) {
        router.push('/auth/login');
        setBookmarkLoading(false);
        return;
      }

      const response = await fetch(`/api/hacks/${hackId}/bookmark`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const newBookmarked = !bookmarked;
        setBookmarked(newBookmarked);
        setBookmarkCount(prev => newBookmarked ? prev + 1 : prev - 1);
        onBookmarkChange?.(newBookmarked);
      }
    } catch (error) {
      console.error('Error toggling bookmark:', error);
    } finally {
      setBookmarkLoading(false);
    }
  }, [hackId, bookmarked, user, router, onBookmarkChange]);

  const handleShare = useCallback(async () => {
    const shareUrl = `${window.location.origin}/hack/${hackId}`;

    // Try native share API first
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Check out this hack',
          url: shareUrl,
        });
        return;
      } catch (error) {
        console.error('Share failed:', error);
      }
    }

    // Fallback to copy to clipboard
    try {
      await navigator.clipboard.writeText(shareUrl);
      alert('Link copied to clipboard!');
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  }, [hackId]);

  return (
    <div className="flex flex-col gap-4">
      {/* Like Button */}
      <button
        onClick={handleLike}
        disabled={likeLoading}
        className={`
          flex items-center gap-2 px-4 py-3 rounded-lg font-semibold transition
          ${liked
            ? 'bg-red-900/30 text-red-400 hover:bg-red-900/40'
            : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
          }
          disabled:opacity-50 disabled:cursor-not-allowed
        `}
      >
        <span className="text-xl">{liked ? '❤️' : '🤍'}</span>
        <span>{likeCount.toLocaleString()}</span>
      </button>

      {/* Bookmark Button */}
      <button
        onClick={handleBookmark}
        disabled={bookmarkLoading}
        className={`
          flex items-center gap-2 px-4 py-3 rounded-lg font-semibold transition
          ${bookmarked
            ? 'bg-yellow-900/30 text-yellow-400 hover:bg-yellow-900/40'
            : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
          }
          disabled:opacity-50 disabled:cursor-not-allowed
        `}
      >
        <span className="text-xl">{bookmarked ? '🔖' : '🔗'}</span>
        <span>{bookmarkCount.toLocaleString()}</span>
      </button>

      {/* Share Button */}
      <button
        onClick={handleShare}
        className="flex items-center gap-2 px-4 py-3 rounded-lg font-semibold bg-gray-800 text-gray-300 hover:bg-gray-700 transition"
      >
        <span className="text-xl">↗️</span>
        <span>{shareCount.toLocaleString()}</span>
      </button>

      {/* Comments Button */}
      <button
        onClick={() => document.getElementById('comments-section')?.scrollIntoView({ behavior: 'smooth' })}
        className="flex items-center gap-2 px-4 py-3 rounded-lg font-semibold bg-gray-800 text-gray-300 hover:bg-gray-700 transition"
      >
        <span className="text-xl">💬</span>
        <span>{commentCount.toLocaleString()}</span>
      </button>

      {/* More Options Menu */}
      <div className="relative">
        <button
          onClick={() => setShowMoreMenu(!showMoreMenu)}
          className="w-full flex items-center justify-center px-4 py-3 rounded-lg font-semibold bg-gray-800 text-gray-300 hover:bg-gray-700 transition"
        >
          <span className="text-xl">⋮</span>
        </button>

        {showMoreMenu && (
          <div className="absolute bottom-12 right-0 w-48 bg-gray-900 rounded-lg border border-gray-700 shadow-xl z-10">
            <button className="w-full px-4 py-3 text-left text-gray-300 hover:bg-gray-800 transition rounded-t-lg">
              Report hack
            </button>
            <button className="w-full px-4 py-3 text-left text-gray-300 hover:bg-gray-800 transition border-t border-gray-700">
              Block user
            </button>
            <button
              onClick={() => {
                navigator.clipboard.writeText(`/hack/${hackId}`);
                setShowMoreMenu(false);
              }}
              className="w-full px-4 py-3 text-left text-gray-300 hover:bg-gray-800 transition border-t border-gray-700 rounded-b-lg"
            >
              Copy link
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
