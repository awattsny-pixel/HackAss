# Database Setup Instructions

Your Supabase project is configured and ready. Follow these steps to create the database schema and seed data:

## Quick Setup (5 minutes)

### Option 1: Using Supabase Dashboard (Recommended)

1. **Go to Supabase Dashboard**
   - Visit: https://app.supabase.com/
   - Log in with your account
   - Select your project: `xquderctyjhpgvpnklww`

2. **Create Hacks Table**
   - Click on **SQL Editor** (left sidebar)
   - Click **New Query**
   - Copy the entire contents of `migrations/002_create_hacks_table.sql`
   - Paste into the editor
   - Click **Run** button
   - Wait for success message ✓

3. **Seed Initial Data**
   - Click **New Query** again
   - Copy the entire contents of `migrations/003_seed_hacks_initial.sql`
   - Paste into the editor
   - Click **Run** button
   - Wait for success message ✓

4. **Verify**
   - Click on **Table Editor** (left sidebar)
   - You should see `hacks` table with 15 rows
   - Click **Browse** to see the seed data

### Option 2: Using Node.js Script

If you have Node.js installed:

```bash
cd /Users/AlanWatts\ 1/Documents/Claude/Projects/HackAss
node scripts/setup-database.js
```

## What Gets Created

### Tables
- **hacks** - Main table storing all hack submissions with voting data

### Columns
| Column | Type | Purpose |
|--------|------|---------|
| id | UUID | Primary key |
| title | VARCHAR(255) | Hack title |
| description | TEXT | One-sentence description |
| category | VARCHAR(50) | Category (Cooking, Cleaning, etc.) |
| difficulty | VARCHAR(20) | easy, medium, hard |
| why_it_works | TEXT | Scientific explanation |
| content_type | VARCHAR(20) | video, photo, link |
| content_url | TEXT | URL to content |
| worked_votes | INTEGER | How many people found it useful |
| failed_votes | INTEGER | How many people said it didn't work |
| unique_users_who_validated | INTEGER | Number of unique voters |
| status | VARCHAR(20) | pending, approved, rejected |
| created_at | TIMESTAMP | When hack was submitted |
| updated_at | TIMESTAMP | Last modification |

### Indexes
- `idx_hacks_status` - For filtering approved hacks
- `idx_hacks_category` - For category filtering
- `idx_hacks_created_at` - For sorting by date
- `idx_hacks_content_type` - For media type filtering
- `idx_hacks_source_platform` - For platform filtering

### Row Level Security (RLS)
- ✅ Public read: Anyone can read approved hacks
- ✅ Public insert: Anyone can submit new hacks (status=pending)
- ✅ Public update: Anyone can vote (update worked_votes/failed_votes)

## After Setup

### Test the Integration

1. **Browse Page**: http://localhost:3000/browse
   - Should show 15 sample hacks
   - Filtering by category should work
   - Sorting by Best/Trending/Newest should work

2. **Submit Form**: http://localhost:3000/submit
   - Should allow submitting new hacks
   - New hacks will have status='pending' (not visible in browse until approved)

3. **Voting System**: Click on any hack card
   - ValidationPrompt dialog should appear
   - Voting should update worked_votes/failed_votes

## Troubleshooting

### Table Already Exists Error
If you see "table hacks already exists", that's OK - the migrations check for existence with `IF NOT EXISTS`. Just proceed to seeding.

### Foreign Key Errors
The hacks table has no foreign keys - it's fully self-contained. If you see FK errors, they're from other tables.

### RLS Policy Errors
RLS policies are being updated with `DROP POLICY IF EXISTS`. If you see errors, they're likely duplicate policy names from previous runs - that's OK.

### Data Not Showing in Browse
1. Verify hacks table has rows: `SELECT COUNT(*) FROM hacks WHERE status='approved'`
2. Check browser console for API errors (Cmd+Option+I)
3. Verify .env has correct `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## What Happens Next

Once setup is complete:

1. **Browse Page** will load and display all approved hacks
2. **Filtering** will work by category
3. **Sorting** will work by Best/Trending/Newest
4. **Voting** will work and update vote counts in real-time
5. **Submit Form** will store new hacks with pending status

## Files Reference

- `migrations/002_create_hacks_table.sql` - Schema creation
- `migrations/003_seed_hacks_initial.sql` - 15 sample hacks
- `scripts/setup-database.js` - Automated setup script
- `.env` - Supabase credentials

---

**You're almost there!** The app is 100% ready functionally. These 5 minutes of setup will get the entire feed system working.
