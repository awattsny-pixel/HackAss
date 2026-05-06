import Link from 'next/link';

export const metadata = {
  title: 'Categories - HackAss',
  description: 'Browse hacks by category.',
};

const CATEGORIES = [
  {
    name: 'Cooking',
    slug: 'cooking',
    count: 387,
    description: 'Kitchen shortcuts. Recipes that work. Cooking hacks that save time.',
    color: 'from-orange-500 to-orange-600',
  },
  {
    name: 'Cleaning',
    slug: 'cleaning',
    count: 312,
    description: 'Make your space cleaner. Remove stains. Organize better.',
    color: 'from-green-500 to-green-600',
  },
  {
    name: 'Money',
    slug: 'money',
    count: 445,
    description: 'Save money. Spend less. Earn more. Financial shortcuts.',
    color: 'from-cyan-500 to-cyan-600',
  },
  {
    name: 'Travel',
    slug: 'travel',
    count: 278,
    description: 'Travel cheaper. Pack smarter. Explore more.',
    color: 'from-purple-500 to-purple-600',
  },
  {
    name: 'Productivity',
    slug: 'productivity',
    count: 291,
    description: 'Work faster. Focus better. Get more done.',
    color: 'from-blue-500 to-blue-600',
  },
  {
    name: 'Home',
    slug: 'home',
    count: 334,
    description: 'Home improvements. DIY solutions. Make your space better.',
    color: 'from-amber-600 to-amber-700',
  },
  {
    name: 'Laundry',
    slug: 'laundry',
    count: 156,
    description: 'Wash clothes better. Remove stains. Care for fabrics.',
    color: 'from-blue-400 to-blue-500',
  },
  {
    name: 'Tech',
    slug: 'tech',
    count: 423,
    description: 'Phone tricks. Computer shortcuts. Tech life hacks.',
    color: 'from-indigo-600 to-indigo-700',
  },
  {
    name: 'Beauty',
    slug: 'beauty',
    count: 267,
    description: 'Skincare. Makeup tips. Look and feel better.',
    color: 'from-pink-500 to-pink-600',
  },
  {
    name: 'Fitness',
    slug: 'fitness',
    count: 354,
    description: 'Workouts. Diet tricks. Get healthier.',
    color: 'from-red-500 to-red-600',
  },
];

export default function CategoriesPage() {
  return (
    <div className="bg-black min-h-screen">
      {/* Header */}
      <div className="bg-gradient-to-b from-gray-900 via-blue-900/10 to-black border-b border-gray-800">
        <div className="max-w-7xl mx-auto px-4 py-20">
          <p className="text-gray-500 text-sm font-mono uppercase tracking-widest mb-4">
            BROWSE
          </p>
          <h1 className="text-6xl md:text-7xl font-bold mb-6">
            <span className="text-white">Ten worlds. </span>
            <span className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
              One click.
            </span>
          </h1>
          <p className="text-xl text-gray-400 max-w-2xl">
            Find hacks in the categories that matter to you. Organized by what people actually search for.
          </p>
        </div>
      </div>

      {/* Categories Grid */}
      <div className="max-w-7xl mx-auto px-4 py-24">
        <div className="grid md:grid-cols-2 lg:grid-cols-5 gap-4">
          {CATEGORIES.map((cat) => (
            <Link
              key={cat.slug}
              href={`/categories/${cat.slug}`}
              className={`group relative overflow-hidden rounded-xl border border-gray-800 hover:border-gray-700 transition p-8 bg-gradient-to-br from-gray-900 to-black hover:from-gray-800 hover:to-gray-900`}
            >
              <div className={`absolute inset-0 bg-gradient-to-br ${cat.color} opacity-0 group-hover:opacity-10 transition duration-300`}></div>

              <div className="relative z-10">
                {/* Icon */}
                <div className={`inline-block w-12 h-12 rounded-lg bg-gradient-to-br ${cat.color} mb-4 flex items-center justify-center text-2xl font-bold text-white`}>
                  {cat.name[0]}
                </div>

                {/* Name */}
                <h3 className="text-2xl font-bold text-white mb-3 group-hover:text-emerald-400 transition">
                  {cat.name}
                </h3>

                {/* Description */}
                <p className="text-gray-400 text-sm mb-4 h-10 line-clamp-2">
                  {cat.description}
                </p>

                {/* Count */}
                <div className="text-sm font-mono text-gray-500">
                  {cat.count.toLocaleString()} hacks
                </div>
              </div>

              {/* Bottom bar */}
              <div className={`absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r ${cat.color} transform scale-x-0 group-hover:scale-x-100 transition origin-left`}></div>
            </Link>
          ))}
        </div>

        {/* Stats Summary */}
        <div className="mt-24 grid md:grid-cols-3 gap-8 p-8 rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900 to-black">
          <div className="text-center">
            <div className="text-4xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent mb-2">
              {CATEGORIES.reduce((sum, cat) => sum + cat.count, 0).toLocaleString()}
            </div>
            <div className="text-gray-500 font-mono text-sm">total hacks</div>
          </div>
          <div className="text-center">
            <div className="text-4xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent mb-2">
              {CATEGORIES.length}
            </div>
            <div className="text-gray-500 font-mono text-sm">categories</div>
          </div>
          <div className="text-center">
            <div className="text-4xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent mb-2">
              1.2M+
            </div>
            <div className="text-gray-500 font-mono text-sm">votes cast</div>
          </div>
        </div>
      </div>
    </div>
  );
}
