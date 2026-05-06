import React, { useState, useRef, useEffect } from 'react';
import { ChevronUp, Heart, Share2, Bookmark, User, Zap } from 'lucide-react';

// Distinctive fonts - using Google Fonts imports at top of actual HTML file
// Display: "Clash Grotesk" or "Unbounded"
// Body: "DM Sans"

const HackCard = ({ hack, index, isActive }) => {
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);

  return (
    <div
      className={`
        relative w-full h-screen flex flex-col justify-end overflow-hidden
        transition-all duration-700 ease-out
        ${isActive ? 'opacity-100 scale-100' : 'opacity-0 scale-95 pointer-events-none'}
      `}
      style={{
        background: `linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #0f0f1e 100%)`,
        animation: isActive ? `fadeInUp 0.8s ease-out` : 'none'
      }}
    >
      {/* Background Image/Gradient */}
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage: `url('${hack.image}')`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            filter: 'blur(0px)',
            animation: isActive ? `zoomIn 8s ease-out` : 'none'
          }}
        />
        {/* Gradient Overlay - Dark at bottom for text readability */}
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(10,10,10,0.4) 40%, rgba(10,10,10,0.95) 100%)`
          }}
        />
      </div>

      {/* Content Container - Glassmorphic */}
      <div className="relative z-10 px-6 pb-32 pt-12">
        {/* Glassmorphic Card */}
        <div
          className="backdrop-blur-md rounded-3xl p-6 border border-white/10 shadow-2xl"
          style={{
            background: 'rgba(255, 255, 255, 0.08)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.2)',
            animation: isActive ? `slideUp 0.8s ease-out 0.2s both` : 'none',
            willChange: 'transform'
          }}
        >
          {/* Category Badge - Accent Green */}
          <div className="inline-flex items-center gap-1 mb-4 px-3 py-1.5 rounded-full backdrop-blur-sm" style={{
            background: 'rgba(16, 185, 129, 0.2)',
            border: '1px solid rgba(16, 185, 129, 0.4)'
          }}>
            <Zap size={14} className="text-emerald-400" />
            <span className="text-xs font-medium text-emerald-300 tracking-wide" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {hack.category}
            </span>
          </div>

          {/* Hack Title - Distinctive Display Font */}
          <h1
            className="text-4xl font-black mb-3 leading-tight text-white"
            style={{
              fontFamily: 'Unbounded, Clash Grotesk, sans-serif',
              letterSpacing: '-0.02em',
              animation: isActive ? `fadeInUp 0.8s ease-out 0.3s both` : 'none'
            }}
          >
            {hack.title}
          </h1>

          {/* Description */}
          <p
            className="text-sm text-gray-300 mb-4 leading-relaxed max-w-md"
            style={{
              fontFamily: 'DM Sans, sans-serif',
              animation: isActive ? `fadeInUp 0.8s ease-out 0.4s both` : 'none',
              opacity: 0.9
            }}
          >
            {hack.description}
          </p>

          {/* Creator Info - Horizontal Layout */}
          <div
            className="flex items-center gap-3 pt-4 border-t border-white/10"
            style={{
              animation: isActive ? `fadeInUp 0.8s ease-out 0.5s both` : 'none'
            }}
          >
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{
                background: 'linear-gradient(135deg, #2563EB 0%, #10B981 100%)',
                boxShadow: '0 4px 12px rgba(37, 99, 235, 0.4)'
              }}
            >
              <User size={20} className="text-white" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-white" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                {hack.creator}
              </p>
              <p className="text-xs text-gray-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                {hack.votes} upvotes
              </p>
            </div>
          </div>
        </div>

        {/* Action Bar - Bottom Fixed */}
        <div
          className="fixed bottom-0 left-0 right-0 px-6 py-6 backdrop-blur-md"
          style={{
            background: 'rgba(10, 10, 10, 0.6)',
            borderTop: '1px solid rgba(255, 255, 255, 0.1)',
            animation: isActive ? `slideUp 0.8s ease-out 0.4s both` : 'none'
          }}
        >
          <div className="flex items-center justify-between max-w-md mx-auto">
            {/* Upvote Button */}
            <button
              onClick={() => setLiked(!liked)}
              className="group flex items-center gap-2 px-4 py-3 rounded-full transition-all duration-300 hover:scale-110 active:scale-95"
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
              className="group flex items-center gap-2 px-4 py-3 rounded-full transition-all duration-300 hover:scale-110 active:scale-95"
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
              className="group flex items-center gap-2 px-4 py-3 rounded-full transition-all duration-300 hover:scale-110 active:scale-95"
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
          </div>
        </div>
      </div>

      {/* Scroll Indicator - Only on first card */}
      {index === 0 && isActive && (
        <div
          className="absolute top-8 right-6 flex flex-col items-center gap-1 animate-pulse"
          style={{
            animation: `bounce 2s ease-in-out infinite`
          }}
        >
          <span className="text-xs font-medium text-gray-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            Scroll
          </span>
          <ChevronUp size={18} className="text-gray-400" />
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Unbounded:wght@400;700;900&family=DM+Sans:wght@400;500;600;700&display=swap');

        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

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

        @keyframes zoomIn {
          from {
            transform: scale(1.1);
            filter: blur(0px);
          }
          to {
            transform: scale(1);
            filter: blur(0px);
          }
        }

        @keyframes bounce {
          0%, 100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-8px);
          }
        }
      `}</style>
    </div>
  );
};

// Mock Hack Data - Realistic examples
const MOCK_HACKS = [
  {
    id: 1,
    title: 'Neural Canvas',
    description: 'AI-powered real-time sketch to vector art generator. Transform hand-drawn sketches into publication-ready vector illustrations in seconds.',
    image: 'https://images.unsplash.com/photo-1561070791-2526d30994b5?w=1200&h=1600&fit=crop',
    creator: 'Maya Chen',
    category: 'AI/ML',
    votes: 3427
  },
  {
    id: 2,
    title: 'Flow State',
    description: 'Ambient soundscape generator that adapts to your work rhythm. Uses biometric data to create personalized productivity music.',
    image: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=1200&h=1600&fit=crop',
    creator: 'Alex Rivera',
    category: 'Audio',
    votes: 2891
  },
  {
    id: 3,
    title: 'Gesture Control 3D',
    description: 'Hand-tracking 3D model viewer. Control 3D models in AR using hand gestures. Perfect for design, architecture, and product visualization.',
    image: 'https://images.unsplash.com/photo-1633356122544-f134324ef6db?w=1200&h=1600&fit=crop',
    creator: 'Jordan Smith',
    category: 'AR/VR',
    votes: 4102
  },
  {
    id: 4,
    title: 'Code Mentor Pro',
    description: 'Real-time code review bot that learns your style. Provides intelligent suggestions while maintaining your unique coding voice.',
    image: 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=1200&h=1600&fit=crop',
    creator: 'Sam Patel',
    category: 'Dev Tools',
    votes: 5230
  },
  {
    id: 5,
    title: 'Chromatic UI',
    description: 'Design system generator that creates accessible, brand-cohesive component libraries from a single color palette.',
    image: 'https://images.unsplash.com/photo-1561070791-2526d30994b5?w=1200&h=1600&fit=crop',
    creator: 'Casey Morgan',
    category: 'Design',
    votes: 2156
  }
];

export default function HackAggregatorFeed() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const containerRef = useRef(null);
  const touchStartY = useRef(0);

  // Scroll wheel handling
  useEffect(() => {
    const handleWheel = (e) => {
      e.preventDefault();

      if (e.deltaY > 0) {
        // Scroll down
        setCurrentIndex((prev) => Math.min(prev + 1, MOCK_HACKS.length - 1));
      } else {
        // Scroll up
        setCurrentIndex((prev) => Math.max(prev - 1, 0));
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener('wheel', handleWheel, { passive: false });
    }

    return () => {
      if (container) {
        container.removeEventListener('wheel', handleWheel);
      }
    };
  }, []);

  // Touch handling for mobile swipe
  const handleTouchStart = (e) => {
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e) => {
    const touchEndY = e.changedTouches[0].clientY;
    const diff = touchStartY.current - touchEndY;

    if (Math.abs(diff) > 50) {
      if (diff > 0) {
        // Swiped up
        setCurrentIndex((prev) => Math.min(prev + 1, MOCK_HACKS.length - 1));
      } else {
        // Swiped down
        setCurrentIndex((prev) => Math.max(prev - 1, 0));
      }
    }
  };

  return (
    <div
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      className="relative w-full overflow-hidden"
      style={{ height: '100vh' }}
    >
      {/* Card Stack */}
      {MOCK_HACKS.map((hack, index) => (
        <HackCard
          key={hack.id}
          hack={hack}
          index={index}
          isActive={index === currentIndex}
        />
      ))}

      {/* Card Counter - Top Right */}
      <div className="fixed top-6 right-6 z-50 px-4 py-2 rounded-full backdrop-blur-md" style={{
        background: 'rgba(255, 255, 255, 0.1)',
        border: '1px solid rgba(255, 255, 255, 0.2)'
      }}>
        <p className="text-sm font-medium text-gray-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>
          {currentIndex + 1} / {MOCK_HACKS.length}
        </p>
      </div>

      {/* Brand Logo - Top Left */}
      <div className="fixed top-6 left-6 z-50">
        <div className="text-2xl font-black" style={{
          fontFamily: 'Unbounded, sans-serif',
          background: 'linear-gradient(135deg, #2563EB 0%, #10B981 100%)',
          backgroundClip: 'text',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          letterSpacing: '-0.02em'
        }}>
          HACK
        </div>
      </div>
    </div>
  );
}
