'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

interface AuthUser {
  id: string;
  email: string;
  username: string;
  avatar?: string;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  logout: () => Promise<void>;
  setUser: (user: AuthUser | null) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setUser = useCallback((newUser: AuthUser | null) => {
    setUserState(newUser);
    if (newUser) {
      localStorage.setItem('user_data', JSON.stringify(newUser));
    } else {
      localStorage.removeItem('user_data');
    }
  }, []);

  useEffect(() => {
    // Check for existing auth session on mount
    const checkAuth = () => {
      try {
        // Check if there's a stored auth token in localStorage
        const token = localStorage.getItem('auth_token');
        const userData = localStorage.getItem('user_data');

        if (token && userData) {
          const parsedUser = JSON.parse(userData);
          setUserState(parsedUser);
        } else {
          setUserState(null);
        }
      } catch (err) {
        console.error('Auth check failed:', err);
        // Clear invalid auth data
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user_data');
        setUserState(null);
        setError('Failed to check authentication');
      } finally {
        setLoading(false);
      }
    };

    // Only run on client side
    if (typeof window !== 'undefined') {
      checkAuth();
    }
  }, []);

  const logout = async () => {
    try {
      // Clear auth token and user data
      localStorage.removeItem('auth_token');
      localStorage.removeItem('user_data');
      setUser(null);
    } catch (err) {
      console.error('Logout failed:', err);
      setError('Failed to logout');
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, error, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
