import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

interface ApiResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  const { id } = req.query;

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing hack ID' });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({
      success: false,
      error: 'Supabase credentials not configured',
    });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // PATCH: Approve or reject hack
  if (req.method === 'PATCH') {
    try {
      const { action } = req.body;

      if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid action. Must be approve or reject',
        });
      }

      const newStatus = action === 'approve' ? 'approved' : 'rejected';

      const { data: hack, error: updateError } = await supabase
        .from('hacks')
        .update({ status: newStatus })
        .eq('id', id)
        .select()
        .single();

      if (updateError) {
        console.error('Database error:', updateError);
        return res.status(500).json({
          success: false,
          error: 'Failed to update hack status',
        });
      }

      return res.status(200).json({
        success: true,
        message: `Hack ${newStatus}!`,
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
