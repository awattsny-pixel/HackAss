'use client';

import Link from 'next/link';

export default function Navigation() {
  return (
    <header className="sticky top-0 z-50 bg-black border-b border-gray-800">
      <nav className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
        {/* Logo with Mascot */}
        <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-emerald-500 flex items-center justify-center text-white font-bold text-sm">
            ⚡
          </div>
          <span className="text-2xl font-bold text-blue-500">hackass</span>
        </Link>

        {/* Center Navigation */}
        <div className="hidden md:flex items-center gap-8">
          <Link href="/browse" className="text-gray-300 hover:text-white transition">
            Browse
          </Link>
          <Link href="/categories" className="text-gray-300 hover:text-white transition">
            Categories
          </Link>
          <Link href="/submit" className="text-gray-300 hover:text-white transition">
            Submit
          </Link>
          <Link href="/manifesto" className="text-gray-300 hover:text-white transition">
            Manifesto
          </Link>
        </div>

        {/* Right: Auth Buttons */}
        <div className="flex items-center gap-4">
          <button className="text-gray-300 hover:text-white transition">
            Sign in
          </button>
          <button className="bg-white text-black font-semibold px-4 py-2 rounded-full hover:bg-gray-100 transition">
            Get the app
          </button>
        </div>
      </nav>
    </header>
  );
}
