import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ username: string }> }
) {
  try {
    const { username } = await params;
    const url = new URL(request.url);
    const tab = url.searchParams.get('tab') || 'grid';
    const limit = parseInt(url.searchParams.get('limit') || '12');
    const cursor = url.searchParams.get('cursor');

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('username', username)
      .single();

    if (!user) {
      return Response.json({ message: 'User not found' }, { status: 404 });
    }

    let query = supabase
      .from('hacks')
      .select('id, title, description, category, content_type, content_thumbnail, created_at, worked_votes, failed_votes')
      .eq('user_id', user.id)
      .eq('status', 'approved')
      .order('created_at', { ascending: false });

    if (tab === 'videos') {
      query = query.in('content_type', ['video/mp4', 'video/youtube', 'video/webm']);
    } else if (tab === 'bookmarks') {
      query = supabase
        .from('bookmarks')
        .select('hacks(id, title, description, category, content_type, content_thumbnail, created_at, worked_votes, failed_votes)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
    }

    if (cursor) {
      query = query.lt('created_at', cursor);
    }

    const { data: hacks, error } = await query.limit(limit + 1);

    if (error) throw error;

    const hasMore = (hacks?.length || 0) > limit;
    const data = (hacks || []).slice(0, limit);
    const nextCursor = data.length > 0 ? data[data.length - 1].created_at : null;

    return Response.json({
      data,
      meta: { hasMore, cursor: nextCursor },
    });
  } catch (error) {
    console.error('Error:', error);
    return Response.json({ data: [], meta: { hasMore: false, cursor: null } });
  }
}
