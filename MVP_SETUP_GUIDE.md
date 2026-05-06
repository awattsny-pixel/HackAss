# HackAss MVP Setup Guide

Complete web app with video/photo uploads, user submissions, admin approval, and ranking system.

## What's Built

### Backend Endpoints
- ✅ `POST /api/hacks` - User submits hack (video/photo/link)
- ✅ `POST /api/admin/hacks` - Admin adds hack (auto-approved)
- ✅ `POST /api/admin/extract-url` - Auto-extract metadata from URLs
- ✅ `GET /api/admin/hacks` - List pending hacks for review
- ✅ `PATCH /api/admin/hacks/{id}` - Approve/reject hack
- ✅ `GET /api/hacks/ranking` - Get ranked hacks (approved only)
- ✅ `POST /api/validations` - User votes on hack

### Frontend Components
- ✅ `SubmitHackForm` - Upload video/photo or paste link, with URL auto-extraction
- ✅ `HackCard` - Display hack with video/photo, stats, CTA
- ✅ `ValidationPrompt` - "Did it work?" voting dialog
- ✅ `RankedFeed` - Main feed page with category filter and sort options
- ✅ `AdminDashboard` - Review pending hacks, approve/reject

### Pages
- ✅ `/` - Main feed (ranked hacks with filters)
- ✅ `/submit` - User submission form
- ✅ `/admin` - Admin approval dashboard

## Setup Steps

### 1. Install Dependencies

```bash
npm install
```

This installs:
- `uuid` - Generate unique IDs
- `node-fetch` - Fetch URLs for metadata extraction
- `react-player` - Video player component
- `tailwindcss` - CSS styling
- `postcss`, `autoprefixer` - CSS processing

### 2. Update Database Schema

In Supabase SQL Editor, run:

```sql
-- Add video/content fields to hacks table
ALTER TABLE hacks
ADD COLUMN content_type VARCHAR(20) DEFAULT 'video' CHECK (content_type IN ('video', 'photo', 'link')),
ADD COLUMN content_url TEXT,
ADD COLUMN content_thumbnail TEXT,
ADD COLUMN source_platform VARCHAR(50),
ADD COLUMN source_attribution TEXT,
ADD COLUMN created_by VARCHAR(20) DEFAULT 'user' CHECK (created_by IN ('user', 'admin')),
ADD COLUMN status VARCHAR(20) DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected'));

-- Create indexes
CREATE INDEX idx_hacks_status ON hacks(status);
CREATE INDEX idx_hacks_content_type ON hacks(content_type);
CREATE INDEX idx_hacks_source_platform ON hacks(source_platform);
CREATE INDEX idx_hacks_created_by ON hacks(created_by);
CREATE INDEX idx_hacks_created_at_status ON hacks(created_at DESC, status);

-- Add constraint
ALTER TABLE hacks
ADD CONSTRAINT hacks_content_url_required CHECK (content_url IS NOT NULL);
```

### 3. Set up Supabase Storage (for video/photo uploads)

In Supabase Console:
1. Go to Storage
2. Create a new bucket: `hack-videos`
3. Make it public (allows downloads)
4. Add CORS policy for video playback

### 4. Migrate Existing Seed Data (Optional)

Update your seed data to include content_url:

```sql
UPDATE hacks SET
  content_type = 'video',
  content_url = video_url,
  source_platform = 'seed_data',
  source_attribution = 'Admin curated',
  created_by = 'admin',
  status = 'approved'
WHERE content_url IS NULL AND video_url IS NOT NULL;
```

### 5. Start Dev Server

```bash
npm run dev
```

Server runs at http://localhost:3000

## Testing the Loop

### Flow 1: User Submission → Admin Approval → Vote

1. Go to http://localhost:3000/submit
2. Fill form:
   - Title: "Remove stains from white shirts"
   - Description: "Mix baking soda with vinegar..."
   - Category: "Cleaning & laundry"
   - Why it works: "Baking soda is alkaline..."
   - Content: Paste YouTube/TikTok link
   - Click "Extract" to auto-fill title/description
3. Submit → Hack marked as "pending"
4. Go to http://localhost:3000/admin
5. See pending hack, click "Approve"
6. Hack now appears in feed (http://localhost:3000)
7. Click "Did it work?" → Vote
8. Validator count increments, ranking updates

### Flow 2: Admin Direct Add

1. Go to http://localhost:3000/admin
2. Use `POST /api/admin/hacks` via curl/Postman:

```bash
curl -X POST http://localhost:3000/api/admin/hacks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Clean oven with baking soda",
    "description": "Paste baking soda...",
    "category": "Cleaning & laundry",
    "difficulty": "easy",
    "why_it_works": "Chemical reaction...",
    "content_type": "link",
    "content_url": "https://youtube.com/watch?v=...",
    "source_platform": "youtube",
    "source_attribution": "YouTube: Clean My Space"
  }'
```

Hack goes straight to approved (no pending).

### Flow 3: URL Metadata Extraction

Test extraction with curl:

```bash
curl -X POST http://localhost:3000/api/admin/extract-url \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

Response:
```json
{
  "success": true,
  "data": {
    "title": "Extracted title",
    "description": "Extracted description",
    "thumbnail_url": "https://..."
  }
}
```

## Key Features

### Content Types
- **Video upload**: Max 100MB, MP4/MOV, 30s-10m
- **Photo upload**: Max 20MB, JPG/PNG
- **External links**: YouTube, TikTok, Reddit, Instagram, any URL

### Validation Workflow
1. User tries hack in real life
2. Returns to app
3. Clicks "Did it work?" on hack card
4. Selects: ✓ Worked | ⚠ Partially | ✕ Didn't work
5. Vote submitted → hack stats update → ranking recalculates

### Admin Features
- Review pending submissions
- Auto-extract title/description/thumbnail from URLs
- Approve individual submissions
- Manually add hacks from other platforms
- Admin submissions skip pending (go straight to approved)

## Next Steps (Phase 2)

1. **File Upload Handling**: Implement actual video/photo file uploads to Supabase Storage
   - Use `formidable` or `next-multipart` for multipart form data
   - Stream files to storage
   - Generate video thumbnails

2. **User Tracking**: Track unique users voting
   - Simple: Use IP address + user-agent hash
   - Better: Add optional user auth
   - Track user history ("Did it work?" per user)

3. **Video Processing**:
   - Compress videos for faster upload/playback
   - Auto-generate thumbnails from video
   - Support for more platforms (Instagram Reels, TikTok embeds)

4. **Admin Dashboard Enhancements**:
   - Login/auth protection
   - Bulk operations (approve multiple at once)
   - Search/filter pending
   - View approved hacks
   - Metrics (approval rate, etc)

5. **Frontend Polish**:
   - Loading states for video playback
   - Error handling for failed embeds
   - Video fullscreen modal
   - Share buttons
   - Save/bookmark hacks

## Troubleshooting

**"Content URL required" error:**
- Make sure content_url is populated before inserting hack
- For user submissions, you may need to stream file to storage first

**Videos not embedding:**
- Check URL format matches YouTube/TikTok/Reddit
- Some platforms may require authentication or have CORS issues
- Test URL directly in browser to verify it works

**Validation votes not working:**
- Check `/api/validations` endpoint is reachable
- Verify hack exists in database
- Check Supabase permissions allow updates

**Admin dashboard not showing pending:**
- Ensure hacks have `status='pending'`
- Check database has new status column
- Restart dev server after schema changes

## Database Schema (New Columns)

```typescript
// Each hack now has:
content_type: 'video' | 'photo' | 'link'
content_url: string  // File path, YouTube URL, etc
content_thumbnail?: string  // Preview image
source_platform: string  // youtube, tiktok, reddit, instagram, user_video, user_photo, etc
source_attribution: string  // "YouTube: Channel Name" or "User submission"
created_by: 'user' | 'admin'
status: 'pending' | 'approved' | 'rejected'
```

## Files Created

### Backend
- `/pages/api/hacks/index.ts` - User submit
- `/pages/api/hacks/ranking.ts` - Get ranked hacks (updated)
- `/pages/api/admin/hacks.ts` - Admin CRUD
- `/pages/api/admin/hacks/[id].ts` - Approve/reject
- `/pages/api/admin/extract-url.ts` - URL metadata extraction
- `/pages/api/validations.ts` - Vote submission

### Frontend
- `/app/page.tsx` - Main feed
- `/app/submit/page.tsx` - Submit form
- `/app/admin/page.tsx` - Admin dashboard
- `/app/components/SubmitHackForm.tsx` - Form component
- `/app/components/HackCard.tsx` - Hack card component
- `/app/components/ValidationPrompt.tsx` - Voting dialog

### Config
- `tailwind.config.js` - Tailwind CSS config
- `postcss.config.js` - PostCSS config
- `package.json` - Dependencies (updated)
- `/migrations/001_add_video_support.sql` - Schema migration

---

**Ready to test!** Start with http://localhost:3000 after setup.
