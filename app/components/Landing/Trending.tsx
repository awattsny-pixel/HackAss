'use client';

import Link from 'next/link';

export default async function Trending() {
  let hacks = [];
  let error = null;

  try {
    const res = await fetch('http://localhost:3000/api/hacks', { next: { revalidate: 60 } });
    if (res.ok) {
      const data = await res.json();
      hacks = data.hacks
        ?.slice(0, 5)
        ?.sort((a: any, b: any) => {
          const aRate = a.worked_votes / (a.worked_votes + a.failed_votes) || 0;
          const bRate = b.worked_votes / (b.worked_votes + b.failed_votes) || 0;
          return bRate - aRate;
        }) || [];
    }
  } catch (err) {
    error = 'Failed to load trending hacks';
    console.error('Trending fetch error:', err);
  }

  const getCategoryColor = (category: string) => {
    const colors: Record<string, string> = {
      Cooking: 'from-orange-500 to-orange-600',
      Cleaning: 'from-green-500 to-green-600',
      Money: 'from-cyan-500 to-cyan-600',
      Travel: 'from-purple-500 to-purple-600',
      Productivity: 'from-blue-500 to-blue-600',
      Home: 'from-amber-600 to-amber-700',
      Laundry: 'from-blue-400 to-blue-500',
      Tech: 'from-indigo-600 to-indigo-700',
      Beauty: 'from-pink-500 to-pink-600',
      Fitness: 'from-red-500 to-red-600',
    };
    return colors[category] || 'from-gray-500 to-gray-600';
  };

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
          <div className="space-y-3">
            {hacks.map((hack: any, i: number) => {
              const catColor = getCategoryColor(hack.category);
              return (
                <Link
                  key={hack.id}
                  href={`/browse`}
                  className={`group block p-6 rounded-xl border border-gray-800 hover:border-gray-700 bg-gradient-to-r from-gray-900 to-black hover:from-gray-800 hover:to-gray-900 transition`}
                >
                  <div className="flex items-start gap-6">
                    <div className="text-2xl font-bold text-gray-600 font-mono w-12 flex-shrink-0">
                      #{String(i + 1).padStart(2, '0')}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold text-white bg-gradient-to-r ${catColor}`}>
                          {hack.category}
                        </span>
                      </div>
                      <h3 className="text-xl font-bold text-white mb-2 group-hover:text-emerald-400 transition line-clamp-1">
                        {hack.title}
                      </h3>
                      <p className="text-gray-400 line-clamp-1">
                        {hack.summary || hack.description?.slice(0, 100)}
                      </p>
                    </div>

                    <div className="flex flex-col items-end gap-2 flex-shrink-0">
                      <div className="text-sm font-semibold text-emerald-400 font-mono">
                        ▲ {(hack.worked_votes || 0).toLocaleString()}
                      </div>
                      <div className="text-xs text-gray-500 font-mono">
                        {(hack.vote_count || hack.worked_votes || 0).toLocaleString()} votes
                      </div>
                    </div>
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
