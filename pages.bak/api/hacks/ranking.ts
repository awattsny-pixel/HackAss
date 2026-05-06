import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { calculateHackScore, HackData } from '@/app/lib/hack-ranking';

interface Hack {
  id: string;
  solution_id?: string;
  problem_id: string;
  title: string;
  description: string;
  steps?: string[];
  category: string;
  difficulty: string;
  why_it_works: string;
  source?: string;
  content_type: string;
  content_url: string;
  content_thumbnail?: string;
  source_platform?: string;
  source_attribution?: string;
  created_at: string;
  worked_votes: number;
  failed_votes: number;
  unique_users_who_validated: number;
  upvotes: number;
  impressions: number;
}

interface RankedHack extends Hack {
  score: number;
  success_rate: number;
}

interface ApiResponse {
  success: boolean;
  data?: RankedHack[];
  error?: string;
  count?: number;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Initialize Supabase client
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return res.status(500).json({
        success: false,
        error: 'Supabase credentials not configured',
      });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey);

    // Get query parameters
    const { sort = 'best', limit = 50, offset = 0, problem_id } = req.query;
    const sortType = (sort as string).toLowerCase() || 'best';
    const pageLimit = Math.min(parseInt(limit as string) || 50, 100);
    const pageOffset = parseInt(offset as string) || 0;

    // Build query
    let query = supabase
      .from('hacks')
      .select(
        `
        id,
        solution_id,
        problem_id,
        title,
        description,
        steps,
        category,
        difficulty,
        why_it_works,
        source,
        content_type,
        content_url,
        content_thumbnail,
        source_platform,
        source_attribution,
        created_at,
        worked_votes,
        failed_votes,
        unique_users_who_validated,
        upvotes,
        impressions
      `
      )
      .eq('status', 'approved'); // Only return approved solutions

    // Filter by problem if specified
    if (problem_id) {
      query = query.eq('problem_id', problem_id as string);
    }

    // Execute query
    const { data: hacks, error } = await query;

    if (error) {
      console.error('Database error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch solutions from database',
      });
    }

    if (!hacks || hacks.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        count: 0,
      });
    }

    // Calculate scores for all hacks
    const hacksWithScores = (hacks as Hack[]).map((hack) => {
      const successRate =
        hack.worked_votes + hack.failed_votes > 0
          ? hack.worked_votes / (hack.worked_votes + hack.failed_votes)
          : 0;

      const hackData: HackData = {
        id: hack.id,
        title: hack.title,
        created_at: hack.created_at,
        worked_votes: hack.worked_votes,
        failed_votes: hack.failed_votes,
        unique_users_who_validated: hack.unique_users_who_validated,
        upvotes: hack.upvotes,
        impressions: hack.impressions,
      };

      const score = calculateHackScore(hackData);

      return {
        ...hack,
        score,
        success_rate: successRate,
      };
    });

    // Sort based on requested sort type
    let ranked: RankedHack[] = [];

    switch (sortType) {
      case 'best':
        // Sort by score (highest first) - ranking algorithm
        ranked = hacksWithScores.sort((a, b) => b.score - a.score);
        break;

      case 'trending':
        // Sort by success rate and recent activity
        ranked = hacksWithScores.sort((a, b) => {
          const successDiff = b.success_rate - a.success_rate;
          if (Math.abs(successDiff) > 0.05) return successDiff;

          // Tiebreaker: upvotes
          return b.upvotes - a.upvotes;
        });
        break;

      case 'newest':
        // Sort by creation date (most recent first)
        ranked = hacksWithScores.sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        break;

      default:
        ranked = hacksWithScores.sort((a, b) => b.score - a.score);
    }

    // Apply pagination
    const paginatedResults = ranked.slice(pageOffset, pageOffset + pageLimit);

    // Return results
    return res.status(200).json({
      success: true,
      data: paginatedResults,
      count: ranked.length,
    });
  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
}
