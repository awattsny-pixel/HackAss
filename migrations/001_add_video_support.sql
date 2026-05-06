-- Migration: Add video, photo, and link support to hacks table
-- Enables user uploads (video/photo/links) and admin curation

-- Add content type and URL fields
ALTER TABLE hacks
ADD COLUMN content_type VARCHAR(20) DEFAULT 'video' CHECK (content_type IN ('video', 'photo', 'link')),
ADD COLUMN content_url TEXT,
ADD COLUMN content_thumbnail TEXT,
ADD COLUMN source_platform VARCHAR(50),
ADD COLUMN source_attribution TEXT,
ADD COLUMN created_by VARCHAR(20) DEFAULT 'user' CHECK (created_by IN ('user', 'admin')),
ADD COLUMN status VARCHAR(20) DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected'));

-- Maintain backward compatibility: existing hacks are videos
UPDATE hacks SET
  content_type = 'video',
  content_url = video_url,
  created_by = 'admin',
  status = 'approved'
WHERE content_url IS NULL AND video_url IS NOT NULL;

-- Create indexes for common queries
CREATE INDEX idx_hacks_status ON hacks(status);
CREATE INDEX idx_hacks_content_type ON hacks(content_type);
CREATE INDEX idx_hacks_source_platform ON hacks(source_platform);
CREATE INDEX idx_hacks_created_by ON hacks(created_by);
CREATE INDEX idx_hacks_created_at_status ON hacks(created_at DESC, status);

-- Add constraints
ALTER TABLE hacks
ADD CONSTRAINT hacks_content_url_required CHECK (content_url IS NOT NULL);

-- Optional: Drop old video_url column if no longer needed (keep for now for backward compat)
-- ALTER TABLE hacks DROP COLUMN video_url;

-- Grant public read access for feed queries
-- (RLS policies should be set in Supabase dashboard)
