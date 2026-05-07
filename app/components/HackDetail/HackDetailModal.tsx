'use client';

import { useState, useEffect } from 'react';
import HackDetailContent from './HackDetailContent';

interface HackDetailModalProps {
  hackId: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function HackDetailModal({
  hackId,
  isOpen,
  onClose,
}: HackDetailModalProps) {
  const [hack, setHack] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const fetchHack = async () => {
      try {
        setLoading(true);
        setError(null);
        
        const response = await fetch(`/api/hacks/${hackId}`);
        const data = await response.json();
        
        if (!response.ok) {
          console.error('API Error:', data);
          throw new Error(data.details || 'Failed to fetch hack');
        }

        setHack(data);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        console.error('Error fetching hack:', errorMessage);
        setError(`Failed to load hack: ${errorMessage}`);
      } finally {
        setLoading(false);
      }
    };

    fetchHack();
  }, [hackId, isOpen]);

  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 overflow-y-auto"
      onClick={handleBackdropClick}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="fixed top-4 right-4 text-white hover:text-gray-300 z-51"
        aria-label="Close"
      >
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Modal content */}
      <div
        className="bg-black rounded-lg max-w-4xl max-h-[90vh] overflow-y-auto w-full my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {loading ? (
          <div className="flex items-center justify-center h-96">
            <p className="text-gray-400">Loading...</p>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-96 text-center">
            <div>
              <p className="text-red-400 font-semibold mb-2">Error Loading Hack</p>
              <p className="text-gray-400 text-sm">{error}</p>
            </div>
          </div>
        ) : hack ? (
          <HackDetailContent hack={hack} />
        ) : (
          <div className="flex items-center justify-center h-96">
            <p className="text-gray-400">Hack not found</p>
          </div>
        )}
      </div>
    </div>
  );
}
