'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import ValidationPrompt from './ValidationPrompt';

export interface Hack {
  id: string;
  title: string;
  description: string;
  category?: string;
  content_type: 'video' | 'photo' | 'link';
  content_url: string;
  content_thumbnail?: string;
  source_attribution?: string;
  created_at?: string;
  worked_votes: number;
  failed_votes: number;
  unique_users_who_validated: number;
  hack_score?: number;
}

interface HackCardProps {
  hack: Hack;
  onVote?: () => void;
}

// Helper function to decode HTML entities
const decodeHtmlEntities = (text: string): string => {
  const textarea = typeof document !== 'undefined' ? document.createElement('textarea') : null;
  if (!textarea) return text;
  textarea.innerHTML = text;
  return textarea.value;
};

export default function HackCard({ hack, onVote }: HackCardProps) {
  const [showValidation, setShowValidation] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [hasVoted, setHasVoted] = useState(false);

  // Check if user has already voted on this hack
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const votedHacks = JSON.parse(localStorage.getItem('votedHacks') || '[]');
      setHasVoted(votedHacks.includes(hack.id));
    }
  }, [hack.id]);

  // Process Instagram embeds when component mounts
  useEffect(() => {
    if (hack.content_url?.includes('instagram.com') && typeof window !== 'undefined') {
      const script = (window as any).instgrm;
      if (script?.Embed?.process) {
        script.Embed.process();
      }
    }
  }, [hack.id, hack.content_url]);

  const handleVoteComplete = () => {
    // Mark this hack as voted
    if (typeof window !== 'undefined') {
      const votedHacks = JSON.parse(localStorage.getItem('votedHacks') || '[]');
      if (!votedHacks.includes(hack.id)) {
        votedHacks.push(hack.id);
        localStorage.setItem('votedHacks', JSON.stringify(votedHacks));
      }
      setHasVoted(true);
    }
    onVote?.();
  };

  const totalVotes = hack.worked_votes + hack.failed_votes;
  const successRate =
    totalVotes > 0 ? Math.round((hack.worked_votes / totalVotes) * 100) : 0;

  const getContentPreview = () => {
    if (hack.content_type === 'photo' && hack.content_url) {
      return (
        <div className="relative w-full aspect-square bg-gray-200">
          <Image
            src={hack.content_url}
            alt={hack.title}
            fill
            className="object-cover"
            sizes="(max-width: 768px) 100vw, 400px"
          />
        </div>
      );
    }

    if (hack.content_type === 'video' || hack.content_type === 'link') {
      if (!hack.content_url) {
        return (
          <div className="relative w-full aspect-video bg-gray-300 flex items-center justify-center text-gray-600 text-4xl">
            {hack.content_type === 'video' ? '🎥' : '🔗'}
          </div>
        );
      }

      // Handle Instagram with thumbnail and link
      if (hack.content_url.includes('instagram.com')) {
        const cleanInstagramUrl = hack.content_url.split('?')[0];
        const postId = cleanInstagramUrl.split('/').filter(p => p).slice(-2)[0];

        // Try to load Instagram's oembed thumbnail
        return (
          <a
            href={cleanInstagramUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block relative w-full aspect-square bg-gradient-to-br from-pink-400 via-red-500 to-purple-600 hover:shadow-lg transition overflow-hidden group"
          >
            {/* Attempt to load thumbnail from Instagram CDN */}
            <img
              src={`https://www.instagram.com/p/${postId}/media/?size=l`}
              alt={hack.title}
              className="w-full h-full object-cover group-hover:opacity-75 transition"
              onError={(e) => {
                // Fallback to gradient if image fails
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />

            {/* Fallback overlay if image doesn't load */}
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white p-4 text-center bg-gradient-to-br from-pink-400 via-red-500 to-purple-600">
              <div className="text-5xl mb-4 group-hover:scale-110 transition">📸</div>
              <h3 className="font-bold text-lg mb-2 group-hover:underline">{hack.title}</h3>
              <p className="text-sm opacity-90">View on Instagram →</p>
            </div>
          </a>
        );
      }

      // Build embed URL based on platform
      const getEmbedUrl = () => {
        const url = hack.content_url;

        // YouTube
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
          const videoId = url.includes('v=')
            ? url.split('v=')[1]?.split('&')[0]
            : url.split('/').pop();
          return `https://www.youtube.com/embed/${videoId}`;
        }

        // Vimeo
        if (url.includes('vimeo.com')) {
          const videoId = url.split('/').pop()?.split('?')[0];
          return `https://player.vimeo.com/video/${videoId}`;
        }

        // TikTok
        if (url.includes('tiktok.com')) {
          const videoId = url.split('/video/')[1]?.split('?')[0] || url.split('/').pop();
          return `https://www.tiktok.com/embed/v2/${videoId}`;
        }

        // Twitch Clips
        if (url.includes('clips.twitch.tv')) {
          const clipId = url.split('/').pop()?.split('?')[0];
          return `https://clips.twitch.tv/embed?clip=${clipId}&parent=${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}`;
        }

        // Fallback to original URL
        return url;
      };

      return (
        <div className="relative w-full aspect-video bg-gray-900">
          <iframe
            src={getEmbedUrl()}
            width="100%"
            height="100%"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="w-full h-full"
            title={hack.title}
          />
        </div>
      );
    }

    return null;
  };

  return (
    <>
      <div className="bg-white rounded-lg shadow-md overflow-hidden hover:shadow-lg transition">
        {/* Video/Photo Container */}
        <div className="relative w-full overflow-hidden bg-gray-100">
          {getContentPreview()}

          {/* Title overlay */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black to-transparent p-4">
            <h3 className="text-white font-bold text-lg line-clamp-2">{hack.title}</h3>
          </div>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Description */}
          <p className="text-gray-700 text-sm line-clamp-2">{decodeHtmlEntities(hack.description)}</p>

          {/* Stats */}
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-3">
              <div className="text-center">
                <div className="font-bold text-green-600">{successRate}%</div>
                <div className="text-xs text-gray-500">success rate</div>
              </div>
              <div className="text-center">
                <div className="font-bold text-gray-900">
                  {hack.unique_users_who_validated || 0}
                </div>
                <div className="text-xs text-gray-500">verified</div>
              </div>
            </div>

            {hack.hack_score && (
              <div className="text-right">
                <div className="font-bold text-blue-600">{hack.hack_score.toFixed(2)}</div>
                <div className="text-xs text-gray-500">score</div>
              </div>
            )}
          </div>

          {/* Source attribution */}
          {hack.source_attribution && (
            <div className="text-xs text-gray-500 border-t pt-2">
              {hack.content_type === 'link' ? '🔗' : hack.content_type === 'video' ? '🎥' : '📷'}{' '}
              {hack.source_attribution}
            </div>
          )}

          {/* CTA Button */}
          {hasVoted ? (
            <div className="w-full bg-gray-200 text-gray-600 font-semibold py-2 rounded-lg text-sm text-center">
              ✓ You already voted
            </div>
          ) : (
            <button
              onClick={() => setShowValidation(true)}
              className="w-full bg-blue-600 text-white font-semibold py-2 rounded-lg hover:bg-blue-700 transition text-sm"
            >
              Did it work?
            </button>
          )}
        </div>
      </div>

      {/* Validation Prompt */}
      {showValidation && (
        <ValidationPrompt
          hackId={hack.id}
          onClose={() => setShowValidation(false)}
          onVote={handleVoteComplete}
        />
      )}
    </>
  );
}
