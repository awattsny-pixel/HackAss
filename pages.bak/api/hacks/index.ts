import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuid } from 'uuid';

interface SubmitHackRequest {
  title: string;
  description: string;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard';
  why_it_works: string;
  content_type: 'video' | 'photo' | 'link';
  content_file?: File; // For video/photo uploads
  content_url?: string; // For links or extracted from file
  problem_id?: string;
}

interface ApiResponse {
  success: boolean;
  hack_id?: string;
  content_url?: string;
  error?: string;
  message?: string;
}

// Validation constants
const CONSTRAINTS = {
  VIDEO: { maxSize: 100 * 1024 * 1024, formats: ['video/mp4', 'video/quicktime'], extensions: ['.mp4', '.mov'] },
  PHOTO: { maxSize: 20 * 1024 * 1024, formats: ['image/jpeg', 'image/png'], extensions: ['.jpg', '.jpeg', '.png'] },
  VIDEO_DURATION: { min: 30, max: 600 }, // 30s to 10m
};

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '100mb',
    },
  },
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return res.status(500).json({
        success: false,
        error: 'Supabase credentials not configured',
      });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey);

    // Parse request body (assumes application/json, not multipart)
    // For file uploads, you'll need to use a library like 'formidable' or 'multer'
    // For MVP, we'll support JSON with base64 or just URLs

    const {
      title,
      description,
      category,
      difficulty,
      why_it_works,
      content_type,
      content_url, // For links or URLs
      problem_id,
    } = req.body;

    // Validate required fields
    if (!title || !description || !category || !content_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: title, description, category, content_type',
      });
    }

    if (!['video', 'photo', 'link'].includes(content_type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid content_type. Must be video, photo, or link',
      });
    }

    // For MVP: Handle external links and stored URLs
    // File uploads will require a separate multipart endpoint
    if (content_type === 'link' && !content_url) {
      return res.status(400).json({
        success: false,
        error: 'External links require content_url',
      });
    }

    // Determine source platform from URL
    let source_platform = 'user_' + content_type;
    let source_attribution = 'User submission';

    if (content_type === 'link' && content_url) {
      if (content_url.includes('youtube.com') || content_url.includes('youtu.be')) {
        source_platform = 'youtube';
        source_attribution = 'YouTube';
      } else if (content_url.includes('tiktok.com')) {
        source_platform = 'tiktok';
        source_attribution = 'TikTok';
      } else if (content_url.includes('reddit.com')) {
        source_platform = 'reddit';
        source_attribution = 'Reddit';
      } else if (content_url.includes('instagram.com')) {
        source_platform = 'instagram';
        source_attribution = 'Instagram';
      } else {
        source_platform = 'other';
        source_attribution = 'External link';
      }
    }

    // Create hack record
    const hack_id = uuid();
    const { data: hack, error: insertError } = await supabase
      .from('hacks')
      .insert({
        id: hack_id,
        title,
        description,
        category,
        difficulty,
        why_it_works,
        content_type,
        content_url: content_url || '', // Will be filled by file upload separately
        source_platform,
        source_attribution,
        created_by: 'user',
        status: 'pending', // User submissions require approval
        problem_id: problem_id || null,
        worked_votes: 0,
        failed_votes: 0,
        unique_users_who_validated: 0,
        upvotes: 0,
        impressions: 0,
      })
      .select()
      .single();

    if (insertError) {
      console.error('Database error:', insertError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create hack record',
      });
    }

    return res.status(201).json({
      success: true,
      hack_id: hack.id,
      content_url: hack.content_url,
      message: 'Hack submitted! Pending admin approval.',
    });
  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
}
