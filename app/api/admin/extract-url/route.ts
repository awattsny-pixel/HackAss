import { NextRequest, NextResponse } from 'next/server';

// POST /api/admin/extract-url - Extract metadata from URL
export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json(
        { error: 'URL required' },
        { status: 400 }
      );
    }

    // For MVP, we'll do simple title extraction from common platforms
    // In production, use a library like microlink.io or similar
    let title = '';
    let description = '';

    // Extract platform and ID
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      const videoId = url.includes('v=')
        ? url.split('v=')[1]?.split('&')[0]
        : url.split('/').pop();

      title = `YouTube Video: ${videoId}`;
      description = 'Video from YouTube';
    } else {
      // Generic extraction - try to fetch and parse (covers TikTok, Instagram, Reddit, etc.)
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; HackAss/1.0)'
          },
        });

        if (response.ok) {
          const html = await response.text();

          // Extract title from og:title, <title>, or other meta tags
          let titleMatch = html.match(/og:title[^>]*content="([^"]+)"/i);
          if (!titleMatch) {
            titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          }
          if (titleMatch) {
            title = titleMatch[1].trim().substring(0, 200);
          }

          // Extract description from og:description, meta description, or og:image alt
          let descMatch = html.match(/og:description[^>]*content="([^"]+)"/i);
          if (!descMatch) {
            descMatch = html.match(/name="description"[^>]*content="([^"]+)"/i);
          }
          if (descMatch) {
            description = descMatch[1].trim().substring(0, 500);
          }
        }
      } catch (fetchErr) {
        // If fetch fails, use URL as title
        title = new URL(url).hostname;
        description = 'Content from shared link';
      }
    }

    // Try to extract image/thumbnail
    let imageUrl = '';
    if (typeof window === 'undefined') {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; HackAss/1.0)'
          },
        });
        if (response.ok) {
          const html = await response.text();
          const imageMatch = html.match(/og:image[^>]*content="([^"]+)"/i);
          if (imageMatch) {
            imageUrl = imageMatch[1];
          }
        }
      } catch (err) {
        // Skip image extraction if it fails
      }
    }

    return NextResponse.json({
      data: {
        title: title || 'Shared Link',
        description: description || 'Check out this hack',
        url,
        imageUrl,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to extract URL metadata' },
      { status: 500 }
    );
  }
}
