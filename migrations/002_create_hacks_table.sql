-- Migration: Create hacks table with schema
-- This migration creates the main hacks table and indexes required for the HackAss application

CREATE TABLE IF NOT EXISTS hacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Core metadata
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(50) NOT NULL,
  difficulty VARCHAR(20) DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  why_it_works TEXT NOT NULL,

  -- Content
  content_type VARCHAR(20) NOT NULL CHECK (content_type IN ('video', 'photo', 'link')),
  content_url TEXT NOT NULL,
  content_thumbnail TEXT,
  source_attribution TEXT,
  source_platform VARCHAR(50),

  -- Validation/Voting
  worked_votes INTEGER DEFAULT 0,
  failed_votes INTEGER DEFAULT 0,
  unique_users_who_validated INTEGER DEFAULT 0,
  hack_score NUMERIC(5,2),

  -- System fields
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_by VARCHAR(20) DEFAULT 'user' CHECK (created_by IN ('user', 'admin')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_hacks_status ON hacks(status);
CREATE INDEX IF NOT EXISTS idx_hacks_category ON hacks(category);
CREATE INDEX IF NOT EXISTS idx_hacks_created_at ON hacks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hacks_content_type ON hacks(content_type);
CREATE INDEX IF NOT EXISTS idx_hacks_source_platform ON hacks(source_platform);

-- Enable Row Level Security
ALTER TABLE hacks ENABLE ROW LEVEL SECURITY;

-- Policy: Public read for approved hacks
DROP POLICY IF EXISTS "Public read approved hacks" ON hacks;
CREATE POLICY "Public read approved hacks" ON hacks
FOR SELECT
USING (status = 'approved');

-- Policy: Public insert for submissions (status becomes 'pending')
DROP POLICY IF EXISTS "Public insert pending hacks" ON hacks;
CREATE POLICY "Public insert pending hacks" ON hacks
FOR INSERT
WITH CHECK (true);

-- Policy: Public update votes (worked_votes, failed_votes, unique_users_who_validated)
DROP POLICY IF EXISTS "Public update votes" ON hacks;
CREATE POLICY "Public update votes" ON hacks
FOR UPDATE
USING (true)
WITH CHECK (true);
