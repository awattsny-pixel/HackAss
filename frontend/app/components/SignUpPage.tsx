'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/lib/auth-context';

export default function SignUpPage() {
  const router = useRouter();
  const { signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email || !username || !password || !confirmPassword) {
      setError('All fields are required');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    if (username.length < 3) {
      setError('Username must be at least 3 characters');
      return;
    }

    setLoading(true);

    const { error: signUpError } = await signUp(email, password, username);

    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    router.push('/');
  };

  return (
    <div className="min-h-screen" style={{ background: '#0a0a0a' }}>
      {/* Background glows */}
      <div style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 0
      }}>
        <div style={{
          position: 'absolute',
          top: '-10%',
          left: '-10%',
          width: '600px',
          height: '600px',
          background: 'radial-gradient(circle, #2563EB 0%, transparent 70%)',
          filter: 'blur(120px)',
          opacity: 0.25
        }} />
        <div style={{
          position: 'absolute',
          bottom: '-20%',
          right: '-10%',
          width: '700px',
          height: '700px',
          background: 'radial-gradient(circle, #10B981 0%, transparent 70%)',
          filter: 'blur(120px)',
          opacity: 0.15
        }} />
      </div>

      {/* Content */}
      <div className="relative z-10 min-h-screen flex items-center justify-center p-5">
        <div style={{ maxWidth: '480px', width: '100%' }}>
          {/* Card */}
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.025)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '20px',
              padding: '48px 32px',
              backdropFilter: 'blur(20px)'
            }}
          >
            {/* Header */}
            <div style={{ marginBottom: '32px', textAlign: 'center' }}>
              <h1
                style={{
                  fontSize: 'clamp(28px, 5vw, 36px)',
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 700,
                  color: '#f5f5f7',
                  marginBottom: '12px',
                  letterSpacing: '-0.025em'
                }}
              >
                Join HackAgg
              </h1>
              <p style={{ color: '#a1a1aa', fontSize: '15px' }}>
                Discover and share life-changing hacks
              </p>
            </div>

            {/* Error */}
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

            {/* Form */}
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Email */}
              <div>
                <label style={{ display: 'block', color: '#a1a1aa', fontSize: '13px', marginBottom: '8px', fontWeight: 600 }}>
                  Email Address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
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
              </div>

              {/* Username */}
              <div>
                <label style={{ display: 'block', color: '#a1a1aa', fontSize: '13px', marginBottom: '8px', fontWeight: 600 }}>
                  Username
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Choose a username"
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
              </div>

              {/* Password */}
              <div>
                <label style={{ display: 'block', color: '#a1a1aa', fontSize: '13px', marginBottom: '8px', fontWeight: 600 }}>
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min 6 characters"
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
              </div>

              {/* Confirm Password */}
              <div>
                <label style={{ display: 'block', color: '#a1a1aa', fontSize: '13px', marginBottom: '8px', fontWeight: 600 }}>
                  Confirm Password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm password"
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
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '14px 22px',
                  background: `linear-gradient(135deg, #2563EB 0%, #10B981 100%)`,
                  color: '#fff',
                  fontSize: '14px',
                  fontWeight: 600,
                  border: 'none',
                  borderRadius: '999px',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  opacity: loading ? 0.5 : 1,
                  transition: 'all 0.2s',
                  marginTop: '12px',
                  boxShadow: '0 8px 28px -10px rgba(37, 99, 235, 0.55), 0 8px 28px -10px rgba(16, 185, 129, 0.45)'
                }}
                onMouseEnter={(e) => {
                  if (!loading) (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)';
                }}
              >
                {loading ? 'Creating Account...' : 'Create Account'}
              </button>
            </form>

            {/* Divider */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '24px 0' }}>
              <div style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.08)' }} />
              <span style={{ color: '#a1a1aa', fontSize: '13px' }}>Already have an account?</span>
              <div style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.08)' }} />
            </div>

            {/* Login Link */}
            <Link
              href="/login"
              style={{
                display: 'block',
                textAlign: 'center',
                padding: '12px 22px',
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.14)',
                borderRadius: '999px',
                color: '#2563EB',
                fontSize: '14px',
                fontWeight: 600,
                textDecoration: 'none',
                transition: 'all 0.2s',
                cursor: 'pointer'
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(255, 255, 255, 0.08)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(255, 255, 255, 0.04)';
              }}
            >
              Sign In
            </Link>
          </div>

          {/* Footer */}
          <p style={{ textAlign: 'center', color: '#6b6b75', fontSize: '12px', marginTop: '24px' }}>
            By signing up, you agree to our Terms of Service and Privacy Policy
          </p>
        </div>
      </div>
    </div>
  );
}
