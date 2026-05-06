'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase, User, AuthError } from './supabase';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signUp: (email: string, password: string, username: string) => Promise<{ error?: AuthError }>;
  signIn: (email: string, password: string) => Promise<{ error?: AuthError }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check if user is already logged in
    checkUser();

    // Set up listener for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (session?.user) {
          await loadUserProfile(session.user.id);
        } else {
          setUser(null);
        }
      }
    );

    return () => subscription?.unsubscribe();
  }, []);

  const checkUser = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        await loadUserProfile(session.user.id);
      }
    } catch (error) {
      console.error('Error checking user:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadUserProfile = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('id, email, username, avatar, created_at')
        .eq('id', userId)
        .single();

      if (error) throw error;
      setUser(data);
    } catch (error) {
      console.error('Error loading user profile:', error);
      setUser(null);
    }
  };

  const signUp = async (
    email: string,
    password: string,
    username: string
  ): Promise<{ error?: AuthError }> => {
    try {
      // Create auth user
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
      });

      if (authError) return { error: { message: authError.message } };
      if (!authData.user) return { error: { message: 'Signup failed' } };

      // Create user profile
      const { error: profileError } = await supabase.from('users').insert([
        {
          id: authData.user.id,
          email,
          username,
          created_at: new Date().toISOString(),
        },
      ]);

      if (profileError) return { error: { message: profileError.message } };

      // Load user profile
      await loadUserProfile(authData.user.id);
      return {};
    } catch (error: any) {
      return { error: { message: error.message || 'Signup error' } };
    }
  };

  const signIn = async (
    email: string,
    password: string
  ): Promise<{ error?: AuthError }> => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) return { error: { message: error.message } };
      if (!data.user) return { error: { message: 'Login failed' } };

      await loadUserProfile(data.user.id);
      return {};
    } catch (error: any) {
      return { error: { message: error.message || 'Login error' } };
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
