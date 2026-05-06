'use client';

import Link from 'next/link';
import SubmitHackForm from '../components/SubmitHackForm';

export default function SubmitPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <Link href="/" className="text-blue-600 font-semibold hover:text-blue-700 mb-4 inline-block">
            ← Back to Feed
          </Link>
        </div>
      </header>

      {/* Form */}
      <SubmitHackForm />
    </div>
  );
}
