'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Image from 'next/image';
import { useAuth } from '@/app/context/AuthContext';
import { useRouter } from 'next/navigation';
import { HackerCardTrigger } from '@/app/components/HackerCard/HackerCardTrigger';
import { DEFAULT_HACKER_AVATAR } from '@/app/lib/constants';

interface Comment {
  id: string;
  content: string;
  created_at: string;
  user_id: string;
  users: {
    id: string;
    username: string;
    avatar: string;
  };
}

interface CommentMeta {
  hasMore: boolean;
}

interface CommentResponse {
  data: Comment[];
  meta: CommentMeta;
}

interface CommentSectionProps {
  hackId: string;
}

export default function CommentSection({ hackId }: CommentSectionProps) {
  const { user } = useAuth();
  const router = useRouter();
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchComments = useCallback(async (newOffset: number = 0) => {
    try {
      setLoading(true);
      const response = await fetch(
        `/api/hacks/${hackId}/comments?limit=20&offset=${newOffset}`
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.details || 'Failed to fetch comments');
      }

      const data = (await response.json()) as CommentResponse;
      if (newOffset === 0) {
        setComments(data.data);
      } else {
        setComments(prev => [...prev, ...data.data]);
      }
      setHasMore(data.meta.hasMore);
      setOffset(newOffset + data.data.length);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load comments';
      console.error('Error fetching comments:', message);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [hackId]);

  // Initial fetch
  useEffect(() => {
    fetchComments(0);
  }, [hackId, fetchComments]);

  // Poll for new comments every 5 seconds
  useEffect(() => {
    pollIntervalRef.current = setInterval(() => {
      fetchComments(0);
    }, 5000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [hackId, fetchComments]);

  const handleSubmitComment = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    if (!user) {
      router.push('/auth/login');
      return;
    }

    if (!commentText.trim()) {
      return;
    }

    setSubmitting(true);
    try {
      const token = localStorage.getItem('auth_token');
      if (!token) {
        router.push('/auth/login');
        setSubmitting(false);
        return;
      }

      const response = await fetch(`/api/hacks/${hackId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: commentText }),
      });

      if (!response.ok) throw new Error('Failed to post comment');

      const newComment = await response.json();
      setComments(prev => [newComment, ...prev]);
      setCommentText('');
      setError(null);
    } catch (err) {
      console.error('Error posting comment:', err);
      setError('Failed to post comment');
    } finally {
      setSubmitting(false);
    }
  }, [hackId, user, router, commentText]);

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div id="comments-section" className="mt-12">
      <h2 className="text-2xl font-bold text-white mb-6">Comments</h2>

      {/* Comment Input Form */}
      {user ? (
        <form onSubmit={handleSubmitComment} className="mb-8">
          <div className="bg-gray-900 rounded-lg p-4 mb-4">
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Share your thoughts..."
              maxLength={500}
              rows={3}
              className="w-full bg-gray-800 text-white placeholder-gray-500 rounded p-3 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex items-center justify-between mt-3">
              <span className="text-xs text-gray-400">
                {commentText.length}/500
              </span>
              <button
                type="submit"
                disabled={submitting || !commentText.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-semibold rounded transition"
              >
                {submitting ? 'Posting...' : 'Post'}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <div className="mb-8 bg-gray-900 rounded-lg p-4 text-center">
          <p className="text-gray-300 mb-3">
            Sign in to join the conversation
          </p>
          <button
            onClick={() => router.push('/auth/login')}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded transition"
          >
            Sign in
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 bg-red-900/20 border border-red-700 text-red-400 rounded p-3">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && comments.length === 0 && (
        <div className="text-center py-8">
          <p className="text-gray-400">Loading comments...</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && comments.length === 0 && (
        <div className="text-center py-8">
          <p className="text-gray-400">No comments yet. Be the first to share!</p>
        </div>
      )}

      {/* Comments List */}
      <div className="space-y-4">
        {comments.map((comment) => (
          <div key={comment.id} className="bg-gray-900 rounded-lg p-4">
            <div className="flex gap-3 mb-3">
              <Image
                src={comment.users.avatar || DEFAULT_HACKER_AVATAR}
                alt={comment.users.username}
                width={40}
                height={40}
                className="rounded-full flex-shrink-0"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <HackerCardTrigger username={comment.users.username}>
                    <span className="text-white font-semibold hover:underline cursor-pointer">
                      {comment.users.username}
                    </span>
                  </HackerCardTrigger>
                  <span className="text-xs text-gray-500">
                    {formatTime(comment.created_at)}
                  </span>
                </div>
                <p className="text-gray-300 mt-1 text-sm break-words">
                  {comment.content}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Load More Button */}
      {hasMore && comments.length > 0 && (
        <button
          onClick={() => fetchComments(offset)}
          disabled={loading}
          className="mt-6 w-full py-3 bg-gray-800 hover:bg-gray-700 disabled:bg-gray-900 disabled:cursor-not-allowed text-gray-300 font-semibold rounded transition"
        >
          {loading ? 'Loading...' : 'Load more comments'}
        </button>
      )}
    </div>
  );
}
