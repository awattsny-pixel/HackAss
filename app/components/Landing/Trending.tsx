import Link from 'next/link';

const CATEGORY_STYLES: Record<string, { color: string; emoji: string; bgGradient: string; borderColor: string; badgeColor: string }> = {
  Cooking: { color: 'bg-orange-500', emoji: '🍳', bgGradient: 'from-amber-700 via-amber-600 to-orange-700', borderColor: 'border-orange-500', badgeColor: 'bg-orange-500' },
  Cleaning: { color: 'bg-green-500', emoji: '✨', bgGradient: 'from-green-700 via-green-600 to-emerald-700', borderColor: 'border-green-500', badgeColor: 'bg-green-500' },
  Money: { color: 'bg-cyan-500', emoji: '💰', bgGradient: 'from-teal-700 via-cyan-600 to-blue-700', borderColor: 'border-cyan-500', badgeColor: 'bg-cyan-500' },
  Travel: { color: 'bg-violet-500', emoji: '✈️', bgGradient: 'from-purple-700 via-purple-600 to-indigo-700', borderColor: 'border-violet-500', badgeColor: 'bg-violet-500' },
  Productivity: { color: 'bg-blue-500', emoji: '⚡', bgGradient: 'from-blue-700 via-blue-600 to-cyan-700', borderColor: 'border-blue-500', badgeColor: 'bg-blue-500' },
  Home: { color: 'bg-orange-500', emoji: '🏠', bgGradient: 'from-amber-700 via-orange-600 to-orange-700', borderColor: 'border-orange-500', badgeColor: 'bg-orange-500' },
  Laundry: { color: 'bg-sky-500', emoji: '👕', bgGradient: 'from-cyan-700 via-blue-600 to-teal-700', borderColor: 'border-sky-500', badgeColor: 'bg-sky-500' },
  Tech: { color: 'bg-indigo-500', emoji: '💻', bgGradient: 'from-indigo-700 via-indigo-600 to-purple-700', borderColor: 'border-indigo-500', badgeColor: 'bg-indigo-500' },
  Beauty: { color: 'bg-pink-500', emoji: '💄', bgGradient: 'from-pink-700 via-pink-600 to-rose-700', borderColor: 'border-pink-500', badgeColor: 'bg-pink-500' },
  Fitness: { color: 'bg-red-500', emoji: '💪', bgGradient: 'from-red-700 via-red-600 to-orange-700', borderColor: 'border-red-500', badgeColor: 'bg-red-500' },
};

function getCategoryColor(category: string): string {
  return CATEGORY_STYLES[category]?.color || 'bg-gray-500';
}

function getCategoryGlowColor(category: string): string {
  const glowColors: Record<string, string> = {
    Cooking: '#FF9500',
    Cleaning: '#4CAF50',
    Money: '#00BCD4',
    Travel: '#9C27B0',
    Productivity: '#2196F3',
    Home: '#FF9500',
    Laundry: '#00BCD4',
    Tech: '#6366F1',
    Beauty: '#E91E63',
    Fitness: '#F44336',
  };
  return glowColors[category] || '#6b7280';
}

function getCategoryBackgroundColor(category: string): string {
  const bgColors: Record<string, string> = {
    Cooking: '#8B6F47',
    Cleaning: '#2D5A3D',
    Money: '#1B7A8F',
    Travel: '#5E35B1',
    Productivity: '#1565C0',
    Home: '#8B6F47',
    Laundry: '#00838F',
    Tech: '#3F51B5',
    Beauty: '#AD1457',
    Fitness: '#C62828',
  };
  return bgColors[category] || '#8B6F47';
}

export default async function Trending() {
  let hacks = [];
  let error = null;

  try {
    const res = await fetch('/api/hacks', { next: { revalidate: 60 } });
    if (res.ok) {
      const data = await res.json();
      hacks = data.hacks
        ?.sort((a: any, b: any) => {
          return (b.worked_votes + b.failed_votes) - (a.worked_votes + a.failed_votes);
        })
        ?.slice(0, 5) || [];
    }
  } catch (err) {
    error = 'Failed to load trending hacks';
    console.error('Trending fetch error:', err);
  }

  return (
    <section className="bg-black py-24">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-16">
          <div>
            <p className="text-gray-500 text-sm font-mono uppercase tracking-widest mb-4">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 mr-2"></span>
              TRENDING NOW
            </p>
            <h2 className="text-5xl md:text-6xl font-bold">
              <span className="text-white">Top of the feed,</span>
              <br />
              <span className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">this week.</span>
            </h2>
          </div>
          <Link href="/browse" className="text-emerald-400 hover:text-emerald-300 font-semibold transition">
            See all 2,847 →
          </Link>
        </div>

        {error && (
          <div className="text-center py-12 text-gray-500">
            {error}
          </div>
        )}

        {!error && hacks.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            Loading trending hacks...
          </div>
        )}

        {hacks.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {hacks.map((hack: any) => {
              const normalizedCategory = hack.category.charAt(0).toUpperCase() + hack.category.slice(1).toLowerCase();
              const slug = hack.category.toLowerCase();
              const catColor = getCategoryColor(normalizedCategory);
              const catStyle = CATEGORY_STYLES[normalizedCategory] || CATEGORY_STYLES['Cooking'];
              const totalVotes = (hack.worked_votes || 0) + (hack.failed_votes || 0);

              return (
                <Link
                  key={hack.id}
                  href={`/categories/${slug}`}
                  className={`group block rounded-xl border-l-4 ${catStyle.borderColor} border border-gray-800 hover:border-gray-700 bg-gray-900/50 backdrop-blur transition overflow-hidden flex h-full cursor-pointer`}
                  style={{
                    boxShadow: `0 0 20px ${getCategoryGlowColor(normalizedCategory)}40`
                  }}
                >
                  {/* Left: Text content */}
                  <div className="flex-1 p-5 flex flex-col justify-between">
                    <div>
                      <span
                        className={`inline-block px-3 py-1.5 rounded-lg text-xs font-bold text-white mb-3 w-fit uppercase tracking-wide`}
                        style={{ backgroundColor: getCategoryGlowColor(normalizedCategory) }}
                      >
                        {hack.category}
                      </span>
                      <h3 className="text-base font-bold text-white mb-2 line-clamp-2 group-hover:text-emerald-400 transition">
                        {hack.title}
                      </h3>
                      <p className="text-xs text-gray-400 line-clamp-2 leading-relaxed">
                        {hack.summary || hack.description?.slice(0, 80)}
                      </p>
                    </div>
                    <div className="pt-3 border-t border-gray-700">
                      <p className="text-xs text-gray-500 mb-2">Hacked By {hack.source_attribution || 'Anonymous'}</p>
                      <p className="text-emerald-400 font-mono font-bold text-sm">▲ {totalVotes.toLocaleString()} votes</p>
                    </div>
                  </div>

                  {/* Right: Full-height emoji thumbnail */}
                  <div
                    className="w-48 flex-shrink-0 items-center justify-center border-l border-gray-700 hidden md:flex"
                    style={{ backgroundColor: getCategoryBackgroundColor(normalizedCategory) }}
                  >
                    <span className="text-9xl">{catStyle.emoji}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
