import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  try {
    const { username, email, password } = await request.json();

    // Validation
    if (!username || !email || !password) {
      return Response.json(
        { message: 'Username, email, and password are required' },
        { status: 400 }
      );
    }

    if (password.length < 6) {
      return Response.json(
        { message: 'Password must be at least 6 characters' },
        { status: 400 }
      );
    }

    // Check if user already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .or(`email.eq.${email},username.eq.${username}`)
      .single();

    if (existingUser) {
      return Response.json(
        { message: 'Email or username already in use' },
        { status: 409 }
      );
    }

    // Create new user
    const userId = crypto.randomUUID();
    const { error: insertError } = await supabase
      .from('users')
      .insert({
        id: userId,
        username,
        email,
        is_verified: false,
        created_at: new Date().toISOString(),
      });

    if (insertError) {
      console.error('Insert error:', insertError);
      return Response.json(
        { message: 'Failed to create account' },
        { status: 500 }
      );
    }

    // Generate token
    const token = crypto.randomBytes(32).toString('hex');

    return Response.json({
      user: {
        id: userId,
        email,
        username,
      },
      token,
    });
  } catch (error) {
    console.error('Signup error:', error);
    return Response.json(
      { message: 'Internal server error' },
      { status: 500 }
    );
  }
}
