import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return Response.json(
        { message: 'Email and password are required' },
        { status: 400 }
      );
    }

    // Handle demo credentials specially
    if (email === 'demo@hackass.com' && password === 'demo123') {
      // Check if demo user exists
      let { data: user, error: queryError } = await supabase
        .from('users')
        .select('id, email, username, avatar, is_verified, bio')
        .eq('email', email)
        .single();

      // If demo user doesn't exist, create it
      if (queryError || !user) {
        const demoUserId = crypto.randomUUID();
        const { error: insertError } = await supabase
          .from('users')
          .insert({
            id: demoUserId,
            username: 'demo_user',
            email: 'demo@hackass.com',
            is_verified: true,
            bio: 'Demo account for testing',
            created_at: new Date().toISOString(),
          });

        if (insertError) {
          console.error('Failed to create demo user:', insertError);
          return Response.json(
            { message: 'Failed to login' },
            { status: 500 }
          );
        }

        user = {
          id: demoUserId,
          email: 'demo@hackass.com',
          username: 'demo_user',
          avatar: null,
          is_verified: true,
          bio: 'Demo account for testing',
        };
      }

      // Generate token
      const token = crypto.randomBytes(32).toString('hex');

      // Store token in database
      const { error: tokenError } = await supabase
        .from('auth_tokens')
        .insert({
          user_id: user.id,
          token,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        });

      if (tokenError) {
        console.error('Failed to store auth token:', tokenError);
      }

      return Response.json({
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
        },
        token,
      });
    }

    // For other logins, query database
    const { data: user, error: queryError } = await supabase
      .from('users')
      .select('id, email, username, avatar, is_verified, bio')
      .eq('email', email)
      .single();

    if (queryError || !user) {
      return Response.json(
        { message: 'Invalid email or password' },
        { status: 401 }
      );
    }

    // For other logins, reject for now (no password hash stored)
    return Response.json(
      { message: 'Invalid email or password' },
      { status: 401 }
    );
  } catch (error) {
    console.error('Login error:', error);
    return Response.json(
      { message: 'Internal server error' },
      { status: 500 }
    );
  }
}
