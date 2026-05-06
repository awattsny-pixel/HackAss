import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase environment variables!');
  console.error('📝 Create a .env.local file in the frontend/ folder with:');
  console.error('   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co');
  console.error('   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key');
  console.error('');
  console.error('📖 See AUTH_SETUP.md for complete instructions.');
}

export const supabase = createClient(supabaseUrl || '', supabaseKey || '');

// Type definitions
export interface User {
  id: string;
  email: string;
  username: string;
  avatar?: string;
  created_at: string;
}

export interface AuthError {
  message: string;
  code?: string;
}
