import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ hackId: string }> }
) {
  try {
    const { hackId } = await params;
    console.log('[Hack Detail GET] Fetching hack:', hackId);

    // Fetch hack
    const { data: hack, error: hackError } = await supabase
      .from('hacks')
      .select(`
        id,
        title,
        description,
        category,
        difficulty,
        why_it_works,
        content_type,
        content_url,
        content_thumbnail,
        created_at,
        worked_votes,
        failed_votes,
        view_count,
        share_count,
        like_count,
        bookmark_count,
        source_attribution,
        user_id
      `)
      .eq('id', hackId)
      .single();

    if (hackError) {
      console.error('[Hack Detail GET] Hack query error:', hackError);
      return Response.json(
        { error: 'Hack not found', details: hackError.message },
        { status: 404 }
      );
    }

    if (!hack) {
      console.error('[Hack Detail GET] Hack is null');
      return Response.json(
        { error: 'Hack not found' },
        { status: 404 }
      );
    }

    console.log('[Hack Detail GET] Found hack:', hack.id, 'user_id:', hack.user_id);

    // Handle null or missing user_id
    if (!hack.user_id) {
      console.log('[Hack Detail GET] Hack has no user_id, returning with default user');
      return Response.json({
        ...hack,
        users: {
          id: null,
          username: 'Unknown',
          avatar: null,
          profile_image_url: null,
          is_verified: false,
          real_name: null,
          bio: null,
        },
      });
    }

    // Fetch user data separately
    console.log('[Hack Detail GET] Fetching user:', hack.user_id);
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, username, avatar, profile_image_url, is_verified, real_name, bio')
      .eq('id', hack.user_id)
      .single();

    if (userError) {
      console.error('[Hack Detail GET] User query error:', userError);
      // Return hack with default user instead of failing
      console.log('[Hack Detail GET] User not found, returning with default user');
      return Response.json({
        ...hack,
        users: {
          id: hack.user_id,
          username: 'Unknown',
          avatar: null,
          profile_image_url: null,
          is_verified: false,
          real_name: null,
          bio: null,
        },
      });
    }

    if (!user) {
      console.error('[Hack Detail GET] User is null');
      return Response.json({
        ...hack,
        users: {
          id: hack.user_id,
          username: 'Unknown',
          avatar: null,
          profile_image_url: null,
          is_verified: false,
          real_name: null,
          bio: null,
        },
      });
    }

    console.log('[Hack Detail GET] Returning hack with user:', user.username);
    // Combine hack and user data
    return Response.json({
      ...hack,
      users: user,
    });
  } catch (error) {
    console.error('[Hack Detail GET] Error:', error instanceof Error ? error.message : error);
    console.error('[Hack Detail GET] Full error:', error);
    return Response.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
