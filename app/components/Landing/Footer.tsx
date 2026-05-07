'use client';

import Link from 'next/link';
import Image from 'next/image';

export default function Footer() {
  return (
    <footer className="bg-black border-t border-gray-800 py-16">
      <div className="max-w-7xl mx-auto px-4">
        {/* Top section with brand and links */}
        <div className="grid md:grid-cols-5 gap-12 mb-16">
          {/* Brand */}
          <div className="md:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <div className="relative w-8 h-8">
                <Image
                  src="/mascot.png"
                  alt="HackAss Mascot"
                  width={32}
                  height={32}
                  className="w-full h-full object-contain"
                />
              </div>
              <div className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
                hackass
              </div>
            </div>
            <p className="text-gray-500 text-sm">
              Crowdsourced life hacks. Voted by humans. Updated by minutes.
            </p>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-white font-semibold font-mono text-sm uppercase mb-4 tracking-wider">Product</h4>
            <div className="space-y-3">
              <Link href="/browse" className="text-gray-400 hover:text-white transition block text-sm">
                Browse
              </Link>
              <Link href="/submit" className="text-gray-400 hover:text-white transition block text-sm">
                Submit a hack
              </Link>
              <Link href="/top-creators" className="text-gray-400 hover:text-white transition block text-sm">
                Top creators
              </Link>
              <Link href="/" className="text-gray-400 hover:text-white transition block text-sm">
                Newsletter
              </Link>
            </div>
          </div>

          {/* Categories */}
          <div>
            <h4 className="text-white font-semibold font-mono text-sm uppercase mb-4 tracking-wider">Categories</h4>
            <div className="space-y-3">
              {['Cooking', 'Cleaning', 'Money', 'Travel'].map((cat) => (
                <Link
                  key={cat}
                  href={`/categories/${cat.toLowerCase()}`}
                  className="text-gray-400 hover:text-white transition block text-sm"
                >
                  {cat}
                </Link>
              ))}
            </div>
          </div>

          {/* Company */}
          <div>
            <h4 className="text-white font-semibold font-mono text-sm uppercase mb-4 tracking-wider">Company</h4>
            <div className="space-y-3">
              <Link href="/manifesto" className="text-gray-400 hover:text-white transition block text-sm">
                Manifesto
              </Link>
              <Link href="/" className="text-gray-400 hover:text-white transition block text-sm">
                Press
              </Link>
              <Link href="/" className="text-gray-400 hover:text-white transition block text-sm">
                Jobs
              </Link>
              <Link href="/" className="text-gray-400 hover:text-white transition block text-sm">
                Contact
              </Link>
            </div>
          </div>

          {/* Follow */}
          <div>
            <h4 className="text-white font-semibold font-mono text-sm uppercase mb-4 tracking-wider">Follow</h4>
            <div className="space-y-3">
              <a href="https://tiktok.com" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-white transition block text-sm">
                TikTok ↗
              </a>
              <a href="https://youtube.com" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-white transition block text-sm">
                YouTube ↗
              </a>
              <a href="https://reddit.com" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-white transition block text-sm">
                Reddit ↗
              </a>
              <a href="https://instagram.com" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-white transition block text-sm">
                Instagram ↗
              </a>
            </div>
          </div>
        </div>

        {/* Bottom section with copyright */}
        <div className="border-t border-gray-800 pt-8">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <span className="text-gray-600 text-sm font-mono">© 2026 HackAss Inc.</span>
            <span className="text-gray-600 text-sm">
              Made by people who got tired of scrolling 12 paragraphs to find the actual hack.
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
