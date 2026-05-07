'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import { FollowButton } from '@/app/components/Common/FollowButton';
import { VerificationBadge } from '@/app/components/Common/VerificationBadge';

interface UserStats {
  id: string;
  username: string;
  real_name: string | null;
  bio: string | null;
  is_verified: boolean;
  avatar: string | null;
  profile_image_url: string | null;
  followers: number;
  following: number;
  posts: number;
}

interface ProfileHeaderProps {
  user: UserStats;
}

export default function ProfileHeader({ user }: ProfileHeaderProps) {
  const { user: currentUser } = useAuth();
  const isOwnProfile = currentUser?.id === user.id;

  return (
    <div className="max-w-7xl mx-auto px-4 py-16">
      <div className="flex flex-col md:flex-row gap-12 items-start">
        {/* Profile Image */}
        <div className="flex-shrink-0">
          <Image
            src={user.profile_image_url || user.avatar || '/default-avatar.svg'}
            alt={user.username}
            width={160}
            height={160}
            className="rounded-full w-40 h-40 object-cover"
          />
        </div>

        {/* Profile Info */}
        <div className="flex-1">
          {/* Username & Verification */}
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-4xl font-bold">{user.username}</h1>
            {user.is_verified && <VerificationBadge />}
          </div>

          {/* Real Name */}
          {user.real_name && (
            <p className="text-xl text-gray-400 mb-4">{user.real_name}</p>
          )}

          {/* Bio */}
          {user.bio && (
            <p className="text-base text-gray-300 mb-6 max-w-md">{user.bio}</p>
          )}

          {/* Stats */}
          <div className="flex gap-8 mb-6">
            <div>
              <span className="font-bold text-lg">{user.posts}</span>
              <span className="text-gray-400 ml-2">posts</span>
            </div>
            <div>
              <span className="font-bold text-lg">{user.followers.toLocaleString()}</span>
              <span className="text-gray-400 ml-2">followers</span>
            </div>
            <div>
              <span className="font-bold text-lg">{user.following}</span>
              <span className="text-gray-400 ml-2">following</span>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3">
            {isOwnProfile ? (
              <>
                <Link
                  href={`/profile/${user.username}/edit`}
                  className="px-6 py-2 rounded-lg font-semibold bg-gray-800 hover:bg-gray-700 transition"
                >
                  Edit profile
                </Link>
                <Link
                  href={`/profile/${user.username}/archive`}
                  className="px-6 py-2 rounded-lg font-semibold bg-gray-800 hover:bg-gray-700 transition"
                >
                  View archive
                </Link>
              </>
            ) : (
              <FollowButton userId={user.id} isFollowing={false} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
