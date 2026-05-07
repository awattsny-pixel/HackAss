-- Migration: Add profile fields and relationship tables for user profiles, followers, and bookmarks
-- Created: 2026-05-07

-- Step 1: Expand users table with profile fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS real_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT CHECK (LENGTH(bio) <= 500);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS followers_count INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS following_count INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_small_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- Step 2: Create follows table
CREATE TABLE IF NOT EXISTS follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(follower_id, following_id),
  CHECK (follower_id != following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

-- Step 3: Create bookmarks table
CREATE TABLE IF NOT EXISTS bookmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hack_id UUID NOT NULL REFERENCES hacks(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, hack_id)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_hack ON bookmarks(hack_id);

-- Step 4: Create archive table (for archived hacks)
CREATE TABLE IF NOT EXISTS archive (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hack_id UUID NOT NULL REFERENCES hacks(id) ON DELETE CASCADE,
  archived_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, hack_id)
);

CREATE INDEX IF NOT EXISTS idx_archive_user ON archive(user_id);
CREATE INDEX IF NOT EXISTS idx_archive_hack ON archive(hack_id);

-- Step 5: Add engagement metrics to hacks table
ALTER TABLE hacks ADD COLUMN IF NOT EXISTS view_count INT DEFAULT 0;
ALTER TABLE hacks ADD COLUMN IF NOT EXISTS share_count INT DEFAULT 0;
ALTER TABLE hacks ADD COLUMN IF NOT EXISTS bookmark_count INT DEFAULT 0;
ALTER TABLE hacks ADD COLUMN IF NOT EXISTS like_count INT DEFAULT 0;

-- Step 6: Create comments table (for hack discussions)
CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hack_id UUID NOT NULL REFERENCES hacks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (LENGTH(content) > 0 AND LENGTH(content) <= 500),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_hack ON comments(hack_id);
CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(hack_id, created_at DESC);

-- Step 7: Create likes table (for tracking likes separately from votes)
CREATE TABLE IF NOT EXISTS likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hack_id UUID NOT NULL REFERENCES hacks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(hack_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_hack ON likes(hack_id);
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id);

-- Step 8: Create materialized view for user stats (for performance)
CREATE MATERIALIZED VIEW IF NOT EXISTS user_stats AS
SELECT
  u.id,
  u.username,
  u.real_name,
  u.bio,
  u.is_verified,
  u.avatar,
  u.profile_image_url,
  u.profile_image_small_url,
  u.website_url,
  COUNT(DISTINCT f.follower_id) as followers,
  COUNT(DISTINCT f2.following_id) as following,
  COUNT(DISTINCT h.id) as posts,
  COUNT(DISTINCT b.hack_id) as bookmarks,
  u.created_at,
  u.updated_at
FROM users u
LEFT JOIN follows f ON f.following_id = u.id
LEFT JOIN follows f2 ON f2.follower_id = u.id
LEFT JOIN hacks h ON h.user_id = u.id AND h.status = 'approved'
LEFT JOIN bookmarks b ON b.user_id = u.id
GROUP BY u.id, u.username, u.real_name, u.bio, u.is_verified, u.avatar,
         u.profile_image_url, u.profile_image_small_url, u.website_url, u.created_at, u.updated_at;

-- Create index on materialized view
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_stats_id ON user_stats(id);
CREATE INDEX IF NOT EXISTS idx_user_stats_username ON user_stats(username);

-- Step 9: Enable RLS (Row Level Security) policies
ALTER TABLE follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE likes ENABLE ROW LEVEL SECURITY;

-- Step 10: RLS Policies for follows table
CREATE POLICY "Public can read follows" ON follows FOR SELECT USING (true);
CREATE POLICY "Authenticated users can follow" ON follows FOR INSERT
  WITH CHECK (auth.uid() = follower_id);
CREATE POLICY "Users can unfollow themselves" ON follows FOR DELETE
  USING (auth.uid() = follower_id);

-- Step 11: RLS Policies for bookmarks table
CREATE POLICY "Users can read their own bookmarks" ON bookmarks FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Authenticated users can bookmark" ON bookmarks FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their own bookmarks" ON bookmarks FOR DELETE
  USING (auth.uid() = user_id);

-- Step 12: RLS Policies for archive table
CREATE POLICY "Users can read their own archive" ON archive FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Authenticated users can archive" ON archive FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their own archive" ON archive FOR DELETE
  USING (auth.uid() = user_id);

-- Step 13: RLS Policies for comments table
CREATE POLICY "Public can read comments" ON comments FOR SELECT USING (true);
CREATE POLICY "Authenticated users can comment" ON comments FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own comments" ON comments FOR UPDATE
  USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own comments" ON comments FOR DELETE
  USING (auth.uid() = user_id);

-- Step 14: RLS Policies for likes table
CREATE POLICY "Public can read likes" ON likes FOR SELECT USING (true);
CREATE POLICY "Authenticated users can like" ON likes FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can unlike their own likes" ON likes FOR DELETE
  USING (auth.uid() = user_id);

-- Step 15: Add trigger to update users.updated_at on profile changes
CREATE OR REPLACE FUNCTION update_user_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_user_updated_at ON users;
CREATE TRIGGER trigger_update_user_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_user_updated_at();

-- Step 16: Add trigger to update likes/bookmarks counts on changes
CREATE OR REPLACE FUNCTION update_hack_engagement_counts()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'likes' THEN
    IF TG_OP = 'INSERT' THEN
      UPDATE hacks SET like_count = like_count + 1 WHERE id = NEW.hack_id;
    ELSIF TG_OP = 'DELETE' THEN
      UPDATE hacks SET like_count = like_count - 1 WHERE id = OLD.hack_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'bookmarks' THEN
    IF TG_OP = 'INSERT' THEN
      UPDATE hacks SET bookmark_count = bookmark_count + 1 WHERE id = NEW.hack_id;
    ELSIF TG_OP = 'DELETE' THEN
      UPDATE hacks SET bookmark_count = bookmark_count - 1 WHERE id = OLD.hack_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_likes_count ON likes;
CREATE TRIGGER trigger_update_likes_count
AFTER INSERT OR DELETE ON likes
FOR EACH ROW
EXECUTE FUNCTION update_hack_engagement_counts();

DROP TRIGGER IF EXISTS trigger_update_bookmarks_count ON bookmarks;
CREATE TRIGGER trigger_update_bookmarks_count
AFTER INSERT OR DELETE ON bookmarks
FOR EACH ROW
EXECUTE FUNCTION update_hack_engagement_counts();

-- Step 17: Add trigger to update follower counts
CREATE OR REPLACE FUNCTION update_follower_counts()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE users SET followers_count = followers_count + 1 WHERE id = NEW.following_id;
    UPDATE users SET following_count = following_count + 1 WHERE id = NEW.follower_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE users SET followers_count = followers_count - 1 WHERE id = OLD.following_id;
    UPDATE users SET following_count = following_count - 1 WHERE id = OLD.follower_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_follower_counts ON follows;
CREATE TRIGGER trigger_update_follower_counts
AFTER INSERT OR DELETE ON follows
FOR EACH ROW
EXECUTE FUNCTION update_follower_counts();
