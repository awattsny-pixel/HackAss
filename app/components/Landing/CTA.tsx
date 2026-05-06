'use client';

import { useState } from 'react';

export default function CTA() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email) {
      setSubmitted(true);
      setEmail('');
      setTimeout(() => setSubmitted(false), 3000);
    }
  };

  return (
    <section className="bg-black py-24">
      <div className="max-w-7xl mx-auto px-4">
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-gray-900 via-blue-900/20 to-black border border-gray-800 p-16 md:p-24">
          {/* Background glows */}
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-96 h-96 bg-blue-500/20 rounded-full blur-3xl"></div>
          </div>

          <div className="relative z-10 max-w-2xl mx-auto text-center">
            <p className="text-gray-500 text-sm font-mono uppercase tracking-widest mb-4">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 mr-2"></span>
              free forever
            </p>

            <h2 className="text-5xl md:text-6xl font-bold mb-6">
              <span className="text-white">Stop googling. </span>
              <br />
              <span className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">Start hacking.</span>
            </h2>

            <p className="text-xl text-gray-400 mb-10">
              Join 42,108 people who shower with cleaner towels, eat off cleaner pans, and pay less for their phone bills.
            </p>

            <div className="flex flex-col md:flex-row gap-4 mb-8 justify-center">
              <button className="px-8 py-3 bg-gradient-to-r from-blue-600 to-emerald-600 text-white font-semibold rounded-lg hover:opacity-90 transition">
                Get the iOS app ↗
              </button>
              <button className="px-8 py-3 border border-gray-600 text-white font-semibold rounded-lg hover:bg-gray-900 transition">
                Get the Android app
              </button>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <form onSubmit={handleSubmit} className="flex-1 flex gap-2">
                <input
                  type="email"
                  placeholder="or just give us your email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="flex-1 px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 font-mono focus:border-emerald-500 focus:outline-none transition"
                />
                <button
                  type="submit"
                  className="px-6 py-3 bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-700 transition whitespace-nowrap"
                >
                  {submitted ? '✓ Sent' : 'Send'}
                </button>
              </form>
            </div>
            {submitted && (
              <p className="text-emerald-400 text-sm mt-3 font-mono">
                Thanks! Check your email for the weekly top 5.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
