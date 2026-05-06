'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type ContentType = 'video' | 'photo' | 'link';

interface FormState {
  title: string;
  description: string;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard';
  why_it_works: string;
  content_type: ContentType;
  content_url: string;
  file?: File;
}

const CATEGORIES = [
  'Cleaning & laundry',
  'Cooking & food',
  'Money & shopping',
  'Home & DIY',
  'Health & beauty',
];

const CONSTRAINTS = {
  VIDEO: { maxSize: 100 * 1024 * 1024, formats: ['video/mp4', 'video/quicktime'] },
  PHOTO: { maxSize: 20 * 1024 * 1024, formats: ['image/jpeg', 'image/png'] },
};

export default function SubmitHackForm() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>({
    title: '',
    description: '',
    category: '',
    difficulty: 'easy',
    why_it_works: '',
    content_type: 'video',
    content_url: '',
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [extracting, setExtracting] = useState(false);

  // Validate file constraints
  const validateFile = (file: File, type: ContentType): string | null => {
    const constraints = type === 'video' ? CONSTRAINTS.VIDEO : CONSTRAINTS.PHOTO;

    if (!constraints.formats.includes(file.type)) {
      return `Invalid format. Accepted: ${type === 'video' ? 'MP4, MOV' : 'JPG, PNG'}`;
    }

    if (file.size > constraints.maxSize) {
      const maxMB = constraints.maxSize / (1024 * 1024);
      return `File too large. Max ${maxMB}MB`;
    }

    return null;
  };

  // Handle file selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validationError = validateFile(file, form.content_type);
    if (validationError) {
      setError(validationError);
      return;
    }

    setForm({ ...form, file });
    setError(null);
  };

  // Extract metadata from URL
  const handleExtractUrl = async () => {
    if (!form.content_url) {
      setError('Please enter a URL');
      return;
    }

    setExtracting(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/extract-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: form.content_url }),
      });

      if (!response.ok) {
        throw new Error('Failed to extract metadata');
      }

      const { data } = await response.json();
      setForm((prev) => ({
        ...prev,
        title: data.title || prev.title,
        description: data.description || prev.description,
      }));
    } catch (err) {
      setError('Could not extract from URL. Please fill manually.');
    } finally {
      setExtracting(false);
    }
  };

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate required fields
    if (!form.title || !form.description || !form.category) {
      setError('Please fill all required fields');
      return;
    }

    // Validate content
    if (form.content_type === 'link' && !form.content_url) {
      setError('Please provide a URL or upload content');
      return;
    }

    if ((form.content_type === 'video' || form.content_type === 'photo') && !form.file) {
      setError(`Please upload a ${form.content_type}`);
      return;
    }

    setLoading(true);

    try {
      // For MVP, we'll accept file uploads and external links separately
      // File uploads will require a separate multipart endpoint (Phase 2)
      // For now, we'll just handle external links and file references

      const payload = {
        title: form.title,
        description: form.description,
        category: form.category,
        difficulty: form.difficulty,
        why_it_works: form.why_it_works,
        content_type: form.content_type,
        content_url: form.content_url || form.file?.name || '',
      };

      const response = await fetch('/api/hacks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to submit hack');
      }

      setSuccess(true);
      setTimeout(() => {
        router.push('/');
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setLoading(false);
    }
  };

  // Drag and drop handler
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const file = e.dataTransfer.files?.[0];
    if (file) {
      const validationError = validateFile(file, form.content_type);
      if (validationError) {
        setError(validationError);
        return;
      }
      setForm({ ...form, file });
      setError(null);
    }
  };

  if (success) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-green-50">
        <div className="bg-white p-8 rounded-lg shadow-lg text-center">
          <h2 className="text-2xl font-bold text-green-600 mb-2">Success!</h2>
          <p className="text-gray-700 mb-4">Your hack has been submitted and is pending admin approval.</p>
          <p className="text-sm text-gray-500">Redirecting to home...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white p-4">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">Share Your Hack</h1>
          <p className="text-gray-600">Help others discover what actually works</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-lg p-8 space-y-6">
          {/* Title */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Hack Title *
            </label>
            <input
              type="text"
              value={form.title ?? ''}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g., Remove stains from white shirts"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Description *
            </label>
            <textarea
              value={form.description ?? ''}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Describe the hack in detail..."
              rows={4}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition resize-none"
            />
          </div>

          {/* Category */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Category *
            </label>
            <select
              value={form.category ?? ''}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
            >
              <option value="">Select a category</option>
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
              <option value="other">Other (suggest new)</option>
            </select>
          </div>

          {/* Difficulty */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Difficulty</label>
            <div className="flex gap-4">
              {['easy', 'medium', 'hard'].map((level) => (
                <label key={level} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="difficulty"
                    value={level}
                    checked={form.difficulty === level}
                    onChange={(e) => setForm({ ...form, difficulty: e.target.value as any })}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span className="text-gray-700 capitalize">{level}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Why it works */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Why It Works *
            </label>
            <textarea
              value={form.why_it_works ?? ''}
              onChange={(e) => setForm({ ...form, why_it_works: e.target.value })}
              placeholder="Explain the science behind why this hack works..."
              rows={3}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition resize-none"
            />
          </div>

          {/* Content Type Selection */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-3">
              How will you share this hack? *
            </label>
            <div className="grid grid-cols-3 gap-4">
              {(['video', 'photo', 'link'] as ContentType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setForm({ ...form, content_type: type })}
                  className={`p-4 rounded-lg border-2 transition text-center ${
                    form.content_type === type
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-300 hover:border-gray-400'
                  }`}
                >
                  <div className="text-2xl mb-2">
                    {type === 'video' ? '🎥' : type === 'photo' ? '📷' : '🔗'}
                  </div>
                  <div className="font-semibold text-gray-900 capitalize">{type}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {type === 'video' ? '100MB' : type === 'photo' ? '20MB' : 'Link'}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Content Upload/URL - Always rendered to avoid controlled/uncontrolled mismatch */}
          <div className={form.content_type === 'link' ? '' : 'hidden'}>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Video URL *
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                value={form.content_url}
                onChange={(e) => setForm({ ...form, content_url: e.target.value })}
                placeholder="Paste YouTube, TikTok, Reddit, or Instagram link..."
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
              />
              <button
                type="button"
                onClick={handleExtractUrl}
                disabled={extracting}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 disabled:opacity-50 transition"
              >
                {extracting ? 'Extracting...' : 'Extract'}
              </button>
            </div>
          </div>

          <div className={form.content_type !== 'link' ? '' : 'hidden'}>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Upload {form.content_type === 'video' ? 'Video' : 'Photo'} *
            </label>
            <div
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-500 transition cursor-pointer bg-gray-50"
            >
              <input
                type="file"
                id="file-input"
                onChange={handleFileChange}
                accept={form.content_type === 'video' ? 'video/mp4,video/quicktime' : 'image/jpeg,image/png'}
                className="hidden"
              />
              <label htmlFor="file-input" className="cursor-pointer">
                <div className="text-4xl mb-2">
                  {form.content_type === 'video' ? '🎥' : '📷'}
                </div>
                <p className="font-semibold text-gray-700 mb-1">
                  Drag and drop your {form.content_type} here
                </p>
                <p className="text-sm text-gray-500">
                  or click to select (max {form.content_type === 'video' ? '100MB' : '20MB'})
                </p>
                {form.file && (
                  <p className="mt-2 text-sm text-green-600 font-semibold">{form.file.name}</p>
                )}
              </label>
            </div>
          </div>

          {/* Error message */}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
              {error}
            </div>
          )}

          {/* Submit button */}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white font-semibold py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
          >
            {loading ? 'Submitting...' : 'Submit Hack'}
          </button>

          <p className="text-xs text-gray-500 text-center">
            ✓ Your hack will be reviewed by our team before appearing in the feed.
          </p>
        </form>
      </div>
    </div>
  );
}
