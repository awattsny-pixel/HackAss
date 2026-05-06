'use client';

export default function Stats() {
  const stats = [
    { number: '2,847', label: 'hacks indexed' },
    { number: '10', label: 'categories' },
    { number: '1.2M', label: 'votes cast' },
    { number: '42,108', label: 'hackers' },
    { number: '94%', label: 'actually works' },
    { number: '0', label: 'SEO intros' },
  ];

  return (
    <section className="bg-black border-y border-gray-800 py-12">
      <div className="max-w-7xl mx-auto px-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-8">
          {stats.map((stat, i) => (
            <div key={i} className="text-center">
              <div className="text-4xl md:text-3xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent mb-2">
                {stat.number}
              </div>
              <div className="text-gray-500 text-xs md:text-sm font-mono uppercase tracking-wide">
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
