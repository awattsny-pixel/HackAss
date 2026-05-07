'use client';

import { useState } from 'react';
import Link from 'next/link';

const CATEGORIES = [
  'Cooking',
  'Cleaning',
  'Money',
  'Travel',
  'Productivity',
  'Home',
  'Laundry',
  'Tech',
  'Beauty',
  'Fitness',
];

export default function SubmitPage() {
  const [formData, setFormData] = useState({
    title: '',
    category: 'Cooking',
    summary: '',
    description: '',
    steps: '',
    videoUrl: '',
  });

  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState<string>('');
  const [mediaType, setMediaType] = useState<'image' | 'video' | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleMediaChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Validate file size (max 50MB for videos, 5MB for images)
      const maxSize = file.type.startsWith('video/') ? 50 * 1024 * 1024 : 5 * 1024 * 1024;
      if (file.size > maxSize) {
        setError(`File must be less than ${file.type.startsWith('video/') ? '50MB' : '5MB'}`);
        return;
      }

      // Validate file type
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
        setError('Please upload an image or video file');
        return;
      }

      setMediaFile(file);
      setMediaType(file.type.startsWith('video/') ? 'video' : 'image');
      setError('');

      // Create preview
      const reader = new FileReader();
      reader.onloadend = () => {
        setMediaPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeMedia = () => {
    setMediaFile(null);
    setMediaPreview('');
    setMediaType(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Basic validation
    if (!formData.title.trim()) {
      setError('Title is required');
      return;
    }
    if (!formData.summary.trim()) {
      setError('Summary is required');
      return;
    }
    if (!formData.description.trim()) {
      setError('Description is required');
      return;
    }

    try {
      const submitData: any = { ...formData };

      // Include media (photo or video) as base64 if provided
      if (mediaFile && mediaPreview) {
        if (mediaType === 'video') {
          submitData.videoUpload = mediaPreview;
        } else {
          submitData.photo = mediaPreview;
        }
      }

      const response = await fetch('/api/hacks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitData),
      });

      if (!response.ok) {
        throw new Error('Failed to submit hack');
      }

      setSubmitted(true);
      setFormData({
        title: '',
        category: 'Cooking',
        summary: '',
        description: '',
        steps: '',
        videoUrl: '',
      });
      setMediaFile(null);
      setMediaPreview('');
      setMediaType(null);

      // Redirect after 2 seconds
      setTimeout(() => {
        window.location.href = '/browse';
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit hack');
    }
  };

  return (
    <div className="min-h-screen bg-black">
      {/* Header */}
      <div className="bg-gradient-to-b from-gray-900 via-blue-900/10 to-black border-b border-gray-800">
        <div className="max-w-4xl mx-auto px-4 py-16">
          <p className="text-gray-500 text-sm font-mono uppercase tracking-widest mb-4">
            SHARE YOUR KNOWLEDGE
          </p>
          <h1 className="text-5xl md:text-6xl font-bold mb-4">
            <span className="text-white">Submit a </span>
            <span className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">hack.</span>
          </h1>
          <p className="text-xl text-gray-400 max-w-2xl">
            Found something that actually works? Share it with 42,000+ hackers. Keep it short. Keep it real.
          </p>
        </div>
      </div>

      {/* Form */}
      <div className="max-w-2xl mx-auto px-4 py-16">
        {submitted && (
          <div className="mb-8 p-6 rounded-lg bg-emerald-900/20 border border-emerald-800 text-emerald-400">
            <p className="font-semibold mb-2">✓ Hack submitted!</p>
            <p className="text-sm">Thanks for sharing. Our team will review it shortly. Redirecting...</p>
          </div>
        )}

        {error && (
          <div className="mb-8 p-6 rounded-lg bg-red-900/20 border border-red-800 text-red-400">
            <p className="font-semibold">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-8">
          {/* Title */}
          <div>
            <label className="block text-sm font-semibold text-gray-300 mb-3">
              Hack title <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              name="title"
              value={formData.title}
              onChange={handleChange}
              placeholder="e.g., Remove burnt rice in 30 seconds"
              className="w-full px-4 py-3 rounded-lg bg-gray-900 border border-gray-700 text-white placeholder-gray-500 focus:border-emerald-500 focus:outline-none transition"
            />
            <p className="text-gray-500 text-xs mt-2 font-mono">Keep it short and descriptive</p>
          </div>

          {/* Category */}
          <div>
            <label className="block text-sm font-semibold text-gray-300 mb-3">
              Category <span className="text-red-400">*</span>
            </label>
            <select
              name="category"
              value={formData.category}
              onChange={handleChange}
              className="w-full px-4 py-3 rounded-lg bg-gray-900 border border-gray-700 text-white focus:border-emerald-500 focus:outline-none transition"
            >
              {CATEGORIES.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>

          {/* Photo/Video Upload */}
          <div>
            <label className="block text-sm font-semibold text-gray-300 mb-3">
              Photo or video <span className="text-gray-500 text-xs font-normal">(optional)</span>
            </label>

            {mediaPreview ? (
              <div className="space-y-3">
                <div className="relative rounded-lg overflow-hidden bg-gray-900 border border-gray-700">
                  {mediaType === 'video' ? (
                    <video
                      src={mediaPreview}
                      className="w-full h-48 object-cover bg-black"
                      controls
                    />
                  ) : (
                    <img
                      src={mediaPreview}
                      alt="Preview"
                      className="w-full h-48 object-cover"
                    />
                  )}
                </div>
                <button
                  type="button"
                  onClick={removeMedia}
                  className="text-sm text-red-400 hover:text-red-300 transition font-semibold"
                >
                  Remove {mediaType === 'video' ? 'video' : 'photo'}
                </button>
              </div>
            ) : (
              <label className="flex flex-col items-center justify-center w-full p-8 rounded-lg border-2 border-dashed border-gray-700 hover:border-emerald-500 transition cursor-pointer bg-gray-900/50">
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <svg className="w-8 h-8 text-gray-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  <p className="text-gray-400 text-sm">Click to upload or drag and drop</p>
                  <p className="text-gray-500 text-xs mt-1">PNG, JPG (5MB) or MP4, WebM (50MB)</p>
                </div>
                <input
                  type="file"
                  accept="image/*,video/*"
                  onChange={handleMediaChange}
                  className="hidden"
                />
              </label>
            )}
            <p className="text-gray-500 text-xs mt-2 font-mono">Upload a photo or video to help people understand your hack</p>
          </div>

          {/* Video Link (alternative) */}
          <div>
            <label className="block text-sm font-semibold text-gray-300 mb-3">
              Or paste a video link <span className="text-gray-500 text-xs font-normal">(instead of uploading)</span>
            </label>
            <input
              type="url"
              name="videoUrl"
              value={formData.videoUrl}
              onChange={handleChange}
              placeholder="YouTube, Vimeo, or TikTok link"
              className="w-full px-4 py-3 rounded-lg bg-gray-900 border border-gray-700 text-white placeholder-gray-500 focus:border-emerald-500 focus:outline-none transition"
            />
            <p className="text-gray-500 text-xs mt-2 font-mono">Add a link if you prefer not to upload</p>
          </div>

          {/* Summary */}
          <div>
            <label className="block text-sm font-semibold text-gray-300 mb-3">
              One-line summary <span className="text-red-400">*</span>
            </label>
            <textarea
              name="summary"
              value={formData.summary}
              onChange={handleChange}
              placeholder="What problem does this hack solve?"
              rows={2}
              maxLength={160}
              className="w-full px-4 py-3 rounded-lg bg-gray-900 border border-gray-700 text-white placeholder-gray-500 focus:border-emerald-500 focus:outline-none transition resize-none"
            />
            <div className="flex justify-between text-xs mt-2">
              <p className="text-gray-500 font-mono">Keep it punchy</p>
              <p className="text-gray-500 font-mono">{formData.summary.length}/160</p>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-semibold text-gray-300 mb-3">
              How it works <span className="text-red-400">*</span>
            </label>
            <textarea
              name="description"
              value={formData.description}
              onChange={handleChange}
              placeholder="Explain the hack. Why does it work? What are the steps?"
              rows={6}
              className="w-full px-4 py-3 rounded-lg bg-gray-900 border border-gray-700 text-white placeholder-gray-500 focus:border-emerald-500 focus:outline-none transition resize-none"
            />
            <p className="text-gray-500 text-xs mt-2 font-mono">Be clear but concise. No fluff.</p>
          </div>

          {/* Steps (optional) */}
          <div>
            <label className="block text-sm font-semibold text-gray-300 mb-3">
              Step-by-step breakdown <span className="text-gray-500 text-xs font-normal">(optional)</span>
            </label>
            <textarea
              name="steps"
              value={formData.steps}
              onChange={handleChange}
              placeholder="1. First thing
2. Second thing
3. Third thing"
              rows={4}
              className="w-full px-4 py-3 rounded-lg bg-gray-900 border border-gray-700 text-white placeholder-gray-500 focus:border-emerald-500 focus:outline-none transition resize-none font-mono text-sm"
            />
          </div>


          {/* Submit Button */}
          <div className="flex gap-4 pt-8">
            <button
              type="submit"
              disabled={submitted}
              className="flex-1 px-8 py-3 bg-gradient-to-r from-blue-600 to-emerald-600 text-white font-semibold rounded-lg hover:opacity-90 transition disabled:opacity-50"
            >
              {submitted ? 'Submitting...' : 'Submit hack'}
            </button>
            <Link
              href="/browse"
              className="px-8 py-3 border border-gray-600 text-white font-semibold rounded-lg hover:bg-gray-900 transition"
            >
              Cancel
            </Link>
          </div>
        </form>

        {/* Info Box */}
        <div className="mt-16 p-8 rounded-lg border border-gray-800 bg-gradient-to-br from-gray-900 to-black">
          <h3 className="text-lg font-bold text-white mb-4">Before you submit</h3>
          <ul className="space-y-3 text-gray-300 text-sm">
            <li className="flex gap-3">
              <span className="text-emerald-400 flex-shrink-0">✓</span>
              <span>Make sure you've actually tried this hack yourself</span>
            </li>
            <li className="flex gap-3">
              <span className="text-emerald-400 flex-shrink-0">✓</span>
              <span>Be honest about what works and what doesn't</span>
            </li>
            <li className="flex gap-3">
              <span className="text-emerald-400 flex-shrink-0">✓</span>
              <span>Keep it short — 3 steps is better than 10</span>
            </li>
            <li className="flex gap-3">
              <span className="text-emerald-400 flex-shrink-0">✓</span>
              <span>No spam, scams, or clickbait</span>
            </li>
            <li className="flex gap-3">
              <span className="text-emerald-400 flex-shrink-0">✓</span>
              <span>Our team reviews all submissions before they go live</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
