'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import { HackerCardTrigger } from '@/app/components/HackerCard/HackerCardTrigger';
import { VerificationBadge } from '@/app/components/Common/VerificationBadge';
import EngagementBar from './EngagementBar';
import CommentSection from './CommentSection';

interface Hack {
  id: string;
  title: string;
  description: string;
  category: string;
  difficulty: string;
  why_it_works: string;
  content_type: string;
  content_url: string;
  content_thumbnail: string;
  created_at: string;
  worked_votes: number;
  failed_votes: number;
  view_count: number;
  share_count: number;
  like_count: number;
  bookmark_count: number;
  source_attribution: string;
  users: {
    id: string;
    username: string;
    avatar: string;
    is_verified: boolean;
    real_name: string;
    bio: string;
  };
}

interface HackDetailContentProps {
  hack: Hack;
}

export default function HackDetailContent({ hack }: HackDetailContentProps) {
  const { user } = useAuth();
  const [liked, setLiked] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);

  const getCategoryColor = (category: string): string => {
    const colors: Record<string, string> = {
      Cooking: '#FF9500',
      Cleaning: '#4CAF50',
      Money: '#00BCD4',
      Travel: '#9C27B0',
      Productivity: '#2196F3',
      Home: '#FF9500',
      Laundry: '#00BCD4',
      Tech: '#6366F1',
      Beauty: '#E91E63',
      Fitness: '#F44336',
    };
    return colors[category] || '#6b7280';
  };

  const getMediaContent = () => {
    const url = hack.content_url;

    // YouTube
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      const videoId = url.includes('v=')
        ? url.split('v=')[1]?.split('&')[0]
        : url.split('/').pop();
      return (
        <iframe
          width="100%"
          height="100%"
          src={`https://www.youtube.com/embed/${videoId}`}
          title={hack.title}
          frameBorder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      );
    }

    // Vimeo
    if (url.includes('vimeo.com')) {
      const videoId = url.split('/').pop()?.split('?')[0];
      return (
        <iframe
          width="100%"
          height="100%"
          src={`https://player.vimeo.com/video/${videoId}`}
          title={hack.title}
          frameBorder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      );
    }

    // TikTok
    if (url.includes('tiktok.com')) {
      const videoId = url.split('/video/')[1]?.split('?')[0] || url.split('/').pop();
      return (
        <iframe
          src={`https://www.tiktok.com/embed/v2/${videoId}`}
          width="100%"
          height="100%"
          frameBorder="0"
          allow="autoplay; encrypted-media"
          allowFullScreen
          title={hack.title}
        />
      );
    }

    // Instagram
    if (url.includes('instagram.com')) {
      const cleanUrl = url.split('?')[0];
      return (
        <iframe
          src={`${cleanUrl}embed/captioned/`}
          width="100%"
          height="100%"
          frameBorder="0"
          scrolling="no"
          allowFullScreen
          title={hack.title}
        />
      );
    }

    // Default: Try to show thumbnail or a fallback
    if (hack.content_thumbnail) {
      return (
        <Image
          src={hack.content_thumbnail}
          alt={hack.title}
          fill
          className="object-cover"
        />
      );
    }

    // Fallback if no content available
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-800">
        <p className="text-gray-400">Media not available</p>
      </div>
    );
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-12">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main Content */}
        <div className="lg:col-span-2">
          {/* Media */}
          <div className="relative bg-gray-900 rounded-xl overflow-hidden mb-8 aspect-video">
            {getMediaContent()}
          </div>

          {/* Hack Info */}
          <div className="mb-8">
            <h1 className="text-4xl font-bold text-white mb-4">{hack.title}</h1>

            <div className="flex items-center gap-4 mb-6 pb-6 border-b border-gray-700">
              <Image
                src={hack.users.avatar || '/default-avatar.svg'}
                alt={hack.users.username}
                width={48}
                height={48}
                className="rounded-full"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <HackerCardTrigger username={hack.users.username}>
                    <span className="text-white font-semibold hover:underline">
                      {hack.users.username}
                    </span>
                  </HackerCardTrigger>
                  {hack.users.is_verified && <VerificationBadge />}
                </div>
                <p className="text-gray-400 text-sm">
                  {new Date(hack.created_at).toLocaleDateString()}
                </p>
              </div>
            </div>

            {/* Category & Difficulty */}
            <div className="flex gap-3 mb-6">
              <span
                className="px-3 py-1 rounded-lg text-xs font-bold text-white"
                style={{ backgroundColor: getCategoryColor(hack.category) }}
              >
                {hack.category}
              </span>
              <span className="px-3 py-1 rounded-lg text-xs font-bold text-white bg-gray-700">
                {hack.difficulty}
              </span>
            </div>

            {/* Description */}
            <p className="text-gray-300 text-base leading-relaxed mb-6">
              {hack.description}
            </p>

            {/* Why It Works */}
            {hack.why_it_works && (
              <div className="bg-gray-900 rounded-lg p-4 mb-6">
                <h3 className="font-semibold text-white mb-2">Why it works</h3>
                <p className="text-gray-300 text-sm">{hack.why_it_works}</p>
              </div>
            )}

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4 py-6 border-t border-b border-gray-700">
              <div>
                <div className="font-bold text-white text-lg">
                  {hack.worked_votes + hack.failed_votes}
                </div>
                <div className="text-gray-400 text-sm">validations</div>
              </div>
              <div>
                <div className="font-bold text-white text-lg">
                  {hack.worked_votes > 0 ? Math.round((hack.worked_votes / (hack.worked_votes + hack.failed_votes)) * 100) : 0}%
                </div>
                <div className="text-gray-400 text-sm">success rate</div>
              </div>
              <div>
                <div className="font-bold text-white text-lg">
                  {hack.view_count.toLocaleString()}
                </div>
                <div className="text-gray-400 text-sm">views</div>
              </div>
            </div>
          </div>

          {/* Comments Section */}
          <CommentSection hackId={hack.id} />
        </div>

        {/* Sidebar */}
        <div className="lg:col-span-1">
          <div className="sticky top-4">
            {/* Engagement Bar */}
            <EngagementBar
              hackId={hack.id}
              initialLiked={liked}
              initialBookmarked={bookmarked}
              initialLikeCount={hack.like_count}
              initialBookmarkCount={hack.bookmark_count}
              onLikeChange={setLiked}
              onBookmarkChange={setBookmarked}
              shareCount={hack.share_count}
              commentCount={hack.worked_votes + hack.failed_votes}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
