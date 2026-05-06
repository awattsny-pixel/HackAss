'use client';

import { useState } from 'react';

interface ValidationPromptProps {
  hackId: string;
  onClose: () => void;
  onVote?: () => void;
}

export default function ValidationPrompt({ hackId, onClose, onVote }: ValidationPromptProps) {
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleVote = async (worked: boolean) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/hacks/${hackId}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worked }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to submit vote');
      }

      setSubmitted(true);
      onVote?.();

      // Close after delay
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Vote failed');
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg p-8 text-center max-w-sm">
          <div className="text-4xl mb-4">✓</div>
          <h3 className="text-xl font-bold text-gray-900 mb-2">Thanks for voting!</h3>
          <p className="text-gray-600">Your feedback helps us rank what actually works.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg p-6 max-w-sm w-full space-y-4">
        <div>
          <h3 className="text-lg font-bold text-gray-900 mb-2">Did this hack work for you?</h3>
          <p className="text-sm text-gray-600">
            Help others by sharing if you tried this hack.
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="space-y-2">
          <button
            onClick={() => handleVote(true)}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 bg-green-600 text-white font-semibold py-3 rounded-lg hover:bg-green-700 disabled:opacity-50 transition"
          >
            <span>✓</span> It worked
          </button>

          <button
            onClick={() => handleVote(false)}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 bg-red-600 text-white font-semibold py-3 rounded-lg hover:bg-red-700 disabled:opacity-50 transition"
          >
            <span>✕</span> Didn't work
          </button>
        </div>

        <button
          onClick={onClose}
          disabled={loading}
          className="w-full text-gray-600 font-semibold py-2 rounded-lg hover:bg-gray-100 disabled:opacity-50 transition"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
