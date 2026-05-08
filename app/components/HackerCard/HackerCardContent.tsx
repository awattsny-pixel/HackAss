'use client';

import Image from 'next/image';
import Link from 'next/link';
import { FollowButton } from '@/app/components/Common/FollowButton';
import { VerificationBadge } from '@/app/components/Common/VerificationBadge';
import { type HackerCardData } from '@/app/lib/user-cache';
import { DEFAULT_HACKER_AVATAR } from '@/app/lib/constants';

interface HackerCardContentProps {
  data: HackerCardData;
  onFollowChange?: (isFollowing: boolean) => void;
}

export function HackerCardContent({ data, onFollowChange }: HackerCardContentProps) {
  return (
    <div className="bg-white rounded-2xl shadow-lg p-6 w-80">
      {/* Header */}
      <div className="flex items-start gap-4 mb-6">
        <div className="flex-shrink-0">
          <Image
            src={data.profile_image_small_url || data.avatar || DEFAULT_HACKER_AVATAR}
            alt={data.username}
            width={80}
            height={80}
            className="rounded-full"
          />
        </div>
        <div className="flex-1 min-w-0">
          <Link href={`/profile/${data.username}`} className="hover:underline">
            <h3 className="font-bold text-lg truncate flex items-center gap-1">
              {data.username}
              {data.is_verified && <VerificationBadge />}
            </h3>
          </Link>
          <p className="text-gray-600 text-sm line-clamp-2">{data.bio || 'No bio'}</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6 text-center">
        <Link href={`/profile/${data.username}`} className="hover:bg-gray-50 p-2 rounded">
          <div className="font-bold text-lg">{data.posts}</div>
          <div className="text-gray-600 text-xs">posts</div>
        </Link>
        <div className="p-2">
          <div className="font-bold text-lg">{data.followers.toLocaleString()}</div>
          <div className="text-gray-600 text-xs">followers</div>
        </div>
        <div className="p-2">
          <div className="font-bold text-lg">{data.following}</div>
          <div className="text-gray-600 text-xs">following</div>
        </div>
      </div>

      {/* Recent Hacks Grid */}
      {data.recentHacks.length > 0 && (
        <div className="grid grid-cols-3 gap-2 mb-6">
          {data.recentHacks.map((hack) => (
            <Link
              key={hack.id}
              href={`/hack/${hack.id}`}
              className="aspect-square bg-gray-200 rounded-lg overflow-hidden hover:opacity-80 transition"
            >
              {hack.content_thumbnail ? (
                <Image
                  src={hack.content_thumbnail}
                  alt={hack.title}
                  width={120}
                  height={120}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-gray-300 to-gray-400 flex items-center justify-center text-white text-2xl">
                  🎯
                </div>
              )}
            </Link>
          ))}
        </div>
      )}

      {/* Follow Button */}
      <FollowButton
        userId={data.id}
        isFollowing={data.isFollowing}
        onFollowChange={onFollowChange}
        className="w-full"
      />

      {/* Footer */}
      <div className="mt-4 pt-4 border-t border-gray-200">
        <Link
          href={`/profile/${data.username}`}
          className="text-gray-600 text-xs hover:text-black"
        >
          @{data.username}
        </Link>
      </div>
    </div>
  );
}
