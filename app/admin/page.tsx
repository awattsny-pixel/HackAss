'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';

interface PendingHack {
  id: string;
  title: string;
  description: string;
  content_url: string;
  content_thumbnail?: string;
  content_type: string;
  source_attribution: string;
  created_at: string;
  status: string;
}

export default function AdminDashboard() {
  const [hacks, setHacks] = useState<PendingHack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    fetchPendingHacks();
  }, []);

  const fetchPendingHacks = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/hacks');

      if (!response.ok) {
        throw new Error('Failed to fetch pending hacks');
      }

      const data = await response.json();
      setHacks(data.hacks || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load hacks');
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (hackId: string) => {
    setProcessing(hackId);

    try {
      const response = await fetch(`/api/admin/hacks/${hackId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to approve hack');
      }

      // Remove from pending list
      setHacks((prev) => prev.filter((h) => h.id !== hackId));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to approve');
    } finally {
      setProcessing(null);
    }
  };

  const handleReject = async (hackId: string) => {
    if (!confirm('Are you sure you want to reject this hack?')) return;

    setProcessing(hackId);

    try {
      const response = await fetch(`/api/admin/hacks/${hackId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: false }),
      });

      if (!response.ok) {
        throw new Error('Failed to reject hack');
      }

      // Remove from pending list
      setHacks((prev) => prev.filter((h) => h.id !== hackId));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to reject');
    } finally {
      setProcessing(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="flex items-center justify-between">
            <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
            <Link href="/" className="text-blue-600 font-semibold hover:text-blue-700">
              Back to Feed →
            </Link>
          </div>
          <p className="text-gray-600 mt-2">Review and approve user submissions</p>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Stats */}
        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h2 className="text-xl font-bold text-gray-900 mb-2">
            {hacks.length} pending hack{hacks.length !== 1 ? 's' : ''}
          </h2>
          <p className="text-gray-600">
            {hacks.length === 0
              ? 'All caught up! No pending submissions.'
              : 'Review and approve user submissions below.'}
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-8">
            {error}
            <button
              onClick={fetchPendingHacks}
              className="ml-4 font-semibold underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        )}

        {/* Hacks Grid */}
        {!loading && hacks.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {hacks.map((hack) => {
              // Get embed URL for videos
              const getEmbedUrl = () => {
                const url = hack.content_url;
                if (!url) return null;

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

                return null;
              };

              return (
                <div key={hack.id} className="bg-white rounded-lg shadow overflow-hidden">
                  {/* Thumbnail/Video Preview */}
                  {hack.content_url && (
                    <div className="relative w-full bg-gray-200" style={{ aspectRatio: hack.content_type === 'photo' ? '1' : '16 / 9' }}>
                      {hack.content_type === 'photo' ? (
                        <Image
                          src={hack.content_url}
                          alt={hack.title}
                          fill
                          className="object-cover"
                        />
                      ) : hack.content_type === 'video' && getEmbedUrl() ? (
                        <iframe
                          src={getEmbedUrl()}
                          width="100%"
                          height="100%"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                          className="w-full h-full"
                          title={hack.title}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gray-300 text-gray-600 text-4xl">
                          {hack.content_type === 'video' ? '🎥' : '🔗'}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Content */}
                  <div className="p-6 space-y-4">
                    <div>
                      <h3 className="text-xl font-bold text-gray-900 mb-2">{hack.title}</h3>
                      <p className="text-gray-600 line-clamp-3">{hack.description}</p>
                    </div>

                    <div className="text-sm text-gray-500 border-t pt-4">
                      <p>
                        <span className="font-semibold">Type:</span> {hack.content_type}
                      </p>
                      <p>
                        <span className="font-semibold">From:</span> {hack.source_attribution}
                      </p>
                      <p>
                        <span className="font-semibold">Submitted:</span>{' '}
                        {new Date(hack.created_at).toLocaleDateString()}
                      </p>
                      {hack.content_url && (
                        <p className="break-all">
                          <span className="font-semibold">URL:</span>{' '}
                          <a
                            href={hack.content_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                          >
                            {hack.content_url.substring(0, 50)}...
                          </a>
                        </p>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2 pt-4">
                      <button
                        onClick={() => handleApprove(hack.id)}
                        disabled={processing === hack.id}
                        className="flex-1 bg-green-600 text-white font-semibold py-2 rounded-lg hover:bg-green-700 disabled:opacity-50 transition"
                      >
                        {processing === hack.id ? 'Processing...' : '✓ Approve'}
                      </button>
                      <button
                        onClick={() => handleReject(hack.id)}
                        disabled={processing === hack.id}
                        className="flex-1 bg-red-600 text-white font-semibold py-2 rounded-lg hover:bg-red-700 disabled:opacity-50 transition"
                      >
                        {processing === hack.id ? 'Processing...' : '✕ Reject'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Empty State */}
        {!loading && hacks.length === 0 && (
          <div className="bg-white rounded-lg shadow p-12 text-center">
            <p className="text-2xl mb-4">🎉</p>
            <p className="text-gray-600 text-lg">All caught up! No pending submissions.</p>
          </div>
        )}
      </div>
    </div>
  );
}
