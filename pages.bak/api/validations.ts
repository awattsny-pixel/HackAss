import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

interface ValidationRequest {
  hack_id: string;
  outcome: 'worked' | 'partially' | 'failed';
}

interface ApiResponse {
  success: boolean;
  validation_id?: string;
  error?: string;
}

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

    const { hack_id, outcome } = req.body as ValidationRequest;

    // Validate input
    if (!hack_id || !outcome) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: hack_id, outcome',
      });
    }

    if (!['worked', 'partially', 'failed'].includes(outcome)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid outcome. Must be worked, partially, or failed',
      });
    }

    // Get the hack first to check it exists
    const { data: hack, error: hackError } = await supabase
      .from('hacks')
      .select('id, worked_votes, failed_votes, unique_users_who_validated')
      .eq('id', hack_id)
      .single();

    if (hackError || !hack) {
      return res.status(404).json({
        success: false,
        error: 'Hack not found',
      });
    }

    // Update votes based on outcome
    let updates: any = {};
    if (outcome === 'worked') {
      updates.worked_votes = (hack.worked_votes || 0) + 1;
    } else if (outcome === 'failed') {
      updates.failed_votes = (hack.failed_votes || 0) + 1;
    } else if (outcome === 'partially') {
      // Count partially worked votes - we'll add them to worked_votes but with a partial weight
      updates.worked_votes = Math.floor((hack.worked_votes || 0) + 0.5);
    }

    // Increment unique validators (simplified - doesn't track unique users yet)
    updates.unique_users_who_validated = (hack.unique_users_who_validated || 0) + 1;

    // Update the hack record
    const { data: updatedHack, error: updateError } = await supabase
      .from('hacks')
      .update(updates)
      .eq('id', hack_id)
      .select()
      .single();

    if (updateError) {
      console.error('Update error:', updateError);
      return res.status(500).json({
        success: false,
        error: 'Failed to record vote',
      });
    }

    // Optionally: Insert into a validations table for detailed history
    // (Skipping for MVP, but recommended for analytics)

    return res.status(201).json({
      success: true,
      validation_id: `${hack_id}-${Date.now()}`,
    });
  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
}
