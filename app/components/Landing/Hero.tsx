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

        {/* Right: Hack Feed Preview */}
        <div className="flex-1 h-[600px] rounded-3xl border-2 border-gray-700 bg-gradient-to-br from-gray-900 to-black flex flex-col relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-b from-blue-500/5 to-transparent"></div>

          {/* Header */}
          <div className="relative z-10 p-6 border-b border-gray-800">
            <div className="text-gray-600 text-xs font-mono tracking-wider">// HACK FEED PREVIEW</div>
          </div>

          {/* Feed Cards */}
          <div className="relative z-10 flex-1 overflow-y-auto space-y-3 p-4">
            {/* Hack Card 1 */}
            <Link href="/categories/cooking" className="bg-gray-800/40 rounded-2xl border border-gray-700 hover:border-emerald-600/50 transition overflow-hidden flex min-h-28 cursor-pointer">
              {/* Left: Text content */}
              <div className="flex-1 p-4 flex flex-col justify-between">
                <div>
                  <div className="inline-block px-2 py-1 rounded text-xs font-semibold text-white bg-gradient-to-r from-orange-500 to-orange-600 mb-2 w-fit">
                    Cooking
                  </div>
                  <h4 className="text-sm font-bold text-white mb-1">
                    Remove burnt rice in 30 seconds
                  </h4>
                  <p className="text-xs text-gray-400 mb-2">
                    Add water and heat. The burnt layer comes right off.
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-gray-500">by Sarah Chen</p>
                  <p className="text-emerald-400 font-mono text-xs">▲ 2.8k votes</p>
                </div>
              </div>
              {/* Right: Image thumbnail */}
              <div className="w-40 h-40 bg-gradient-to-br from-orange-500/30 via-orange-400/20 to-amber-600/30 flex items-center justify-center border-l border-gray-700 flex-shrink-0">
                <span className="text-8xl">🍚</span>
              </div>
            </Link>

            {/* Hack Card 2 */}
            <Link href="/categories/money" className="bg-gray-800/40 rounded-2xl border border-gray-700 hover:border-emerald-600/50 transition overflow-hidden flex min-h-28 cursor-pointer">
              {/* Left: Text content */}
              <div className="flex-1 p-4 flex flex-col justify-between">
                <div>
                  <div className="inline-block px-2 py-1 rounded text-xs font-semibold text-white bg-gradient-to-r from-cyan-500 to-cyan-600 mb-2 w-fit">
                    Money
                  </div>
                  <h4 className="text-sm font-bold text-white mb-1">
                    Save $50/month on phone bill
                  </h4>
                  <p className="text-xs text-gray-400 mb-2">
                    Call customer service. Ask for loyalty discount.
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-gray-500">by Mike Torres</p>
                  <p className="text-emerald-400 font-mono text-xs">▲ 1.2k votes</p>
                </div>
              </div>
              {/* Right: Image thumbnail */}
              <div className="w-40 h-40 bg-gradient-to-br from-cyan-500/30 via-blue-400/20 to-blue-600/30 flex items-center justify-center border-l border-gray-700 flex-shrink-0">
                <span className="text-8xl">💰</span>
              </div>
            </Link>

            {/* Hack Card 3 */}
            <Link href="/categories/cleaning" className="bg-gray-800/40 rounded-2xl border border-gray-700 hover:border-emerald-600/50 transition overflow-hidden flex min-h-28 cursor-pointer">
              {/* Left: Text content */}
              <div className="flex-1 p-4 flex flex-col justify-between">
                <div>
                  <div className="inline-block px-2 py-1 rounded text-xs font-semibold text-white bg-gradient-to-r from-green-500 to-green-600 mb-2 w-fit">
                    Cleaning
                  </div>
                  <h4 className="text-sm font-bold text-white mb-1">
                    Clean shower in 5 minutes
                  </h4>
                  <p className="text-xs text-gray-400 mb-2">
                    Vinegar spray + squeegee. That's it.
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-gray-500">by Jessica Park</p>
                  <p className="text-emerald-400 font-mono text-xs">▲ 3.4k votes</p>
                </div>
              </div>
              {/* Right: Image thumbnail */}
              <div className="w-40 h-40 bg-gradient-to-br from-green-500/30 via-emerald-400/20 to-teal-600/30 flex items-center justify-center border-l border-gray-700 flex-shrink-0">
                <span className="text-8xl">✨</span>
              </div>
            </Link>
          </div>

          {/* Footer CTA */}
          <div className="relative z-10 border-t border-gray-800 bg-black/40 p-4">
            <button className="w-full text-xs text-center text-emerald-400 hover:text-emerald-300 font-semibold transition py-2">
              See all 2,847 hacks →
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
