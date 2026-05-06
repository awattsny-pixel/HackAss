# Authentication Setup Guide - Week 1 Day 1

This guide walks you through setting up Supabase authentication for HackAgg in ~1 hour.

## Step 1: Create Supabase Project (10 minutes)

1. Go to [supabase.com](https://supabase.com)
2. Sign up or log in
3. Click **New Project**
4. Enter project name: `hackass`
5. Create a strong database password (save it!)
6. Select region closest to you
7. Click **Create new project**
8. Wait for initialization (~2-3 min)

## Step 2: Enable Email Authentication (5 minutes)

1. In Supabase dashboard, go to **Authentication** → **Providers**
2. Find **Email** provider
3. Click it and enable **Email Confirmed** 
4. Toggle "Confirm email" ON
5. Save settings

## Step 3: Create Users Table (10 minutes)

1. Go to **SQL Editor** in Supabase
2. Click **New Query**
3. Copy and paste this SQL:

```sql
-- Create users table
CREATE TABLE users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  avatar TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Allow users to read their own profile
CREATE POLICY "Users can read own profile"
  ON users
  FOR SELECT
  USING (auth.uid() = id);

-- Allow users to update their own profile
CREATE POLICY "Users can update own profile"
  ON users
  FOR UPDATE
  USING (auth.uid() = id);
```

4. Click **Run**
5. You should see "Success. No rows returned."

## Step 4: Get Supabase Credentials (5 minutes)

1. Go to **Settings** → **API**
2. Copy your **Project URL** (looks like: `https://xxxxx.supabase.co`)
3. Copy your **Anon Key** (looks like a long string)
4. Save both - you'll need them in the next step

## Step 5: Configure Environment Variables (5 minutes)

1. In your frontend folder, create `.env.local` file:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY
```

2. Replace the values with your actual Supabase credentials

## Step 6: Install Dependencies (10 minutes)

```bash
cd frontend
npm install
```

This will install `@supabase/supabase-js` and update your dependencies.

## Step 7: Test Auth Flow (15 minutes)

1. Start the dev server:

```bash
npm run dev
```

2. Open [http://localhost:3000/signup](http://localhost:3000/signup)

3. Create a test account:
   - Email: `test@example.com`
   - Username: `testuser`
   - Password: `Test123!`
   - Confirm: `Test123!`

4. You should see a success message and redirect to home

5. Try logging out from the home page (if you add a logout button)

6. Sign in with your test credentials at [http://localhost:3000/login](http://localhost:3000/login)

## Step 8: Verify in Supabase

1. Go back to Supabase dashboard
2. Click **Auth** → **Users**
3. You should see your test user in the list
4. Click **SQL Editor** → run this:

```sql
SELECT * FROM users;
```

5. You should see your test user's profile

## Troubleshooting

### "Cannot find module '@supabase/supabase-js'"
```bash
npm install @supabase/supabase-js --save
npm run dev
```

### "Missing environment variables"
- Make sure `.env.local` exists in the `frontend/` folder
- Restart dev server after creating `.env.local`
- Variables must start with `NEXT_PUBLIC_` to be accessible in browser

### "Invalid login / User not found"
- Check that you created a test account first at `/signup`
- Verify your `.env.local` has the correct Supabase URL and key

### "Confirmation email not arriving"
- For development, Supabase doesn't require email confirmation
- The account is usable immediately even if email isn't confirmed

## What's Next

Once authentication is working:

1. **Day 2**: Build hack submission form
2. **Day 3**: Create moderation queue
3. **Days 4-7**: Testing and polish

## Files Created

- ✅ `app/lib/supabase.ts` — Supabase client config
- ✅ `app/lib/auth-context.tsx` — Auth provider and hooks
- ✅ `app/lib/protected-route.tsx` — Protected route wrapper
- ✅ `app/components/SignUpPage.tsx` — Sign up UI
- ✅ `app/components/LoginPage.tsx` — Login UI
- ✅ `app/signup/page.tsx` — Sign up route
- ✅ `app/login/page.tsx` — Login route
- ✅ `app/layout.tsx` — Updated with AuthProvider
- ✅ `.env.local.example` — Environment template

## Reference

- Supabase Docs: https://supabase.com/docs
- Next.js Auth: https://nextjs.org/docs/authentication
- React Context: https://react.dev/reference/react/useContext
