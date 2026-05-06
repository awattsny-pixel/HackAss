import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Heart, Share2, Bookmark, MessageSquare, ArrowLeft, ExternalLink, Code2, Zap } from 'lucide-react';

const HackDetail = ({ hackId = 1, onBack = () => {} }) => {
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [expandedDetails, setExpandedDetails] = useState(false);
  const [newComment, setNewComment] = useState('');
  const containerRef = useRef(null);

  // Mock detailed hack data
  const hack = {
    id: 1,
    title: 'Neural Canvas',
    description: 'AI-powered real-time sketch to vector art generator. Transform hand-drawn sketches into publication-ready vector illustrations in seconds.',
    fullDescription: 'Neural Canvas combines cutting-edge computer vision with generative AI to bridge the gap between analog sketching and digital design. Whether you\'re a professional illustrator, graphic designer, or casual artist, Neural Canvas learns your style and transforms rough sketches into polished vector artwork in real-time.',
    image: 'https://images.unsplash.com/photo-1561070791-2526d30994b5?w=1200&h=1600&fit=crop',
    creator: 'Maya Chen',
    creatorBio: 'Full-stack AI engineer, design systems enthusiast, and digital artist from San Francisco.',
    category: 'AI/ML',
    votes: 3427,
    techStack: ['TensorFlow', 'WebGL', 'React', 'Node.js', 'PostgreSQL'],
    requirements: 'Modern browser with WebGL support, 100MB free space',
    links: [
      { text: 'Live Demo', url: '#', icon: '🚀' },
      { text: 'GitHub', url: '#', icon: '💻' },
      { text: 'Documentation', url: '#', icon: '📚' },
      { text: 'Try It Now', url: '#', icon: '✨' }
    ],
    comments: [
      { id: 1, author: 'Alex Rivera', text: 'This is absolutely mind-blowing. The accuracy is insane!', likes: 245, avatar: '🎨' },
      { id: 2, author: 'Jordan Smith', text: 'Finally a tool that actually understands my sketches. Game changer.', likes: 198, avatar: '🎭' },
      { id: 3, author: 'Sam Patel', text: 'The speed is incredible. I was skeptical but this is production-ready.', likes: 342, avatar: '⚡' }
    ]
  };

  return (
    <div ref={containerRef} className="relative w-full min-h-screen overflow-y-auto" style={{ background: '#0a0a0a' }}>
      {/* Header with Back Button */}
      <div className="fixed top-0 left-0 right-0 z-50 px-6 py-4 backdrop-blur-md" style={{
        background: 'rgba(10, 10, 10, 0.7)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
      }}>
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 rounded-full transition-all hover:scale-110 active:scale-95"
          style={{
            background: 'rgba(255, 255, 255, 0.1)',
            border: '1px solid rgba(255, 255, 255, 0.2)'
          }}
        >
          <ArrowLeft size={20} className="text-white" />
          <span className="text-sm font-medium text-white hidden sm:inline">Back</span>
        </button>
      </div>

      {/* Hero Section - Featured Image */}
      <div className="relative w-full h-96 overflow-hidden mt-16">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url('${hack.image}')`,
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(10,10,10,0.5) 50%, rgba(10,10,10,0.95) 100%)'
          }}
        />
      </div>

      {/* Main Content */}
      <div className="relative px-6 pb-32" style={{ marginTop: '-60px', zIndex: 10 }}>
        {/* Title and Category Card */}
        <div
          className="backdrop-blur-md rounded-3xl p-8 mb-6 border border-white/10 shadow-2xl"
          style={{
            background: 'rgba(255, 255, 255, 0.08)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.2)',
            animation: `slideUp 0.8s ease-out`
          }}
        >
          {/* Category Badge */}
          <div className="inline-flex items-center gap-1 mb-4 px-3 py-1.5 rounded-full backdrop-blur-sm" style={{
            background: 'rgba(16, 185, 129, 0.2)',
            border: '1px solid rgba(16, 185, 129, 0.4)'
          }}>
            <Zap size={14} className="text-emerald-400" />
            <span className="text-xs font-medium text-emerald-300 tracking-wide" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {hack.category}
            </span>
          </div>

          {/* Title */}
          <h1
            className="text-5xl font-black mb-4 leading-tight text-white"
            style={{
              fontFamily: 'Unbounded, sans-serif',
              letterSpacing: '-0.02em'
            }}
          >
            {hack.title}
          </h1>

          {/* Short Description */}
          <p
            className="text-base text-gray-300 mb-6 leading-relaxed max-w-2xl"
            style={{
              fontFamily: 'DM Sans, sans-serif',
              opacity: 0.9
            }}
          >
            {hack.description}
          </p>

          {/* Creator Info */}
          <div className="flex items-center gap-4 pt-6 border-t border-white/10">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center flex-shrink-0"
              style={{
                background: 'linear-gradient(135deg, #2563EB 0%, #10B981 100%)',
                fontSize: '24px',
                boxShadow: '0 4px 12px rgba(37, 99, 235, 0.4)'
              }}
            >
              👩‍💻
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-white" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                {hack.creator}
              </p>
              <p className="text-xs text-gray-400 max-w-md" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                {hack.creatorBio}
              </p>
            </div>
            <div className="text-right">
              <p className="text-lg font-bold text-white">{hack.votes}</p>
              <p className="text-xs text-gray-400">upvotes</p>
            </div>
          </div>
        </div>

        {/* Full Description Card */}
        <div
          className="backdrop-blur-md rounded-3xl p-8 mb-6 border border-white/10"
          style={{
            background: 'rgba(255, 255, 255, 0.08)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.2)'
          }}
        >
          <h2 className="text-xl font-bold text-white mb-4" style={{ fontFamily: 'Unbounded, sans-serif' }}>
            About This Hack
          </h2>
          <p className="text-sm text-gray-300 leading-relaxed" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            {hack.fullDescription}
          </p>
        </div>

        {/* Tech Stack & Details Card */}
        <div
          className="backdrop-blur-md rounded-3xl overflow-hidden border border-white/10 mb-6"
          style={{
            background: 'rgba(255, 255, 255, 0.08)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.2)'
          }}
        >
          {/* Expandable Header */}
          <button
            onClick={() => setExpandedDetails(!expandedDetails)}
            className="w-full flex items-center justify-between px-8 py-6 transition-all hover:bg-white/5"
          >
            <div className="flex items-center gap-3">
              <Code2 size={20} className="text-blue-400" />
              <h3 className="text-lg font-bold text-white" style={{ fontFamily: 'Unbounded, sans-serif' }}>
                Technical Details
              </h3>
            </div>
            <ChevronDown
              size={20}
              className="text-gray-400 transition-transform"
              style={{
                transform: expandedDetails ? 'rotate(180deg)' : 'rotate(0)'
              }}
            />
          </button>

          {/* Expandable Content */}
          {expandedDetails && (
            <div
              className="px-8 pb-6 border-t border-white/10 space-y-6"
              style={{
                animation: 'slideDown 0.3s ease-out'
              }}
            >
              {/* Tech Stack */}
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wider">Tech Stack</p>
                <div className="flex flex-wrap gap-2">
                  {hack.techStack.map((tech, idx) => (
                    <span
                      key={idx}
                      className="px-3 py-1.5 text-xs font-medium rounded-full"
                      style={{
                        background: 'rgba(37, 99, 235, 0.2)',
                        border: '1px solid rgba(37, 99, 235, 0.4)',
                        color: '#60a5fa'
                      }}
                    >
                      {tech}
                    </span>
                  ))}
                </div>
              </div>

              {/* Requirements */}
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wider">Requirements</p>
                <p className="text-sm text-gray-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                  {hack.requirements}
                </p>
              </div>

              {/* Links */}
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wider">Links</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {hack.links.map((link, idx) => (
                    <a
                      key={idx}
                      href={link.url}
                      className="flex items-center gap-2 px-4 py-3 rounded-lg transition-all hover:scale-105 active:scale-95"
                      style={{
                        background: 'rgba(255, 255, 255, 0.1)',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        color: '#fff'
                      }}
                    >
                      <span>{link.icon}</span>
                      <span className="text-xs font-medium hidden sm:inline">{link.text}</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Comments Section */}
        <div
          className="backdrop-blur-md rounded-3xl p-8 border border-white/10"
          style={{
            background: 'rgba(255, 255, 255, 0.08)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.2)'
          }}
        >
          <h3 className="text-lg font-bold text-white mb-6" style={{ fontFamily: 'Unbounded, sans-serif' }}>
            Comments ({hack.comments.length})
          </h3>

          {/* Comments List */}
          <div className="space-y-4 mb-6">
            {hack.comments.map((comment) => (
              <div
                key={comment.id}
                className="p-4 rounded-xl transition-all hover:bg-white/5"
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)'
                }}
              >
                <div className="flex items-start gap-3">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-lg"
                    style={{
                      background: 'linear-gradient(135deg, #2563EB 0%, #10B981 100%)'
                    }}
                  >
                    {comment.avatar}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                      {comment.author}
                    </p>
                    <p className="text-xs text-gray-400 mt-1" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                      {comment.text}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <button className="text-xs text-gray-400 hover:text-blue-400 transition-colors">
                        ❤️ {comment.likes}
                      </button>
                      <button className="text-xs text-gray-400 hover:text-blue-400 transition-colors">
                        Reply
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* New Comment Input */}
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Add a comment..."
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              className="flex-1 px-4 py-3 rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-blue-500/50"
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.1)'
              }}
            />
            <button
              className="px-4 py-3 rounded-lg font-medium text-white transition-all hover:scale-105 active:scale-95"
              style={{
                background: 'linear-gradient(135deg, #2563EB 0%, #10B981 100%)'
              }}
            >
              Post
            </button>
          </div>
        </div>
      </div>

      {/* Action Bar - Bottom Fixed */}
      <div
        className="fixed bottom-0 left-0 right-0 px-6 py-6 backdrop-blur-md"
        style={{
          background: 'rgba(10, 10, 10, 0.8)',
          borderTop: '1px solid rgba(255, 255, 255, 0.1)'
        }}
      >
        <div className="flex items-center justify-between max-w-2xl mx-auto gap-3">
          {/* Like Button */}
          <button
            onClick={() => setLiked(!liked)}
            className="group flex items-center gap-2 px-4 py-3 rounded-full transition-all duration-300 hover:scale-110 active:scale-95 flex-1 sm:flex-initial justify-center"
            style={{
              background: liked ? 'rgba(37, 99, 235, 0.2)' : 'rgba(255, 255, 255, 0.1)',
              border: `1px solid ${liked ? 'rgba(37, 99, 235, 0.5)' : 'rgba(255, 255, 255, 0.2)'}`,
              backdropFilter: 'blur(10px)'
            }}
          >
            <Heart
              size={20}
              className={`transition-all ${liked ? 'fill-blue-400 text-blue-400' : 'text-gray-400'}`}
            />
            <span className="text-sm font-medium text-white hidden sm:inline" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {liked ? hack.votes + 1 : hack.votes}
            </span>
          </button>

          {/* Share Button */}
          <button
            className="group flex items-center gap-2 px-4 py-3 rounded-full transition-all duration-300 hover:scale-110 active:scale-95 flex-1 sm:flex-initial justify-center"
            style={{
              background: 'rgba(255, 255, 255, 0.1)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              backdropFilter: 'blur(10px)'
            }}
          >
            <Share2 size={20} className="text-gray-400" />
            <span className="text-sm font-medium text-white hidden sm:inline" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              Share
            </span>
          </button>

          {/* Save Button */}
          <button
            onClick={() => setSaved(!saved)}
            className="group flex items-center gap-2 px-4 py-3 rounded-full transition-all duration-300 hover:scale-110 active:scale-95 flex-1 sm:flex-initial justify-center"
            style={{
              background: saved ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.1)',
              border: `1px solid ${saved ? 'rgba(16, 185, 129, 0.5)' : 'rgba(255, 255, 255, 0.2)'}`,
              backdropFilter: 'blur(10px)'
            }}
          >
            <Bookmark
              size={20}
              className={`transition-all ${saved ? 'fill-emerald-400 text-emerald-400' : 'text-gray-400'}`}
            />
            <span className="text-sm font-medium text-white hidden sm:inline" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              Save
            </span>
          </button>

          {/* Comment Button */}
          <button
            onClick={() => setShowComments(!showComments)}
            className="group flex items-center gap-2 px-4 py-3 rounded-full transition-all duration-300 hover:scale-110 active:scale-95 flex-1 sm:flex-initial justify-center"
            style={{
              background: 'rgba(255, 255, 255, 0.1)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              backdropFilter: 'blur(10px)'
            }}
          >
            <MessageSquare size={20} className="text-gray-400" />
            <span className="text-sm font-medium text-white hidden sm:inline" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {hack.comments.length}
            </span>
          </button>
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Unbounded:wght@400;700;900&family=DM+Sans:wght@400;500;600;700&display=swap');

        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(40px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes slideDown {
          from {
            opacity: 0;
            max-height: 0;
          }
          to {
            opacity: 1;
            max-height: 500px;
          }
        }
      `}</style>
    </div>
  );
};

export default HackDetail;
