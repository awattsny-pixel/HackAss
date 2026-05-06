'use client';

import Link from 'next/link';

const CATEGORIES = [
  { name: 'Cooking', color: 'from-orange-500 to-orange-600', count: 387 },
  { name: 'Cleaning', color: 'from-green-500 to-green-600', count: 312 },
  { name: 'Money', color: 'from-cyan-500 to-cyan-600', count: 445 },
  { name: 'Travel', color: 'from-purple-500 to-purple-600', count: 278 },
  { name: 'Productivity', color: 'from-blue-500 to-blue-600', count: 291 },
  { name: 'Home', color: 'from-amber-600 to-amber-700', count: 334 },
  { name: 'Laundry', color: 'from-blue-400 to-blue-500', count: 156 },
  { name: 'Tech', color: 'from-indigo-600 to-indigo-700', count: 423 },
  { name: 'Beauty', color: 'from-pink-500 to-pink-600', count: 267 },
  { name: 'Fitness', color: 'from-red-500 to-red-600', count: 354 },
];

export default function Categories() {
  return (
    <section className="bg-black py-24">
      <div className="max-w-7xl mx-auto px-4">
        <div className="mb-16">
          <p className="text-gray-500 text-sm font-mono uppercase tracking-widest mb-4">// CATEGORIES</p>
          <h2 className="text-5xl md:text-6xl font-bold mb-4">
            <span className="text-white">Ten worlds. </span>
            <span className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">One scroll.</span>
          </h2>
          <p className="text-gray-400 text-lg max-w-2xl">
            We started with the categories people actually search for — not the ones a content team thought sounded good.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {CATEGORIES.map((cat) => (
            <Link
              key={cat.name}
              href={`/categories/${cat.name.toLowerCase()}`}
              className="group relative overflow-hidden rounded-xl border border-gray-800 hover:border-gray-700 transition p-6 bg-gradient-to-br from-gray-900 to-black hover:from-gray-800 hover:to-gray-900"
            >
              <div className={`absolute inset-0 bg-gradient-to-br ${cat.color} opacity-0 group-hover:opacity-10 transition duration-300`}></div>

              <div className="relative z-10">
                <div className={`inline-block w-10 h-10 rounded-lg bg-gradient-to-br ${cat.color} mb-4 flex items-center justify-center text-lg font-bold text-white`}>
                  {cat.name[0]}
                </div>

                <h3 className="text-white font-bold text-lg mb-2">{cat.name}</h3>

                <p className="text-gray-500 text-sm font-mono">
                  {cat.count} hacks <span className="text-gray-600 ml-2">↗</span>
                </p>
              </div>

              <div className={`absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r ${cat.color} transform scale-x-0 group-hover:scale-x-100 transition origin-left`}></div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
