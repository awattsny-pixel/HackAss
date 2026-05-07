'use client';

import { useState } from 'react';
import { useAuth } from '@/app/context/AuthContext';

interface FollowButtonProps {
  userId: string;
  isFollowing: boolean;
  onFollowChange?: (isFollowing: boolean) => void;
  className?: string;
}

export function FollowButton({
  userId,
  isFollowing: initialIsFollowing,
  onFollowChange,
  className = '',
}: FollowButtonProps) {
  const { user } = useAuth();
  const [isFollowing, setIsFollowing] = useState(initialIsFollowing);
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
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
      disabled={loading}
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
      {loading ? '...' : isFollowing ? 'Following' : 'Follow'}
    </button>
  );
}
