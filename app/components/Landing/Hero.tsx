'use client';

import Link from 'next/link';

export default function Hero() {
  return (
    <section className="relative min-h-screen bg-gradient-to-b from-gray-900 via-blue-900/20 to-black flex items-center overflow-hidden">
      {/* Animated background glows */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/20 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-teal-500/10 rounded-full blur-3xl animate-pulse" style={{animationDelay: '1s'}}></div>
        <div className="absolute inset-0 bg-gradient-to-br from-transparent via-transparent to-black/50"></div>
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 py-20 flex flex-col md:flex-row items-center gap-12">
        {/* Left: Copy */}
        <div className="flex-1 space-y-6">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gray-800/50 border border-gray-700">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            <span className="text-sm text-gray-300 font-mono">2,847 hacks • updated daily</span>
          </div>

          <h1 className="text-6xl md:text-7xl font-bold leading-tight">
            <span className="text-white">Life hacks that </span>
            <span className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">don't suck.</span>
          </h1>

          <p className="text-xl text-gray-400 max-w-md leading-relaxed">
            The internet's best <em className="text-white">actually-works</em> hacks — voted up by people who tried them. Cooking, cleaning, money, travel. No filler. No 12-paragraph SEO intros.
          </p>

          <div className="flex gap-4 pt-4">
            <Link href="/browse" className="px-8 py-3 bg-gradient-to-r from-blue-600 to-emerald-600 text-white font-semibold rounded-lg hover:opacity-90 transition">
              Start scrolling hacks ↗
            </Link>
            <Link href="/submit" className="px-8 py-3 border border-gray-600 text-white font-semibold rounded-lg hover:bg-gray-800 transition">
              Submit your hack
            </Link>
          </div>

          <div className="flex items-center gap-4 pt-4">
            <div className="flex -space-x-2">
              {[
                'from-amber-500 to-emerald-400',
                'from-purple-500 to-emerald-400',
                'from-emerald-500 to-emerald-300',
                'from-pink-500 to-emerald-400',
                'from-cyan-500 to-emerald-400',
              ].map((gradient, i) => (
                <div
                  key={i}
                  className={`w-8 h-8 rounded-full bg-gradient-to-br ${gradient} border-2 border-black`}
                ></div>
              ))}
            </div>
            <span className="text-sm text-gray-400 font-mono">42,108 hackers • ▲ 1.2M votes cast</span>
          </div>
        </div>

        {/* Right: Phone mockup placeholder (we'll add a real preview later) */}
        <div className="flex-1 h-[600px] rounded-3xl border-2 border-gray-700 bg-gradient-to-br from-gray-900 to-black flex items-center justify-center relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-b from-blue-500/5 to-transparent"></div>
          <div className="relative z-10 text-center">
            <div className="text-gray-600 text-sm font-mono mb-4">// HACK FEED PREVIEW</div>
            <div className="space-y-3 w-full px-4">
              <div className="bg-gray-800 rounded-lg p-4 animate-pulse">
                <div className="h-3 bg-gray-700 rounded w-3/4 mb-2"></div>
                <div className="h-2 bg-gray-700 rounded w-1/2"></div>
              </div>
              <div className="bg-gray-800 rounded-lg p-4 animate-pulse">
                <div className="h-3 bg-gray-700 rounded w-4/5 mb-2"></div>
                <div className="h-2 bg-gray-700 rounded w-2/3"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
