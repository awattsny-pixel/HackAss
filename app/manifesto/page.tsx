import Link from 'next/link';

export const metadata = {
  title: 'Our Manifesto - HackAss',
  description: 'Why we built HackAss and what we believe in.',
};

export default function ManifestoPage() {
  return (
    <div className="bg-black min-h-screen">
      {/* Header with gradient */}
      <div className="bg-gradient-to-b from-gray-900 via-blue-900/10 to-black border-b border-gray-800">
        <div className="max-w-4xl mx-auto px-4 py-20 text-center">
          <p className="text-gray-500 text-sm font-mono uppercase tracking-widest mb-4">
            OUR VALUES
          </p>
          <h1 className="text-6xl md:text-7xl font-bold mb-6">
            <span className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
              Why we built this.
            </span>
          </h1>
          <p className="text-xl text-gray-400 max-w-2xl mx-auto">
            A manifesto for people tired of scrolling through 1,200-word essays to find a three-step hack.
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-4 py-24">
        <div className="prose prose-invert max-w-none space-y-12">
          {/* Section 1 */}
          <section>
            <h2 className="text-4xl font-bold text-white mb-6">The Problem</h2>
            <p className="text-lg text-gray-300 leading-relaxed mb-4">
              In 2024, the internet's best life hacks are buried in a thousand places:
            </p>
            <ul className="space-y-3 text-lg text-gray-300">
              <li className="flex items-start gap-4">
                <span className="text-emerald-400 font-bold flex-shrink-0">✓</span>
                <span>Editorial sites that turn a 3-step hack into a 1,200-word SEO essay with 8 ads above the fold.</span>
              </li>
              <li className="flex items-start gap-4">
                <span className="text-emerald-400 font-bold flex-shrink-0">✓</span>
                <span>Reddit threads where the best answer gets buried under 40 jokes.</span>
              </li>
              <li className="flex items-start gap-4">
                <span className="text-emerald-400 font-bold flex-shrink-0">✓</span>
                <span>TikTok videos where you have to watch 30 seconds of setup to get 3 seconds of actual info.</span>
              </li>
              <li className="flex items-start gap-4">
                <span className="text-emerald-400 font-bold flex-shrink-0">✓</span>
                <span>Your mom's group chat, which is actually sometimes the best source.</span>
              </li>
            </ul>
          </section>

          {/* Section 2 */}
          <section>
            <h2 className="text-4xl font-bold text-white mb-6">What We Believe</h2>
            <div className="space-y-6">
              <div className="p-8 border border-gray-800 rounded-lg bg-gradient-to-br from-gray-900 to-black">
                <h3 className="text-2xl font-bold text-white mb-3">Hacks should be short.</h3>
                <p className="text-gray-300">
                  If it takes more than 30 seconds to explain a hack, it's not a hack. It's an essay. We want: title, problem, 3–5 steps, why it works. Nothing else.
                </p>
              </div>

              <div className="p-8 border border-gray-800 rounded-lg bg-gradient-to-br from-gray-900 to-black">
                <h3 className="text-2xl font-bold text-white mb-3">Curation by crowd, not by editor.</h3>
                <p className="text-gray-300">
                  Editorial judgment is one person's opinion. We trust people who actually tried it. If 10,000 people upvoted a hack because it worked, that means something. If an editor's assistant wrote it because it would rank on Google, it means less.
                </p>
              </div>

              <div className="p-8 border border-gray-800 rounded-lg bg-gradient-to-br from-gray-900 to-black">
                <h3 className="text-2xl font-bold text-white mb-3">Real people, real feedback.</h3>
                <p className="text-gray-300">
                  When someone submits a hack, the community tries it. They vote on whether it actually works. They add their own variations. That's how the best hacks rise. It's not perfect, but it's more honest than most.
                </p>
              </div>

              <div className="p-8 border border-gray-800 rounded-lg bg-gradient-to-br from-gray-900 to-black">
                <h3 className="text-2xl font-bold text-white mb-3">Mobile first. No ads.</h3>
                <p className="text-gray-300">
                  You should be able to scroll through hacks on your phone. Snappy. Fast. Without waiting for 12 ads to load. We're building for the experience, not the ad revenue.
                </p>
              </div>

              <div className="p-8 border border-gray-800 rounded-lg bg-gradient-to-br from-gray-900 to-black">
                <h3 className="text-2xl font-bold text-white mb-3">Categories that matter.</h3>
                <p className="text-gray-300">
                  We didn't invent 47 niche categories. We started with what people actually search for: Cooking. Cleaning. Money. Travel. Productivity. Home. Tech. Beauty. Fitness. And a few others. That's it.
                </p>
              </div>
            </div>
          </section>

          {/* Section 3 */}
          <section>
            <h2 className="text-4xl font-bold text-white mb-6">Our Promise</h2>
            <p className="text-lg text-gray-300 leading-relaxed mb-6">
              We built HackAss because we got tired of the internet making simple things complicated.
            </p>
            <p className="text-lg text-gray-300 leading-relaxed mb-6">
              We promise to:
            </p>
            <ul className="space-y-3 text-lg text-gray-300">
              <li className="flex items-start gap-4">
                <span className="text-blue-400 font-bold flex-shrink-0">→</span>
                <span>Keep hacks short. Always.</span>
              </li>
              <li className="flex items-start gap-4">
                <span className="text-blue-400 font-bold flex-shrink-0">→</span>
                <span>Let the community decide what works, not algorithms.</span>
              </li>
              <li className="flex items-start gap-4">
                <span className="text-blue-400 font-bold flex-shrink-0">→</span>
                <span>Never add ads. We'll figure out money differently.</span>
              </li>
              <li className="flex items-start gap-4">
                <span className="text-blue-400 font-bold flex-shrink-0">→</span>
                <span>Keep the mobile experience frictionless.</span>
              </li>
              <li className="flex items-start gap-4">
                <span className="text-blue-400 font-bold flex-shrink-0">→</span>
                <span>Be transparent about how hacks are ranked.</span>
              </li>
              <li className="flex items-start gap-4">
                <span className="text-blue-400 font-bold flex-shrink-0">→</span>
                <span>Respect your time. No filler. No growth-hacking. No bullshit.</span>
              </li>
            </ul>
          </section>

          {/* CTA */}
          <section className="pt-12 border-t border-gray-800">
            <div className="text-center py-12">
              <h3 className="text-3xl font-bold text-white mb-6">
                Help us build this.
              </h3>
              <p className="text-lg text-gray-400 mb-8 max-w-2xl mx-auto">
                We're just getting started. Have a hack that changed your life? Submit it. Try someone else's hack. Vote on what works. That's how we build the internet's best shortcut.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link
                  href="/browse"
                  className="px-8 py-3 bg-gradient-to-r from-blue-600 to-emerald-600 text-white font-semibold rounded-lg hover:opacity-90 transition"
                >
                  Browse hacks
                </Link>
                <Link
                  href="/submit"
                  className="px-8 py-3 border border-gray-600 text-white font-semibold rounded-lg hover:bg-gray-900 transition"
                >
                  Submit yours
                </Link>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
