'use client';

import React, { useState } from 'react';
import { Heart, Share2, Bookmark, ChevronDown, ChevronUp, MessageCircle } from 'lucide-react';

interface Comment {
  id: number;
  author: string;
  avatar: string;
  text: string;
  timestamp: string;
  likes: number;
}

const HackDetailPage = () => {
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [comments, setComments] = useState<Comment[]>([
    {
      id: 1,
      author: 'Jane Developer',
      avatar: '👩‍💻',
      text: 'This is absolutely brilliant! The implementation details are incredibly thorough. Really excited to try this out in production.',
      timestamp: '2 hours ago',
      likes: 12,
    },
    {
      id: 2,
      author: 'Tech Enthusiast',
      avatar: '👨‍💼',
      text: 'Can this handle large-scale deployments? Would love to know about performance benchmarks.',
      timestamp: '1 hour ago',
      likes: 8,
    },
  ]);

  const toggleSection = (section: string) => {
    setExpandedSection(expandedSection === section ? null : section);
  };

  return (
    <div className="min-h-screen bg-black text-white overflow-y-auto">
      {/* Hero section with gradient */}
      <div
        className="relative h-64 md:h-96 overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        }}
      >
        <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
        <div className="relative z-10 h-full flex flex-col justify-end p-8">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">AI-Powered Code Generator</h1>
          <p className="text-white/80 text-lg mb-6 max-w-2xl">
            Automatically generates boilerplate code for React components using GPT-4 integration.
          </p>
          <div className="flex gap-3">
            <span className="px-4 py-2 bg-blue-500/50 backdrop-blur-sm rounded-full text-sm font-semibold border border-blue-400/30">
              AI/ML
            </span>
            <span className="px-4 py-2 bg-purple-500/50 backdrop-blur-sm rounded-full text-sm font-semibold border border-purple-400/30">
              Developer Tools
            </span>
          </div>
        </div>
      </div>

      {/* Content section */}
      <div className="relative z-10 max-w-4xl mx-auto px-6 py-12">
        {/* Action bar */}
        <div className="flex items-center justify-between mb-12 pb-8 border-b border-white/10">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="text-2xl">👍</span>
              <span className="text-white/70">2,847 votes</span>
            </div>
            <div className="flex items-center gap-2">
              <MessageCircle size={20} />
              <span className="text-white/70">12 comments</span>
            </div>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => setLiked(!liked)}
              className={`p-3 rounded-lg transition-all ${
                liked
                  ? 'bg-red-500/30 text-red-200'
                  : 'bg-white/10 text-white/70 hover:bg-white/20'
              }`}
            >
              <Heart size={20} fill={liked ? 'currentColor' : 'none'} />
            </button>
            <button className="p-3 rounded-lg bg-white/10 text-white/70 hover:bg-white/20 transition-all">
              <Share2 size={20} />
            </button>
            <button
              onClick={() => setSaved(!saved)}
              className={`p-3 rounded-lg transition-all ${
                saved
                  ? 'bg-yellow-500/30 text-yellow-200'
                  : 'bg-white/10 text-white/70 hover:bg-white/20'
              }`}
            >
              <Bookmark size={20} fill={saved ? 'currentColor' : 'none'} />
            </button>
          </div>
        </div>

        {/* Creator info */}
        <div className="mb-12 p-6 rounded-xl bg-white/5 backdrop-blur-sm border border-white/10">
          <div className="flex items-start gap-4 mb-6">
            <div className="text-4xl">👩‍💻</div>
            <div className="flex-1">
              <h3 className="text-xl font-bold mb-1">Sarah Chen</h3>
              <p className="text-white/60 text-sm mb-3">Verified Creator • 15 Hacks Posted</p>
              <p className="text-white/70 text-sm leading-relaxed">
                Sarah is a full-stack developer with 10+ years of experience in AI/ML and web technologies.
                She's passionate about building developer tools that reduce boilerplate and improve productivity.
              </p>
            </div>
          </div>
          <button className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-semibold transition-colors">
            Follow Creator
          </button>
        </div>

        {/* Expandable sections */}
        <div className="space-y-4 mb-12">
          {/* Overview section */}
          <div className="rounded-xl bg-white/5 backdrop-blur-sm border border-white/10 overflow-hidden">
            <button
              onClick={() => toggleSection('overview')}
              className="w-full p-6 flex items-center justify-between hover:bg-white/10 transition-colors"
            >
              <h3 className="text-lg font-bold">Overview & Features</h3>
              {expandedSection === 'overview' ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
            </button>
            {expandedSection === 'overview' && (
              <div className="px-6 pb-6 border-t border-white/10 space-y-4 text-white/70">
                <p>
                  This innovative code generation tool leverages the power of GPT-4 to create high-quality,
                  production-ready React components. Simply describe what you need, and the AI generates:
                </p>
                <ul className="list-disc list-inside space-y-2 ml-4">
                  <li>Complete component structure with TypeScript support</li>
                  <li>Properly styled components with Tailwind CSS</li>
                  <li>Built-in error handling and prop validation</li>
                  <li>Accessibility features following WCAG guidelines</li>
                  <li>Jest test cases for comprehensive coverage</li>
                </ul>
              </div>
            )}
          </div>

          {/* Technical details section */}
          <div className="rounded-xl bg-white/5 backdrop-blur-sm border border-white/10 overflow-hidden">
            <button
              onClick={() => toggleSection('technical')}
              className="w-full p-6 flex items-center justify-between hover:bg-white/10 transition-colors"
            >
              <h3 className="text-lg font-bold">Technical Details</h3>
              {expandedSection === 'technical' ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
            </button>
            {expandedSection === 'technical' && (
              <div className="px-6 pb-6 border-t border-white/10 space-y-4 text-white/70">
                <div>
                  <h4 className="font-semibold text-white mb-2">Stack</h4>
                  <p>React 18.x, TypeScript, Next.js 14+, Tailwind CSS, OpenAI API</p>
                </div>
                <div>
                  <h4 className="font-semibold text-white mb-2">Performance</h4>
                  <p>Average generation time: 2-5 seconds per component. Supports batching for multiple components.</p>
                </div>
                <div>
                  <h4 className="font-semibold text-white mb-2">Dependencies</h4>
                  <code className="bg-black/40 p-3 rounded block text-xs font-mono overflow-x-auto">
                    npm install openai react typescript tailwindcss
                  </code>
                </div>
              </div>
            )}
          </div>

          {/* Installation section */}
          <div className="rounded-xl bg-white/5 backdrop-blur-sm border border-white/10 overflow-hidden">
            <button
              onClick={() => toggleSection('installation')}
              className="w-full p-6 flex items-center justify-between hover:bg-white/10 transition-colors"
            >
              <h3 className="text-lg font-bold">Getting Started</h3>
              {expandedSection === 'installation' ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
            </button>
            {expandedSection === 'installation' && (
              <div className="px-6 pb-6 border-t border-white/10 space-y-4 text-white/70">
                <code className="bg-black/40 p-4 rounded block text-sm font-mono overflow-x-auto">
                  npm install code-generator
                </code>
                <p>Check the documentation for API keys and configuration options.</p>
                <button className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-semibold transition-colors">
                  View Full Documentation
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Comments section */}
        <div className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Comments ({comments.length})</h2>
          <div className="space-y-4">
            {comments.map((comment) => (
              <div key={comment.id} className="p-6 rounded-xl bg-white/5 backdrop-blur-sm border border-white/10">
                <div className="flex items-start gap-4 mb-3">
                  <div className="text-3xl">{comment.avatar}</div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <h4 className="font-semibold">{comment.author}</h4>
                      <span className="text-sm text-white/50">{comment.timestamp}</span>
                    </div>
                    <p className="text-white/70 leading-relaxed">{comment.text}</p>
                  </div>
                </div>
                <div className="flex items-center gap-6 ml-16">
                  <button className="flex items-center gap-1 text-white/50 hover:text-white/70 transition-colors">
                    <Heart size={16} />
                    <span className="text-sm">{comment.likes}</span>
                  </button>
                  <button className="text-sm text-white/50 hover:text-white/70 transition-colors">Reply</button>
                </div>
              </div>
            ))}
          </div>

          {/* Add comment */}
          <div className="mt-6 p-6 rounded-xl bg-white/5 backdrop-blur-sm border border-white/10">
            <textarea
              placeholder="Add a comment..."
              className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-3 text-white placeholder-white/50 focus:outline-none focus:border-blue-500 resize-none"
              rows={3}
            />
            <div className="mt-3 flex justify-end">
              <button className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-semibold transition-colors">
                Post Comment
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HackDetailPage;
