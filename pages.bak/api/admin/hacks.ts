import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuid } from 'uuid';

interface AdminHackRequest {
  title: string;
  description: string;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard';
  why_it_works: string;
  content_type: 'video' | 'photo' | 'link';
  content_url: string; // URL or file path
  content_thumbnail?: string;
  source_platform: string; // youtube, tiktok, reddit, instagram, other, user_video, user_photo
  source_attribution: string;
  problem_id?: string;
}

interface PendingHack {
  id: string;
  title: string;
  description: string;
  content_url: string;
  content_thumbnail?: string;
  content_type: string;
  source_attribution: string;
  created_at: string;
  status: string;
}

interface ApiResponse {
  success: boolean;
  hack_id?: string;
  data?: PendingHack[];
  count?: number;
  error?: string;
  message?: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({
      success: false,
      error: 'Supabase credentials not configured',
    });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // GET: Fetch pending hacks for admin review
  if (req.method === 'GET') {
    try {
      const { data: hacks, error } = await supabase
        .from('hacks')
        .select('id, title, description, content_url, content_thumbnail, content_type, source_attribution, created_at, status')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Database error:', error);
        return res.status(500).json({
          success: false,
          error: 'Failed to fetch pending hacks',
        });
      }

      return res.status(200).json({
        success: true,
        data: hacks,
        count: hacks?.length || 0,
      });
    } catch (error) {
      console.error('API error:', error);
      return res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  }

  // POST: Admin creates hack (auto-approved)
  if (req.method === 'POST') {
    try {
      const {
        title,
        description,
        category,
        difficulty,
        why_it_works,
        content_type,
        content_url,
        content_thumbnail,
        source_platform,
        source_attribution,
        problem_id,
      } = req.body as AdminHackRequest;

      // Validate required fields
      if (!title || !description || !category || !content_type || !content_url || !source_platform) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields',
        });
      }

      if (!['video', 'photo', 'link'].includes(content_type)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid content_type',
        });
      }

      // Create hack record (admin hacks go straight to approved)
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
          content_url,
          content_thumbnail,
          source_platform,
          source_attribution,
          created_by: 'admin',
          status: 'approved', // Admin hacks don't need approval
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
          error: 'Failed to create hack',
        });
      }

      return res.status(201).json({
        success: true,
        hack_id: hack.id,
        message: 'Hack added and approved!',
      });
    } catch (error) {
      console.error('API error:', error);
      return res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
}
