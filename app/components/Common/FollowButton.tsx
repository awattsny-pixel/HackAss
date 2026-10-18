'use client';

import { useState } from 'react';
import { useAuth } from '@/app/context/AuthContext';

interface FollowButtonProps {
  userId: string;
  isFollowing?: boolean;
  /** Follow state cannot be established (no verified identity); render a disabled control. */
  unavailable?: boolean;
  onFollowChange?: (isFollowing: boolean) => void;
  className?: string;
}

export function FollowButton({
  userId,
  isFollowing: initialIsFollowing = false,
  unavailable = false,
  onFollowChange,
  className = '',
}: FollowButtonProps) {
  const { user } = useAuth();
  const [isFollowing, setIsFollowing] = useState(initialIsFollowing);
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (unavailable) return;
    if (!user) {
      // Redirect to login or show login modal
      window.location.href = '/auth/login';
      return;
    }

    setLoading(true);
    try {
      const token = localStorage.getItem('auth_token');
      if (!token) {
        window.location.href = '/auth/login';
        setLoading(false);
        return;
      }

      const method = isFollowing ? 'DELETE' : 'POST';
      const response = await fetch(`/api/follow/${userId}`, {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to update follow status');
      }

      const newState = !isFollowing;
      setIsFollowing(newState);
      onFollowChange?.(newState);
    } catch (error) {
      console.error('Error updating follow status:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={loading || unavailable}
      aria-disabled={unavailable || undefined}
      title={unavailable ? 'Following is temporarily unavailable' : undefined}
      className={`
        px-6 py-2 rounded-lg font-semibold transition
        ${isFollowing
          ? 'bg-gray-200 text-black hover:bg-gray-300'
          : 'bg-blue-500 text-white hover:bg-blue-600'
        }
        disabled:opacity-50 disabled:cursor-not-allowed
        ${className}
      `}
    >
      {unavailable ? 'Follow (unavailable)' : loading ? '...' : isFollowing ? 'Following' : 'Follow'}
    </button>
  );
}
