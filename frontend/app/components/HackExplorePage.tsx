'use client';

import React, { useState, useMemo } from 'react';
import { Search, Heart, Share2, Bookmark } from 'lucide-react';

interface Hack {
  id: number;
  title: string;
  description: string;
  creator: string;
  avatar: string;
  votes: number;
  category: string;
  image: string;
}

const HACK_DATA: Hack[] = [
  {
    id: 1,
    title: 'AI-Powered Code Generator',
    description: 'Automatically generates boilerplate code for React components using GPT-4.',
    creator: 'Sarah Chen',
    avatar: '👩‍💻',
    votes: 2847,
    category: 'AI/ML',
    image: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  },
  {
    id: 2,
    title: 'Real-time Data Sync Library',
    description: 'Seamless synchronization using WebSockets and CRDT algorithms.',
    creator: 'Alex Rodriguez',
    avatar: '👨‍💻',
    votes: 1956,
    category: 'Libraries',
    image: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  },
  {
    id: 3,
    title: 'Quantum Computing Simulator',
    description: 'Browser-based quantum circuit simulator with visual debugging.',
    creator: 'Prof. Michael Zhang',
    avatar: '👨‍🏫',
    votes: 3421,
    category: 'Science',
    image: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  },
  {
    id: 4,
    title: 'Ethical AI Audit Framework',
    description: 'Comprehensive framework for evaluating bias in ML models.',
    creator: 'Dr. Priya Patel',
    avatar: '👩‍🔬',
    votes: 2134,
    category: 'AI Ethics',
    image: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  },
  {
    id: 5,
    title: 'Zero-Knowledge Proof Protocol',
    description: 'Novel ZK proof for privacy-preserving authentication systems.',
    creator: 'Cryptography Labs',
    avatar: '🔐',
    votes: 1847,
    category: 'Cryptography',
    image: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  },
  {
    id: 6,
    title: 'Neural Network Visualization',
    description: 'Interactive 3D visualization of neural network architectures.',
    creator: 'Elena Vasquez',
    avatar: '👩‍🔬',
    votes: 2201,
    category: 'Data Science',
    image: 'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
  },
  {
    id: 7,
    title: 'Decentralized Storage SDK',
    description: 'Build Web3 apps with distributed file storage capabilities.',
    creator: 'BlockDev Team',
    avatar: '⛓️',
    votes: 1634,
    category: 'Web3',
    image: 'linear-gradient(135deg, #ff9a56 0%, #ff6a88 100%)',
  },
  {
    id: 8,
    title: 'Low-Code Process Automation',
    description: 'Visual workflow builder for enterprise automation processes.',
    creator: 'Enterprise Solutions',
    avatar: '🏢',
    votes: 2956,
    category: 'Automation',
    image: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  },
];

const CATEGORIES = [
  'All',
  'AI/ML',
  'Web3',
  'Libraries',
  'Science',
  'Data Science',
  'Cryptography',
  'Automation',
  'AI Ethics',
];

export default function HackExplorePage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [likedHacks, setLikedHacks] = useState<Set<number>>(new Set());
  const [savedHacks, setSavedHacks] = useState<Set<number>>(new Set());

  const filteredHacks = useMemo(() => {
    return HACK_DATA.filter((hack) => {
      const matchesCategory = selectedCategory === 'All' || hack.category === selectedCategory;
      const matchesSearch =
        hack.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        hack.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        hack.creator.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [searchQuery, selectedCategory]);

  const toggleLike = (id: number) => {
    const newLiked = new Set(likedHacks);
    if (newLiked.has(id)) {
      newLiked.delete(id);
    } else {
      newLiked.add(id);
    }
    setLikedHacks(newLiked);
  };

  const toggleSave = (id: number) => {
    const newSaved = new Set(savedHacks);
    if (newSaved.has(id)) {
      newSaved.delete(id);
    } else {
      newSaved.add(id);
    }
    setSavedHacks(newSaved);
  };

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <div className="sticky top-0 z-50 backdrop-blur-2xl bg-black/80 border-b border-white/10">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="mb-8">
            <h1 className="text-4xl font-bold mb-2">Explore Hacks</h1>
            <p className="text-white/60">Discover innovative projects from the community</p>
          </div>

          {/* Search bar */}
          <div className="relative mb-8">
            <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-white/40" size={20} />
            <input
              type="text"
              placeholder="Search hacks, creators, ideas..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-12 pr-6 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/50 focus:outline-none focus:border-blue-500 focus:bg-white/15 transition-all"
            />
          </div>

          {/* Category filters */}
          <div className="flex gap-3 overflow-x-auto pb-2">
            {CATEGORIES.map((category) => (
              <button
                key={category}
                onClick={() => setSelectedCategory(category)}
                className={`px-4 py-2 rounded-lg font-medium whitespace-nowrap transition-all ${
                  selectedCategory === category
                    ? 'bg-blue-600 text-white'
                    : 'bg-white/10 text-white/70 hover:bg-white/20'
                }`}
              >
                {category}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results info */}
      <div className="max-w-7xl mx-auto px-6 py-6 text-white/60 text-sm">
        Found {filteredHacks.length} hack{filteredHacks.length !== 1 ? 's' : ''}
      </div>

      {/* Grid */}
      <div className="max-w-7xl mx-auto px-6 pb-20">
        {filteredHacks.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredHacks.map((hack) => (
              <div
                key={hack.id}
                className="group rounded-xl overflow-hidden backdrop-blur-sm bg-white/5 border border-white/10 hover:border-white/20 transition-all duration-300 hover:shadow-2xl hover:shadow-blue-500/20"
              >
                {/* Image/gradient section */}
                <div
                  className="h-40 relative overflow-hidden"
                  style={{ background: hack.image }}
                >
                  <div className="absolute inset-0 bg-black/40 group-hover:bg-black/20 transition-all duration-300" />
                  <div className="absolute inset-0 flex items-end p-4">
                    <span className="px-3 py-1 text-xs font-semibold text-white bg-blue-500/50 backdrop-blur-sm rounded-full border border-blue-400/30">
                      {hack.category}
                    </span>
                  </div>
                </div>

                {/* Content section */}
                <div className="p-6">
                  {/* Title */}
                  <h3 className="text-lg font-bold mb-2 line-clamp-2 group-hover:text-blue-400 transition-colors">
                    {hack.title}
                  </h3>

                  {/* Description */}
                  <p className="text-white/60 text-sm mb-4 line-clamp-2">
                    {hack.description}
                  </p>

                  {/* Creator info */}
                  <div className="flex items-center gap-3 mb-4 pb-4 border-b border-white/10">
                    <div className="text-xl">{hack.avatar}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">{hack.creator}</p>
                      <p className="text-xs text-white/50">Creator</p>
                    </div>
                  </div>

                  {/* Votes */}
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-sm font-bold text-white">
                      👍 {hack.votes.toLocaleString()}
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => toggleLike(hack.id)}
                      className={`flex-1 p-2 rounded-lg transition-all flex items-center justify-center gap-2 ${
                        likedHacks.has(hack.id)
                          ? 'bg-red-500/30 text-red-200'
                          : 'bg-white/10 text-white/70 hover:bg-white/20'
                      }`}
                    >
                      <Heart size={16} fill={likedHacks.has(hack.id) ? 'currentColor' : 'none'} />
                      <span className="text-xs font-medium">Like</span>
                    </button>
                    <button className="flex-1 p-2 rounded-lg bg-white/10 text-white/70 hover:bg-white/20 transition-all flex items-center justify-center gap-2">
                      <Share2 size={16} />
                      <span className="text-xs font-medium">Share</span>
                    </button>
                    <button
                      onClick={() => toggleSave(hack.id)}
                      className={`flex-1 p-2 rounded-lg transition-all flex items-center justify-center gap-2 ${
                        savedHacks.has(hack.id)
                          ? 'bg-yellow-500/30 text-yellow-200'
                          : 'bg-white/10 text-white/70 hover:bg-white/20'
                      }`}
                    >
                      <Bookmark size={16} fill={savedHacks.has(hack.id) ? 'currentColor' : 'none'} />
                      <span className="text-xs font-medium">Save</span>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="text-5xl mb-4">🔍</div>
            <h3 className="text-2xl font-bold mb-2">No hacks found</h3>
            <p className="text-white/60 mb-6">Try adjusting your search or filters</p>
            <button
              onClick={() => {
                setSearchQuery('');
                setSelectedCategory('All');
              }}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-semibold transition-colors"
            >
              Clear Filters
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
