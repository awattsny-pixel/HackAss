import Link from 'next/link';

export const metadata = {
  title: 'Top Creators - HackAss',
  description: 'The people behind the best hacks.',
};

export default function TopCreatorsPage() {
  // Mock data for top creators
  const creators = [
    {
      id: 1,
      name: 'Sarah Chen',
      hacks: 47,
      votes: 12840,
      category: 'Cooking',
      bio: 'Food scientist & home chef. Obsessed with shortcuts that actually work.',
    },
    {
      id: 2,
      name: 'Marcus Johnson',
      hacks: 34,
      votes: 9230,
      category: 'Cleaning',
      bio: 'Professional organizer turned hacker. Less mess, more life.',
    },
    {
      id: 3,
      name: 'Alex Rivera',
      hacks: 52,
      votes: 15620,
      category: 'Money',
      bio: 'Personal finance nerd. Saves thousands, shares freely.',
    },
    {
      id: 4,
      name: 'Jordan Kim',
      hacks: 38,
      votes: 10950,
      category: 'Tech',
      bio: 'Software engineer. Makes life easier with code and creativity.',
    },
    {
      id: 5,
      name: 'Sophie Martin',
      hacks: 41,
      votes: 11340,
      category: 'Travel',
      bio: 'Backpacker & travel hacker. Explores cheap but awesome.',
    },
    {
      id: 6,
      name: 'David Lee',
      hacks: 29,
      votes: 8120,
      category: 'Fitness',
      bio: 'Fitness coach. Workouts that fit your schedule, not the other way.',
    },
  ];

  return (
    <div className="bg-black min-h-screen">
      {/* Header */}
      <div className="bg-gradient-to-b from-gray-900 via-blue-900/10 to-black border-b border-gray-800">
        <div className="max-w-7xl mx-auto px-4 py-20">
          <p className="text-gray-500 text-sm font-mono uppercase tracking-widest mb-4">
            COMMUNITY
          </p>
          <h1 className="text-6xl md:text-7xl font-bold mb-6">
            <span className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
              Top creators.
            </span>
          </h1>
          <p className="text-xl text-gray-400 max-w-2xl">
            The people whose hacks actually changed lives. Real people. Real expertise. Real results.
          </p>
        </div>
      </div>

      {/* Creators Grid */}
      <div className="max-w-7xl mx-auto px-4 py-24">
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {creators.map((creator) => (
            <div
              key={creator.id}
              className="group relative overflow-hidden rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900 to-black p-8 hover:border-gray-700 transition"
            >
              {/* Avatar */}
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-emerald-500 mb-6 flex items-center justify-center">
                <span className="text-2xl font-bold text-white">
                  {creator.name.charAt(0)}
                </span>
              </div>

              {/* Name & Bio */}
              <h3 className="text-2xl font-bold text-white mb-2">{creator.name}</h3>
              <p className="text-gray-400 text-sm mb-6 h-10 line-clamp-2">
                {creator.bio}
              </p>

              {/* Category Badge */}
              <div className="inline-block px-3 py-1 rounded-full text-xs font-semibold text-white bg-gradient-to-r from-blue-600 to-emerald-600 mb-6">
                {creator.category}
              </div>

              {/* Stats */}
              <div className="space-y-3 mb-8">
                <div className="flex justify-between items-center">
                  <span className="text-gray-500 text-sm">Hacks submitted</span>
                  <span className="text-white font-bold font-mono">{creator.hacks}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-500 text-sm">Votes received</span>
                  <span className="text-emerald-400 font-bold font-mono">▲ {creator.votes.toLocaleString()}</span>
                </div>
              </div>

              {/* CTA */}
              <Link
                href="/browse"
                className="block w-full text-center px-4 py-2 rounded-lg border border-gray-700 text-white font-semibold hover:bg-gray-800 transition"
              >
                View hacks →
              </Link>
            </div>
          ))}
        </div>

        {/* Join CTA */}
        <div className="mt-24 p-12 rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900 to-black text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Be a top creator.
          </h2>
          <p className="text-gray-400 mb-8 max-w-2xl mx-auto">
            Share your hacks. Build your reputation. Help millions of people live better. The best creators build followings, get featured, and sometimes turn it into something more.
          </p>
          <Link
            href="/submit"
            className="inline-block px-8 py-3 bg-gradient-to-r from-blue-600 to-emerald-600 text-white font-semibold rounded-lg hover:opacity-90 transition"
          >
            Submit your first hack
          </Link>
        </div>
      </div>
    </div>
  );
}
