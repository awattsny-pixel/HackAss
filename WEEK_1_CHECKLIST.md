# Week 1 Checklist - Track Your Progress

## Day 1 (Tuesday) - Supabase & Environment Setup

### Morning Setup (1 hour)

- [ ] **Supabase Project Creation** (15 min)
  - [ ] Go to https://supabase.com
  - [ ] Create new project "hackass"
  - [ ] Choose region
  - [ ] Save database password somewhere safe
  - [ ] Wait for initialization

- [ ] **Enable Email Authentication** (5 min)
  - [ ] Go to Authentication → Providers
  - [ ] Enable Email provider
  - [ ] Save settings

- [ ] **Create Users Table** (10 min)
  - [ ] Go to SQL Editor
  - [ ] Copy SQL from AUTH_SETUP.md Step 3
  - [ ] Run the script
  - [ ] See "Success. No rows returned."

- [ ] **Get Credentials** (5 min)
  - [ ] Go to Settings → API
  - [ ] Copy Project URL
  - [ ] Copy Anon Key
  - [ ] Save both temporarily

### Afternoon Configuration (30 minutes)

- [ ] **Create .env.local**
  - [ ] Create file: `frontend/.env.local`
  - [ ] Add `NEXT_PUBLIC_SUPABASE_URL=...`
  - [ ] Add `NEXT_PUBLIC_SUPABASE_ANON_KEY=...`
  - [ ] Save file

- [ ] **Install Dependencies**
  ```bash
  cd frontend
  npm install
  ```
  - [ ] See "added X packages"
  - [ ] No error messages

- [ ] **Start Dev Server**
  ```bash
  npm run dev
  ```
  - [ ] See "✓ Ready in X.Xs"
  - [ ] See "Local: http://localhost:3000"

### Evening Testing (15 minutes)

- [ ] **Test Sign Up Flow**
  - [ ] Open http://localhost:3000/signup
  - [ ] Enter: test@example.com
  - [ ] Enter: testuser
  - [ ] Enter: Test123!
  - [ ] Enter: Test123! (confirm)
  - [ ] Click "Create Account"
  - [ ] See success message
  - [ ] Redirected to home page

- [ ] **Verify in Supabase**
  - [ ] Go to Supabase Dashboard
  - [ ] Go to Auth → Users
  - [ ] See test@example.com in list
  - [ ] Go to SQL Editor
  - [ ] Run: `SELECT * FROM users;`
  - [ ] See testuser in results

### Day 1 Status: ___/12 ✓

---

## Day 2 (Wednesday) - Hack Submission Form & Testing

### Morning: Test Submission Form (1 hour)

- [ ] **Access Submission Form**
  - [ ] Ensure dev server running: `npm run dev`
  - [ ] Open http://localhost:3000/login
  - [ ] Sign in with test@example.com / Test123!
  - [ ] Navigate to http://localhost:3000/submit
  - [ ] See "Share Your Hack" page

- [ ] **Test Form Validation**
  - [ ] Try submitting empty form
  - [ ] See error: "Title is required"
  - [ ] Enter title: "Clean oven with baking soda"
  - [ ] Try submitting with empty description
  - [ ] See error: "Description is required"

- [ ] **Fill Out Complete Form**
  - [ ] Title: "Clean oven with baking soda"
  - [ ] Description: "Use baking soda and vinegar for non-toxic oven cleaning"
  - [ ] Category: "Cleaning"
  - [ ] Difficulty: "Easy"
  - [ ] Add 3 steps:
    - [ ] Step 1: "Sprinkle baking soda all over oven interior"
    - [ ] Step 2: "Spray vinegar to create paste"
    - [ ] Step 3: "Let sit 12 hours, then wipe clean"
  - [ ] Why It Works: "Baking soda is mildly abrasive and slightly alkaline, vinegar is acidic..."

- [ ] **Test Form Features**
  - [ ] Check character counts update in real time
  - [ ] Add a new step with "Add Step" button
  - [ ] Remove a step with trash icon
  - [ ] Select different difficulty levels
  - [ ] Change category dropdown

- [ ] **Submit Form**
  - [ ] Click "Submit Hack"
  - [ ] See loading state (button disabled)
  - [ ] See success message (or error if API not configured)

### Afternoon: Backend API Setup (Optional - 1.5 hours)

If you have Node.js backend running on port 3001:

- [ ] **Create Hacks Table in Supabase**
  ```sql
  -- Copy from WEEK_1_EXECUTION.md Day 3
  ```
  - [ ] Run SQL script
  - [ ] See table created in Supabase
  - [ ] Verify RLS policies

- [ ] **Create POST /api/hacks Endpoint** (Backend)
  - [ ] Accept: title, description, category, difficulty, steps, whyItWorks, userId
  - [ ] Insert into `hacks` table with status='pending'
  - [ ] Return created hack object
  - [ ] Handle errors gracefully

- [ ] **Update Frontend API Call** (Frontend)
  - [ ] Update `SubmitHackForm.tsx` fetch to use correct endpoint
  - [ ] Test form submission again
  - [ ] Check hack appears in Supabase `hacks` table

### Day 2 Status: ___/14 ✓

---

## Day 3 (Thursday) - Moderation & Admin Features

### Morning: Create Moderation Queue (2 hours)

- [ ] **Create Moderator Dashboard Component**
  - [ ] File: `app/components/ModeratorQueue.tsx`
  - [ ] Show list of pending hacks
  - [ ] Display: title, author, category, submitted date
  - [ ] Show hack details on click

- [ ] **Add Approve/Reject Buttons**
  - [ ] Approve button changes status to 'approved'
  - [ ] Reject button (with optional reason)
  - [ ] Update database when button clicked
  - [ ] Remove from pending list

- [ ] **Display Statistics**
  - [ ] Total pending count
  - [ ] Total approved count
  - [ ] Total rejected count

- [ ] **Create Route**
  - [ ] Create: `app/moderator/page.tsx`
  - [ ] Protect route (admin only)
  - [ ] Test at http://localhost:3000/moderator

### Afternoon: Verify Database & Flows (1.5 hours)

- [ ] **Test Moderation Workflow**
  - [ ] Submit a hack at /submit
  - [ ] Go to /moderator
  - [ ] See submitted hack in pending queue
  - [ ] Click approve
  - [ ] Check Supabase: hack now has status='approved'
  - [ ] Try to reject another hack
  - [ ] Check it's removed from queue

- [ ] **Verify Data Integrity**
  - [ ] Each hack has correct fields
  - [ ] User ID correctly linked
  - [ ] Timestamps accurate
  - [ ] Categories saved correctly

- [ ] **Test Permissions**
  - [ ] Log out and try /moderator
  - [ ] Should redirect to login
  - [ ] Only admin should see moderation page

### Day 3 Status: ___/15 ✓

---

## Day 4 (Friday) - Full Testing & Error Handling

### Test All Flows (Full Day)

#### Sign Up Flow Tests

- [ ] **Valid Sign Up**
  - [ ] New email, strong password
  - [ ] Success message appears
  - [ ] Redirected to home
  - [ ] User in Supabase auth

- [ ] **Form Validation**
  - [ ] Empty email → error
  - [ ] Invalid email → error
  - [ ] Password < 6 chars → error
  - [ ] Passwords don't match → error
  - [ ] Username < 3 chars → error

- [ ] **Duplicate Prevention**
  - [ ] Try signing up with same email twice
  - [ ] See "User already exists" error
  - [ ] Can't create duplicate account

- [ ] **Data Storage**
  - [ ] Go to Supabase Auth → Users
  - [ ] New user appears
  - [ ] Go to SQL: `SELECT * FROM users`
  - [ ] User profile created with correct fields

#### Login Flow Tests

- [ ] **Valid Login**
  - [ ] Enter correct email & password
  - [ ] Successful redirect
  - [ ] Session persists (reload page)
  - [ ] Still logged in after refresh

- [ ] **Error Handling**
  - [ ] Wrong password → "Invalid credentials"
  - [ ] Non-existent user → "User not found"
  - [ ] Empty fields → "Both fields required"

- [ ] **Session Persistence**
  - [ ] Log in
  - [ ] Close browser tab
  - [ ] Reopen localhost:3000
  - [ ] Still logged in

- [ ] **Logout**
  - [ ] Click logout (add button if needed)
  - [ ] Redirected to login
  - [ ] Try accessing protected route
  - [ ] Redirected to login again

#### Submission Flow Tests

- [ ] **Form Validation**
  - [ ] Empty title → error
  - [ ] Empty description → error
  - [ ] Empty step → error
  - [ ] Missing "Why It Works" → error

- [ ] **Dynamic Steps**
  - [ ] Can add steps with "+ Add Step"
  - [ ] Can remove steps with trash icon
  - [ ] Step numbers update correctly
  - [ ] At least 1 step required

- [ ] **Character Limits**
  - [ ] Title: 100 character limit
  - [ ] Description: 300 character limit
  - [ ] Why: 500 character limit
  - [ ] Counters show X/100, X/300, X/500

- [ ] **Submission Success**
  - [ ] Click submit with valid data
  - [ ] Loading state shows
  - [ ] Success message appears
  - [ ] Form resets
  - [ ] Hack in Supabase (status='pending')

#### Moderation Flow Tests

- [ ] **View Queue**
  - [ ] Pending hacks show in list
  - [ ] Correct hack details displayed
  - [ ] Can see submitted date

- [ ] **Approve Hack**
  - [ ] Click approve button
  - [ ] Hack status changes to 'approved'
  - [ ] Removed from pending queue
  - [ ] Can view in feed

- [ ] **Reject Hack**
  - [ ] Click reject button
  - [ ] Hack status changes to 'rejected'
  - [ ] Removed from pending queue
  - [ ] Hidden from feed

#### UI/UX Tests

- [ ] **Mobile Responsive** (test on phone or DevTools)
  - [ ] Sign up form readable
  - [ ] Login form readable
  - [ ] Submit form usable
  - [ ] Buttons are tap-friendly (48px+)

- [ ] **Dark Theme**
  - [ ] Consistent dark background
  - [ ] Text readable on dark backgrounds
  - [ ] Accent colors (blue/green) visible
  - [ ] No glaring white sections

- [ ] **Error Messages**
  - [ ] Clear and helpful
  - [ ] Red/warning color
  - [ ] Disappear when issue fixed
  - [ ] Proper grammar

- [ ] **Loading States**
  - [ ] Buttons show "Loading..."
  - [ ] Spinner displays on pages
  - [ ] Can't double-submit

- [ ] **Links & Navigation**
  - [ ] "Sign In" link on signup page works
  - [ ] "Create Account" link on login works
  - [ ] Back buttons work (if added)
  - [ ] Logo links to home

### Day 4 Status: ___/42 ✓

---

## Day 5 (Monday) - Polish & Week 2 Prep

### Final Polish

- [ ] **Code Review**
  - [ ] No console errors
  - [ ] No console warnings
  - [ ] Clean TypeScript types
  - [ ] No unused imports

- [ ] **Performance Check**
  - [ ] Page loads in < 2 seconds
  - [ ] No layout shifts (CLS)
  - [ ] Smooth animations
  - [ ] Forms respond immediately

- [ ] **Documentation**
  - [ ] README.md updated
  - [ ] AUTH_SETUP.md complete
  - [ ] Code comments where needed
  - [ ] .env.local.example provided

- [ ] **Git Commit** (if using Git)
  - [ ] Stage all changes
  - [ ] Commit with message: "Week 1: Auth & Submissions MVP"
  - [ ] No uncommitted changes

### Week 2 Preparation

- [ ] **Plan Voting System**
  - [ ] Upvote/downvote buttons
  - [ ] Vote count persistence
  - [ ] Prevent double-voting

- [ ] **Plan Comments Feature**
  - [ ] Comment form
  - [ ] Comments list
  - [ ] Nested replies (optional)

- [ ] **Plan Admin Dashboard**
  - [ ] Statistics cards
  - [ ] Charts/graphs
  - [ ] User management

### Day 5 Status: ___/13 ✓

---

## Weekly Summary

### Completed

- ✅ Supabase project created
- ✅ Authentication system built
- ✅ Hack submission form functional
- ✅ Database schema created
- ✅ Moderation queue working
- ✅ All routes and pages created
- ✅ Form validation complete
- ✅ Error handling implemented
- ✅ Mobile responsive design
- ✅ Full testing completed

### User Accounts Created

- [ ] Test account 1: test@example.com
- [ ] Test account 2: (optional)
- [ ] Admin account: (if applicable)

### Data Created

- [ ] Hacks submitted: ___
- [ ] Hacks approved: ___
- [ ] Hacks rejected: ___

### Issues Encountered & Resolved

1. Issue: ___________________  
   Solution: ___________________

2. Issue: ___________________  
   Solution: ___________________

---

## Ready for Week 2? ✓

If all checkboxes are complete, you're ready to start Week 2:
- [ ] Core auth system stable
- [ ] Database schema proven
- [ ] All CRUD operations working
- [ ] Error handling in place
- [ ] Mobile responsive

**Week 2 Focus:**
1. Voting system
2. Comments system
3. Admin dashboard with stats
4. Feed improvements

---

## Notes & Learnings

(Use this section to track what you learned)

```
Day 1 learnings:


Day 2 learnings:


Day 3 learnings:


Day 4 learnings:


Day 5 learnings:


Overall reflections:

```

---

**Start Date:** Tuesday, May 1, 2026  
**Target End Date:** Friday, May 5, 2026  
**Status:** Ready to launch! 🚀
