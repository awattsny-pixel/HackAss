'use client';

import React, { useState } from 'react';
import { useAuth } from '@/app/lib/auth-context';
import { ProtectedRoute } from '@/app/lib/protected-route';
import { Upload, X, Plus, Trash2 } from 'lucide-react';

interface HackFormData {
  title: string;
  description: string;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard';
  steps: string[];
  whyItWorks: string;
  image?: string;
}

const CATEGORIES = [
  'Cleaning',
  'Cooking',
  'Money-Saving',
  'Travel',
  'Health',
  'Productivity',
  'Home',
  'Tech',
  'Organization',
];

const DIFFICULTY_LEVELS = [
  { value: 'easy', label: 'Easy', description: '< 5 minutes' },
  { value: 'medium', label: 'Medium', description: '5-30 minutes' },
  { value: 'hard', label: 'Hard', description: '> 30 minutes' },
];

function SubmitHackFormContent() {
  const { user } = useAuth();
  const [formData, setFormData] = useState<HackFormData>({
    title: '',
    description: '',
    category: 'Cleaning',
    difficulty: 'easy',
    steps: [''],
    whyItWorks: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, title: e.target.value });
  };

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setFormData({ ...formData, description: e.target.value });
  };

  const handleCategoryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setFormData({ ...formData, category: e.target.value });
  };

  const handleDifficultyChange = (difficulty: 'easy' | 'medium' | 'hard') => {
    setFormData({ ...formData, difficulty });
  };

  const handleStepChange = (index: number, value: string) => {
    const newSteps = [...formData.steps];
    newSteps[index] = value;
    setFormData({ ...formData, steps: newSteps });
  };

  const handleAddStep = () => {
    setFormData({ ...formData, steps: [...formData.steps, ''] });
  };

  const handleRemoveStep = (index: number) => {
    setFormData({
      ...formData,
      steps: formData.steps.filter((_, i) => i !== index),
    });
  };

  const handleWhyItWorksChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setFormData({ ...formData, whyItWorks: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Validation
    if (!formData.title.trim()) {
      setError('Title is required');
      return;
    }
    if (!formData.description.trim()) {
      setError('Description is required');
      return;
    }
    if (formData.steps.some((s) => !s.trim())) {
      setError('All steps must be filled in');
      return;
    }
    if (!formData.whyItWorks.trim()) {
      setError('Explanation is required');
      return;
    }

    setLoading(true);

    try {
      // TODO: Replace with actual API call
      const response = await fetch('/api/hacks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          userId: user?.id,
          status: 'pending', // Moderation queue
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to submit hack');
      }

      setSuccess(true);
      // Reset form
      setFormData({
        title: '',
        description: '',
        category: 'Cleaning',
        difficulty: 'easy',
        steps: [''],
        whyItWorks: '',
      });

      // Hide success message after 3 seconds
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen" style={{ background: '#0a0a0a', padding: '40px 20px' }}>
      {/* Background glows */}
      <div style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 0
      }}>
        <div style={{
          position: 'absolute',
          top: '0%',
          left: '10%',
          width: '600px',
          height: '600px',
          background: 'radial-gradient(circle, #2563EB 0%, transparent 70%)',
          filter: 'blur(120px)',
          opacity: 0.2
        }} />
        <div style={{
          position: 'absolute',
          bottom: '10%',
          right: '5%',
          width: '700px',
          height: '700px',
          background: 'radial-gradient(circle, #10B981 0%, transparent 70%)',
          filter: 'blur(120px)',
          opacity: 0.1
        }} />
      </div>

      <div className="relative z-10" style={{ maxWidth: '800px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '40px' }}>
          <h1
            style={{
              fontSize: 'clamp(32px, 6vw, 48px)',
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 700,
              color: '#f5f5f7',
              marginBottom: '12px',
              letterSpacing: '-0.025em'
            }}
          >
            Share Your Hack
          </h1>
          <p style={{ color: '#a1a1aa', fontSize: '15px' }}>
            Help others save time and money with your clever tips
          </p>
        </div>

        {/* Form Card */}
        <div
          style={{
            background: 'rgba(255, 255, 255, 0.025)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '20px',
            padding: '40px',
            backdropFilter: 'blur(20px)'
          }}
        >
          {/* Success Message */}
          {success && (
            <div
              style={{
                marginBottom: '24px',
                padding: '12px 16px',
                background: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                borderRadius: '12px'
              }}
            >
              <p style={{ color: '#6ee7b7', fontSize: '14px' }}>
                ✓ Hack submitted! Our team will review it soon.
              </p>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div
              style={{
                marginBottom: '24px',
                padding: '12px 16px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '12px'
              }}
            >
              <p style={{ color: '#fca5a5', fontSize: '14px' }}>{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
            {/* Title */}
            <div>
              <label
                style={{
                  display: 'block',
                  color: '#a1a1aa',
                  fontSize: '13px',
                  marginBottom: '8px',
                  fontWeight: 600
                }}
              >
                Hack Title
              </label>
              <input
                type="text"
                value={formData.title}
                onChange={handleTitleChange}
                placeholder="e.g., Clean oven with baking soda and vinegar"
                maxLength={100}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '12px',
                  color: '#f5f5f7',
                  fontSize: '14px',
                  fontFamily: 'inherit',
                  transition: 'all 0.2s',
                  boxSizing: 'border-box'
                }}
                onFocus={(e) => {
                  (e.target as HTMLInputElement).style.background = 'rgba(255, 255, 255, 0.08)';
                  (e.target as HTMLInputElement).style.borderColor = 'rgba(37, 99, 235, 0.5)';
                }}
                onBlur={(e) => {
                  (e.target as HTMLInputElement).style.background = 'rgba(255, 255, 255, 0.05)';
                  (e.target as HTMLInputElement).style.borderColor = 'rgba(255, 255, 255, 0.08)';
                }}
              />
              <p style={{ fontSize: '12px', color: '#6b6b75', marginTop: '6px' }}>
                {formData.title.length}/100
              </p>
            </div>

            {/* Description */}
            <div>
              <label
                style={{
                  display: 'block',
                  color: '#a1a1aa',
                  fontSize: '13px',
                  marginBottom: '8px',
                  fontWeight: 600
                }}
              >
                Quick Summary
              </label>
              <textarea
                value={formData.description}
                onChange={handleDescriptionChange}
                placeholder="Brief description of what this hack does and why it matters"
                maxLength={300}
                rows={3}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '12px',
                  color: '#f5f5f7',
                  fontSize: '14px',
                  fontFamily: 'inherit',
                  transition: 'all 0.2s',
                  boxSizing: 'border-box',
                  resize: 'none'
                }}
                onFocus={(e) => {
                  (e.target as HTMLTextAreaElement).style.background = 'rgba(255, 255, 255, 0.08)';
                  (e.target as HTMLTextAreaElement).style.borderColor = 'rgba(37, 99, 235, 0.5)';
                }}
                onBlur={(e) => {
                  (e.target as HTMLTextAreaElement).style.background = 'rgba(255, 255, 255, 0.05)';
                  (e.target as HTMLTextAreaElement).style.borderColor = 'rgba(255, 255, 255, 0.08)';
                }}
              />
              <p style={{ fontSize: '12px', color: '#6b6b75', marginTop: '6px' }}>
                {formData.description.length}/300
              </p>
            </div>

            {/* Category & Difficulty Row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px' }}>
              {/* Category */}
              <div>
                <label
                  style={{
                    display: 'block',
                    color: '#a1a1aa',
                    fontSize: '13px',
                    marginBottom: '8px',
                    fontWeight: 600
                  }}
                >
                  Category
                </label>
                <select
                  value={formData.category}
                  onChange={handleCategoryChange}
                  style={{
                    width: '100%',
                    padding: '12px 16px',
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    color: '#f5f5f7',
                    fontSize: '14px',
                    fontFamily: 'inherit',
                    transition: 'all 0.2s',
                    boxSizing: 'border-box',
                    cursor: 'pointer'
                  }}
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              {/* Difficulty */}
              <div>
                <label
                  style={{
                    display: 'block',
                    color: '#a1a1aa',
                    fontSize: '13px',
                    marginBottom: '8px',
                    fontWeight: 600
                  }}
                >
                  Difficulty Level
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                  {DIFFICULTY_LEVELS.map((level) => (
                    <button
                      key={level.value}
                      type="button"
                      onClick={() =>
                        handleDifficultyChange(level.value as 'easy' | 'medium' | 'hard')
                      }
                      style={{
                        padding: '12px 14px',
                        background:
                          formData.difficulty === level.value
                            ? 'rgba(37, 99, 235, 0.15)'
                            : 'rgba(255, 255, 255, 0.05)',
                        border:
                          formData.difficulty === level.value
                            ? '1px solid rgba(37, 99, 235, 0.5)'
                            : '1px solid rgba(255, 255, 255, 0.08)',
                        borderRadius: '10px',
                        color:
                          formData.difficulty === level.value ? '#2563EB' : '#a1a1aa',
                        fontSize: '13px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        textAlign: 'center'
                      }}
                      onMouseEnter={(e) => {
                        if (formData.difficulty !== level.value) {
                          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255, 255, 255, 0.08)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (formData.difficulty !== level.value) {
                          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255, 255, 255, 0.05)';
                        }
                      }}
                    >
                      <div>{level.label}</div>
                      <div style={{ fontSize: '11px', opacity: 0.7 }}>{level.description}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Steps */}
            <div>
              <label
                style={{
                  display: 'block',
                  color: '#a1a1aa',
                  fontSize: '13px',
                  marginBottom: '12px',
                  fontWeight: 600
                }}
              >
                Step-by-Step Instructions
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                {formData.steps.map((step, index) => (
                  <div key={index} style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <div
                      style={{
                        width: '32px',
                        height: '32px',
                        minWidth: '32px',
                        background: 'rgba(37, 99, 235, 0.15)',
                        border: '1px solid rgba(37, 99, 235, 0.5)',
                        borderRadius: '10px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '13px',
                        fontWeight: 600,
                        color: '#2563EB'
                      }}
                    >
                      {index + 1}
                    </div>
                    <input
                      type="text"
                      value={step}
                      onChange={(e) => handleStepChange(index, e.target.value)}
                      placeholder={`Step ${index + 1}`}
                      style={{
                        flex: 1,
                        padding: '12px 16px',
                        background: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        borderRadius: '10px',
                        color: '#f5f5f7',
                        fontSize: '14px',
                        fontFamily: 'inherit',
                        transition: 'all 0.2s',
                        boxSizing: 'border-box'
                      }}
                      onFocus={(e) => {
                        (e.target as HTMLInputElement).style.background = 'rgba(255, 255, 255, 0.08)';
                        (e.target as HTMLInputElement).style.borderColor = 'rgba(37, 99, 235, 0.5)';
                      }}
                      onBlur={(e) => {
                        (e.target as HTMLInputElement).style.background = 'rgba(255, 255, 255, 0.05)';
                        (e.target as HTMLInputElement).style.borderColor = 'rgba(255, 255, 255, 0.08)';
                      }}
                    />
                    {formData.steps.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveStep(index)}
                        style={{
                          minWidth: '32px',
                          width: '32px',
                          height: '32px',
                          background: 'rgba(239, 68, 68, 0.1)',
                          border: '1px solid rgba(239, 68, 68, 0.2)',
                          borderRadius: '8px',
                          color: '#ef4444',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          transition: 'all 0.2s'
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239, 68, 68, 0.2)';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239, 68, 68, 0.1)';
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={handleAddStep}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 16px',
                  background: 'rgba(37, 99, 235, 0.1)',
                  border: '1px solid rgba(37, 99, 235, 0.3)',
                  borderRadius: '10px',
                  color: '#2563EB',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(37, 99, 235, 0.15)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(37, 99, 235, 0.1)';
                }}
              >
                + Add Step
              </button>
            </div>

            {/* Why It Works */}
            <div>
              <label
                style={{
                  display: 'block',
                  color: '#a1a1aa',
                  fontSize: '13px',
                  marginBottom: '8px',
                  fontWeight: 600
                }}
              >
                Why It Works
              </label>
              <textarea
                value={formData.whyItWorks}
                onChange={handleWhyItWorksChange}
                placeholder="Explain the science or logic behind this hack"
                maxLength={500}
                rows={4}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '12px',
                  color: '#f5f5f7',
                  fontSize: '14px',
                  fontFamily: 'inherit',
                  transition: 'all 0.2s',
                  boxSizing: 'border-box',
                  resize: 'none'
                }}
                onFocus={(e) => {
                  (e.target as HTMLTextAreaElement).style.background = 'rgba(255, 255, 255, 0.08)';
                  (e.target as HTMLTextAreaElement).style.borderColor = 'rgba(37, 99, 235, 0.5)';
                }}
                onBlur={(e) => {
                  (e.target as HTMLTextAreaElement).style.background = 'rgba(255, 255, 255, 0.05)';
                  (e.target as HTMLTextAreaElement).style.borderColor = 'rgba(255, 255, 255, 0.08)';
                }}
              />
              <p style={{ fontSize: '12px', color: '#6b6b75', marginTop: '6px' }}>
                {formData.whyItWorks.length}/500
              </p>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                padding: '14px 22px',
                background: 'linear-gradient(135deg, #2563EB 0%, #10B981 100%)',
                color: '#fff',
                fontSize: '14px',
                fontWeight: 600,
                border: 'none',
                borderRadius: '999px',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.5 : 1,
                transition: 'all 0.2s',
                boxShadow: '0 8px 28px -10px rgba(37, 99, 235, 0.55), 0 8px 28px -10px rgba(16, 185, 129, 0.45)'
              }}
              onMouseEnter={(e) => {
                if (!loading) (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)';
              }}
            >
              {loading ? 'Submitting...' : 'Submit Hack'}
            </button>

            {/* Info Box */}
            <div
              style={{
                padding: '14px 16px',
                background: 'rgba(37, 99, 235, 0.08)',
                border: '1px solid rgba(37, 99, 235, 0.2)',
                borderRadius: '12px'
              }}
            >
              <p style={{ fontSize: '13px', color: '#a1a1aa' }}>
                <span style={{ fontWeight: 600 }}>Note:</span> Your hack will be reviewed by our team before appearing on the site. This helps maintain quality and prevent spam.
              </p>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function SubmitHackPage() {
  return (
    <ProtectedRoute>
      <SubmitHackFormContent />
    </ProtectedRoute>
  );
}
