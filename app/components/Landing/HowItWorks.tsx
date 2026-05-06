'use client';

export default function HowItWorks() {
  const steps = [
    {
      number: '01',
      title: 'Someone tries a hack',
      description: 'A hacker discovers a trick that genuinely works. They write it up — title, steps, why it works. No fluff.',
    },
    {
      number: '02',
      title: 'The community votes',
      description: 'Real people try it. They upvote what works, downvote what doesn\'t, and add comments with their own twists.',
    },
    {
      number: '03',
      title: 'The best ones rise',
      description: 'Top hacks get featured. Bad hacks get buried. The feed updates itself. You scroll. You save. You shower with cleaner towels.',
    },
  ];

  return (
    <section className="bg-black py-24">
      <div className="max-w-7xl mx-auto px-4">
        <div className="mb-16">
          <p className="text-gray-500 text-sm font-mono uppercase tracking-widest mb-4">// HOW</p>
          <h2 className="text-5xl md:text-6xl font-bold">
            <span className="text-white">Curation by </span>
            <span className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">crowd</span>
            <span className="text-white">, not by intern.</span>
          </h2>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {steps.map((step, i) => (
            <div
              key={i}
              className="relative p-8 rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900 to-black hover:border-gray-700 transition"
            >
              <div className="text-5xl font-bold text-gray-800 font-mono mb-6">{step.number}</div>

              <h3 className="text-2xl font-bold text-white mb-4">{step.title}</h3>

              <p className="text-gray-400 leading-relaxed">{step.description}</p>

              {i < steps.length - 1 && (
                <div className="absolute -right-4 top-1/2 transform -translate-y-1/2 w-8 h-8 rounded-full border-2 border-gray-700 bg-black flex items-center justify-center text-gray-600 hidden md:flex">
                  →
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
