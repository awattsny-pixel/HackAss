'use client';

import React, { useState, useEffect } from 'react';
import { Heart, Share2, Bookmark, ChevronDown } from 'lucide-react';

interface Hack {
  id: number;
  title: string;
  description: string;
  creator: string;
  avatar: string;
  votes: number;
  category: string;
  image: string;
  liked: boolean;
  saved: boolean;
}

const SAMPLE_HACKS: Hack[] = [
  {
    id: 1,
    title: 'AI-Powered Code Generator',
    description: 'Automatically generates boilerplate code for React components using GPT-4 integration.',
    creator: 'Sarah Chen',
    avatar: '👩‍💻',
    votes: 2847,
    category: 'AI/ML',
    image: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    liked: false,
    saved: false,
  },
  {
    id: 2,
    title: 'Real-time Data Sync Library',
    description: 'Seamless synchronization library for collaborative apps using WebSockets and CRDT algorithms.',
    creator: 'Alex Rodriguez',
    avatar: '👨‍💻',
    votes: 1956,
    category: 'Libraries',
    image: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
    liked: false,
    saved: false,
  },
  {
    id: 3,
    title: 'Quantum Computing Simulator',
    description: 'Browser-based quantum circuit simulator with visual debugging and educational tutorials.',
    creator: 'Prof. Michael Zhang',
    avatar: '👨‍🏫',
    votes: 3421,
    category: 'Science',
    image: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
    liked: false,
    saved: false,
  },
  {
    id: 4,
    title: 'Ethical AI Audit Framework',
    description: 'Comprehensive framework for evaluating bias and fairness in machine learning models.',
    creator: 'Dr. Priya Patel',
    avatar: '👩‍🔬',
    votes: 2134,
    category: 'AI Ethics',
    image: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
    liked: false,
    saved: false,
  },
  {
    id: 5,
    title: 'Zero-Knowledge Proof Protocol',
    description: 'Novel ZK proof implementation for privacy-preserving authentication systems.',
    creator: 'Cryptography Labs',
    avatar: '🔐',
    votes: 1847,
    category: 'Cryptography',
    image: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
    liked: false,
    saved: false,
  },
];

export default function HackFeedPage() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [hacks, setHacks] = useState<Hack[]>(SAMPLE_HACKS);
  const [isAutoScrolling, setIsAutoScrolling] = useState(false);

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (isAutoScrolling) return;

      if (e.deltaY > 0) {
        scrollNext();
      } else {
        scrollPrev();
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [currentIndex, isAutoScrolling]);

  const scrollNext = () => {
    if (currentIndex < hacks.length - 1) {
      setIsAutoScrolling(true);
      setCurrentIndex(currentIndex + 1);
      setTimeout(() => setIsAutoScrolling(false), 800);
    }
  };

  const scrollPrev = () => {
    if (currentIndex > 0) {
      setIsAutoScrolling(true);
      setCurrentIndex(currentIndex - 1);
      setTimeout(() => setIsAutoScrolling(false), 800);
    }
  };

  const toggleLike = (id: number) => {
    setHacks(hacks.map(h =>
      h.id === id ? { ...h, liked: !h.liked, votes: h.liked ? h.votes - 1 : h.votes + 1 } : h
    ));
  };

  const toggleSave = (id: number) => {
    setHacks(hacks.map(h => h.id === id ? { ...h, saved: !h.saved } : h));
  };

  const currentHack = hacks[currentIndex];

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden">
      {/* Animated background gradient */}
      <div
        className="absolute inset-0 opacity-30"
        style={{
          background: `${currentHack.image}`,
          transition: 'background 0.8s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      />

      {/* Dark overlay */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-3xl" />

      {/* Content container */}
      <div className="relative z-10 h-full flex flex-col">
        {/* Header */}
        <div className="px-6 pt-6 flex items-center justify-between">
          <div className="text-2xl font-bold text-white">HackAgg</div>
          <div className="flex gap-2">
            <button className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-medium backdrop-blur-sm transition-colors">
              Explore
            </button>
            <button className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-medium backdrop-blur-sm transition-colors">
              Profile
            </button>
          </div>
        </div>

        {/* Main card stack */}
        <div className="flex-1 flex items-center justify-center px-6 py-12">
          <div className="relative w-full max-w-md h-full max-h-96">
            {/* Card layers */}
            {hacks.map((hack, idx) => {
              const distance = idx - currentIndex;
              const isVisible = distance >= 0 && distance < 3;
              const opacity = distance === 0 ? 1 : distance === 1 ? 0.5 : 0.25;
              const scale = distance === 0 ? 1 : 0.95 - distance * 0.02;
              const translateY = distance === 0 ? 0 : distance * 12;

              if (!isVisible) return null;

              return (
                <div
                  key={hack.id}
                  className="absolute inset-0 rounded-2xl bg-white/10 backdrop-blur-2xl border border-white/20 overflow-hidden transition-all duration-700 ease-out"
                  style={{
                    opacity,
                    transform: `scale(${scale}) translateY(${translateY}px)`,
                  }}
                >
                  {/* Card content */}
                  <div className="h-full flex flex-col p-6">
                    {/* Category badge */}
                    <div className="flex gap-2 mb-4">
                      <span className="px-3 py-1 text-xs font-semibold text-white bg-blue-500/50 backdrop-blur-sm rounded-full border border-blue-400/30">
                        {hack.category}
                      </span>
                    </div>

                    {/* Title and description */}
                    <div className="flex-1 mb-6">
                      <h2 className="text-xl font-bold text-white mb-3 line-clamp-2">
                        {hack.title}
                      </h2>
                      <p className="text-white/70 text-sm leading-relaxed line-clamp-4">
                        {hack.description}
                      </p>
                    </div>

                    {/* Creator info */}
                    <div className="flex items-center gap-3 mb-6 pb-6 border-b border-white/10">
                      <div className="text-2xl">{hack.avatar}</div>
                      <div>
                        <p className="text-sm font-medium text-white">{hack.creator}</p>
                        <p className="text-xs text-white/50">Hack Creator</p>
                      </div>
                    </div>

                    {/* Votes and actions */}
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-bold text-white">
                        👍 {hack.votes.toLocaleString()} votes
                      </div>
                      <div className="flex gap-3">
                        <button
                          onClick={() => toggleLike(hack.id)}
                          className={`p-2 rounded-lg transition-all ${
                            hack.liked
                              ? 'bg-red-500/30 text-red-200'
                              : 'bg-white/10 text-white/70 hover:bg-white/20'
                          }`}
                        >
                          <Heart size={18} fill={hack.liked ? 'currentColor' : 'none'} />
                        </button>
                        <button className="p-2 rounded-lg bg-white/10 text-white/70 hover:bg-white/20 transition-all">
                          <Share2 size={18} />
                        </button>
                        <button
                          onClick={() => toggleSave(hack.id)}
                          className={`p-2 rounded-lg transition-all ${
                            hack.saved
                              ? 'bg-yellow-500/30 text-yellow-200'
                              : 'bg-white/10 text-white/70 hover:bg-white/20'
                          }`}
                        >
                          <Bookmark size={18} fill={hack.saved ? 'currentColor' : 'none'} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer info */}
        <div className="px-6 pb-6 flex items-center justify-between">
          <div className="text-white/50 text-sm">
            {currentIndex + 1} of {hacks.length}
          </div>
          <div className="text-white/50 text-xs flex items-center gap-1">
            <ChevronDown size={16} className="animate-bounce" />
            Scroll to explore
          </div>
        </div>
      </div>
    </div>
  );
}
