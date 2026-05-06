# Week 1 Execution Guide - Authentication & Submissions

**Timeline:** 5 business days (Tuesday-Friday this week + Monday next week)
**Status:** Ready to launch

## Quick Reference

All files have been created. You now have:
- ✅ Complete authentication system (sign up, login, protected routes)
- ✅ Hack submission form (with validation)
- ✅ Environment configuration
- ✅ Step-by-step setup guide

**Next Action:** Follow Day 1 below to get authentication running.

---

## Day 1 (Tuesday): Supabase Setup & Authentication Testing

### Morning (30 minutes)

**Task: Set up Supabase project**

1. Open `AUTH_SETUP.md` (in your frontend folder)
2. Follow **Step 1-4** to create Supabase project and enable authentication
3. Create the users table using the provided SQL script
4. Copy your Supabase URL and Anon Key

### Afternoon (30 minutes)

**Task: Configure environment variables & install dependencies**

1. Create `.env.local` file in `frontend/` folder:
```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_URL.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_KEY
```

2. Install dependencies:
```bash
cd frontend
npm install
```

3. Start dev server:
```bash
npm run dev
```

4. You should see:
```
  ▲ Next.js 16.2.4
  - Local:        http://localhost:3000
```

### Evening (Testing)

**Test the complete auth flow:**

1. Open http://localhost:3000/signup
2. Create a test account:
   - Email: `test@example.com`
   - Username: `testuser`
   - Password: `Test123!`
   - Confirm: `Test123!`
3. Click "Create Account"
4. You should be redirected to home page
5. Go to http://localhost:3000/login
6. Sign in with test credentials
7. You should see "Loading..." then be redirected

### Day 1 Verification

✓ Supabase project created  
✓ `.env.local` configured  
✓ `npm install` completed  
✓ Dev server running on port 3000  
✓ Can sign up at /signup  
✓ Can log in at /login  
✓ User appears in Supabase dashboard

---

## Day 2 (Wednesday): Hack Submission Form & API Integration

### Morning (1 hour)

**Task: Test hack submission form**

1. Ensure dev server is running (`npm run dev`)
2. Sign in at http://localhost:3000/login
3. Navigate to http://localhost:3000/submit
4. You should see the hack submission form
5. Fill it out:
   - Title: "Clean oven with baking soda"
   - Description: "A natural, non-toxic way..."
   - Category: "Cleaning"
   - Difficulty: "Easy"
   - Steps: Add 3-4 steps
   - Why: "Baking soda is abrasive..."
6. Click "Submit Hack"
7. You should see a success message (or error if API isn't configured)

### Afternoon (1.5 hours)

**Task: Create API endpoint in backend** (if you have backend setup)

If you have a Node.js/Express backend running on port 3001, create this endpoint:

```typescript
// POST /api/hacks
router.post('/hacks', async (req, res) => {
  try {
    const { title, description, category, difficulty, steps, whyItWorks, userId } = req.body;
    
    const { data, error } = await supabase
      .from('hacks')
      .insert([
        {
          title,
          description,
          category,
          difficulty,
          steps,
          why_it_works: whyItWorks,
          user_id: userId,
          status: 'pending', // Awaiting moderation
          created_at: new Date(),
        }
      ])
      .select();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create hack' });
  }
});
```

### Day 2 Verification

✓ Submission form loads at /submit (requires login)  
✓ Form validation works (try submitting empty fields)  
✓ Form accepts valid data  
✓ Submit button disabled during submission  
✓ Success/error messages display correctly

---

## Day 3 (Thursday): Moderation Queue & Admin Dashboard

### Morning (2 hours)

**Task: Create admin moderation page**

Create `app/components/ModeratorQueue.tsx`:

```typescript
// Shows pending submissions for admin
// Features:
// - List of pending hacks
// - Approve button (moves to published)
// - Reject button (with reason)
// - View statistics (total pending, approved, rejected)
```

### Afternoon (1 hour)

**Task: Create hacks table in Supabase**

Run this SQL in Supabase:

```sql
CREATE TABLE hacks (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  difficulty TEXT CHECK (difficulty IN ('easy', 'medium', 'hard')),
  steps JSONB DEFAULT '[]'::jsonb,
  why_it_works TEXT,
  image_url TEXT,
  votes INT DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE hacks ENABLE ROW LEVEL SECURITY;

-- Anyone can read approved hacks
CREATE POLICY "Anyone can read approved hacks"
  ON hacks
  FOR SELECT
  USING (status = 'approved');

-- Users can only insert their own hacks
CREATE POLICY "Users can create own hacks"
  ON hacks
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);
```

### Day 3 Verification

✓ `hacks` table created in Supabase  
✓ Admin page shows pending submissions  
✓ Can approve/reject hacks  
✓ Status changes reflected in database

---

## Day 4 (Friday): Testing & Error Handling

### Full Day: End-to-End Testing

**Sign-up flow:**
- [ ] Successful account creation
- [ ] Email validation
- [ ] Password validation (min 6 chars)
- [ ] Username validation (min 3 chars)
- [ ] Duplicate email rejection
- [ ] Success message & redirect

**Login flow:**
- [ ] Successful sign in
- [ ] Wrong password error
- [ ] Non-existent user error
- [ ] Session persistence (reload page, stays logged in)
- [ ] Logout works

**Submission flow:**
- [ ] Submission form requires login
- [ ] Form validation works
- [ ] Can add/remove steps
- [ ] Character limits respected
- [ ] Success message displays
- [ ] Hack appears in moderation queue

**Moderation flow:**
- [ ] Can view pending hacks
- [ ] Can approve hack
- [ ] Can reject hack
- [ ] Approved hacks appear in feed
- [ ] Rejected hacks hidden

### Fixes & Polish

- [ ] Error messages are clear
- [ ] Loading states show spinner
- [ ] Forms have proper spacing
- [ ] Mobile responsive (test on phone)
- [ ] Dark theme consistent

---

## Day 5 (Monday): Optional Polish & Prep for Week 2

### Optional Enhancements

If you have time, add:

1. **User Profile Page**
   - Shows user's submitted hacks
   - Shows user's votes/bookmarks
   - Profile photo
   - Bio/description

2. **Password Reset**
   - Forgot password link on login
   - Email reset token
   - New password form

3. **Email Verification**
   - Send confirmation email on signup
   - Resend email link
   - Verify email before creating account

### Prep for Week 2

By end of Week 1, you should have:
- ✅ Authentication system fully working
- ✅ Hack submission form
- ✅ Moderation queue
- ✅ Database schema complete

**Week 2 focus:**
- Hack voting system
- Comments system
- Admin statistics dashboard
- Hack browsing/filtering

---

## File Structure - Week 1 Deliverables

```
frontend/
├── app/
│   ├── lib/
│   │   ├── supabase.ts              # Supabase client config
│   │   ├── auth-context.tsx         # Auth provider & hooks
│   │   └── protected-route.tsx       # Route protection wrapper
│   ├── components/
│   │   ├── SignUpPage.tsx           # Sign up UI
│   │   ├── LoginPage.tsx            # Login UI
│   │   └── SubmitHackForm.tsx       # Hack submission form
│   ├── signup/
│   │   └── page.tsx                 # /signup route
│   ├── login/
│   │   └── page.tsx                 # /login route
│   ├── submit/
│   │   └── page.tsx                 # /submit route
│   ├── layout.tsx                   # Updated with AuthProvider
│   └── page.tsx                     # Home page (shows HackFeedPage)
├── .env.local                       # Environment variables (created by you)
├── .env.local.example               # Environment template
├── AUTH_SETUP.md                    # This file
├── package.json                     # Updated with @supabase/supabase-js
└── WEEK_1_EXECUTION.md             # You're reading this
```

---

## Common Issues & Fixes

### Issue: "Cannot find module '@supabase/supabase-js'"

**Solution:**
```bash
npm install @supabase/supabase-js@latest
npm run dev
```

### Issue: "Missing environment variables"

**Solution:**
- Check `.env.local` exists in `frontend/` folder
- Check variables have correct format
- Restart dev server after creating `.env.local`

### Issue: "Auth state not persisting"

**Solution:**
- Browser may be blocking localStorage
- Check that AuthProvider is in root layout
- Clear browser cookies/cache

### Issue: "User can't submit hack"

**Solution:**
- User must be logged in (redirects to login if not)
- All form fields must be filled
- Backend API might not be running (if using external API)

---

## Success Criteria - Week 1

By end of Friday, you should be able to:

1. ✅ Sign up a new account at `/signup`
2. ✅ See user appear in Supabase dashboard
3. ✅ Log in at `/login` with credentials
4. ✅ Navigate to `/submit` and see hack form
5. ✅ Submit a hack with full details
6. ✅ See hack in moderation queue
7. ✅ Approve/reject hack
8. ✅ See approved hacks in main feed
9. ✅ Log out and log back in (session persists)
10. ✅ Mobile-responsive on phone

---

## Next Week (Week 2)

Once Week 1 is complete, focus on:

1. **Voting System**
   - Upvote/downvote hacks
   - Vote persistence
   - Vote count in feed

2. **Comments**
   - Comment form
   - Comments list
   - Nested replies

3. **Admin Dashboard**
   - Total hacks count
   - Pending/approved/rejected stats
   - User activity

4. **SEO & Performance**
   - Meta tags
   - OG images
   - Page speed optimization

---

## Questions?

Refer to:
- `AUTH_SETUP.md` - Detailed Supabase setup
- `COMPONENTS.md` - React component docs
- `QUICKSTART.md` - Quick reference
- Supabase Docs: https://supabase.com/docs
- Next.js Docs: https://nextjs.org/docs

---

**Ready?** Open `AUTH_SETUP.md` and start with Day 1!
