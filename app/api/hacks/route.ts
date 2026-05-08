import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

// Use service role key if available (server-side), otherwise fallback to anon key
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// GET /api/hacks - Fetch approved hacks for the feed
export async function GET(request: NextRequest) {
  try {
    const { data: hacks, error } = await supabase
      .from('hacks')
      .select('*')
      .eq('status', 'approved')
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ hacks });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to fetch hacks' },
      { status: 500 }
    );
  }
}

// POST /api/hacks - Submit a new hack
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      title,
      description,
      category,
      difficulty,
      why_it_works,
      content_type,
      content_url,
    } = body;

    // Validate required fields
    if (!title || !description || !category || !why_it_works) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    if (!content_url && (content_type === 'video' || content_type === 'photo')) {
      return NextResponse.json(
        { error: 'Content URL required for video/photo' },
        { status: 400 }
      );
    }

    // Insert hack with pending status
    const { data, error } = await supabase
      .from('hacks')
      .insert({
        title,
        description,
        category,
        difficulty,
        why_it_works,
        content_type,
        content_url: content_url || null,
        status: 'pending',
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { message: 'Hack submitted successfully', hack: data },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to submit hack' },
      { status: 500 }
    );
  }
}
