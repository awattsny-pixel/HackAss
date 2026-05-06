import type { NextApiRequest, NextApiResponse } from 'next';
import fetch from 'node-fetch';

interface ExtractedMetadata {
  title?: string;
  description?: string;
  thumbnail_url?: string;
  platform?: string;
}

interface ApiResponse {
  success: boolean;
  data?: ExtractedMetadata;
  error?: string;
}

// Helper to extract Open Graph meta tags from HTML
function extractMetadata(html: string, url: string): ExtractedMetadata {
  const metadata: ExtractedMetadata = { platform: 'unknown' };

  // Determine platform
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    metadata.platform = 'youtube';
  } else if (url.includes('tiktok.com')) {
    metadata.platform = 'tiktok';
  } else if (url.includes('reddit.com')) {
    metadata.platform = 'reddit';
  } else if (url.includes('instagram.com')) {
    metadata.platform = 'instagram';
  }

  // Extract og:title
  const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (titleMatch) {
    metadata.title = titleMatch[1];
  } else {
    // Fallback to <title> tag
    const simpleTitleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (simpleTitleMatch) {
      metadata.title = simpleTitleMatch[1];
    }
  }

  // Extract og:description
  const descriptionMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
  if (descriptionMatch) {
    metadata.description = descriptionMatch[1];
  } else {
    // Fallback to meta description
    const metaDescMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    if (metaDescMatch) {
      metadata.description = metaDescMatch[1];
    }
  }

  // Extract og:image
  const imageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  if (imageMatch) {
    metadata.thumbnail_url = imageMatch[1];
  }

  return metadata;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: url',
      });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        success: false,
        error: 'Invalid URL format',
      });
    }

    // Fetch the page with a timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    let response: any;
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: controller.signal as any,
      });
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        return res.status(408).json({
          success: false,
          error: 'Request timeout while fetching URL',
        });
      }
      return res.status(400).json({
        success: false,
        error: `Failed to fetch URL: ${error.message}`,
      });
    }

    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(400).json({
        success: false,
        error: `URL returned status ${response.status}`,
      });
    }

    const html = await response.text();
    const metadata = extractMetadata(html, url);

    return res.status(200).json({
      success: true,
      data: {
        title: metadata.title || 'Untitled',
        description: metadata.description || 'No description available',
        thumbnail_url: metadata.thumbnail_url,
        platform: metadata.platform,
      },
    });
  } catch (error) {
    console.error('Extraction error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to extract metadata from URL',
    });
  }
}
