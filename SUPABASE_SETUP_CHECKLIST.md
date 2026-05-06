# Supabase Setup Checklist

**Goal**: Get PostgreSQL database ready with connection string for backend repo  
**Time**: ~10 minutes  
**Status**: Ready to begin  

---

## Step 1: Create Supabase Project (if not done)

- [ ] Go to [supabase.com](https://supabase.com)
- [ ] Sign in or create account (free tier is fine)
- [ ] Click "New Project"
- [ ] **Project name**: `hack-aggregator` (or similar)
- [ ] **Database password**: Create a strong password (you'll need this)
- [ ] **Region**: Choose closest to you (e.g., `us-east-1`)
- [ ] Click "Create new project"
- [ ] Wait 2-3 minutes for database to initialize (you'll see a loading spinner)

---

## Step 2: Get Database Connection String

### 2.1 Navigate to Connection String

- [ ] Once project is created, go to **Settings** (bottom left gear icon)
- [ ] Click **Database** in the left sidebar
- [ ] You'll see "Connection pooling" section

### 2.2 Copy Prisma Connection String

- [ ] Look for the dropdown that says "Connection string"
- [ ] **If you don't see it**, click the dropdown next to "Postgres" and select "Prisma"
- [ ] You should see a pre-filled URL like:
  ```
  postgresql://postgres.xyzabc:[PASSWORD]@aws-0-us-east-1.pooling.supabase.co:6543/postgres
  ```
- [ ] **Copy this entire URL** (the copy button is on the right)

### 2.3 Replace Placeholder Password

The URL has `[PASSWORD]` as a placeholder. You need to replace it:

- [ ] If the URL shows `[PASSWORD]`, replace it with the password you created in Step 1
- [ ] Example: If password is `MySecurePass123`, the URL becomes:
  ```
  postgresql://postgres.xyzabc:MySecurePass123@aws-0-us-east-1.pooling.supabase.co:6543/postgres
  ```

**Important**: The connection string is sensitive. Don't commit it to GitHub.

---

## Step 3: Test Connection (Optional)

You can verify the connection works before sharing it:

### 3.1 Via Supabase Console

- [ ] In Supabase dashboard, click **SQL Editor** (left sidebar)
- [ ] Click **New Query**
- [ ] Paste this and click Run:
  ```sql
  SELECT version();
  ```
- [ ] If you see a PostgreSQL version, the connection works ✅

---

## Step 4: Share Connection String

Once you have the connection string:

- [ ] **Option A (Secure)**: Share via Slack DM or encrypted message
- [ ] **Option B**: Share in this chat (I'll use it only for GitHub repo setup, then delete)

Format when sharing:
```
postgresql://postgres.xyzabc:MySecurePass123@aws-0-us-east-1.pooling.supabase.co:6543/postgres
```

---

## What Happens Next

Once you share the connection string, I will:

1. **Create GitHub backend repo** (`hack-aggregator-backend`)
2. **Push all files** (schema, setup guide, config)
3. **Create `.env` file** with your connection string
4. **Run `npx prisma db push`** to create all tables in your database
5. **Give you the repo URL** ready to clone

You'll then be able to:
```bash
git clone https://github.com/awattsny-pixel/hack-aggregator-backend.git
cd hack-aggregator-backend
npm install
npm run dev  # Server starts on localhost:3001
```

---

## Troubleshooting

### Connection String is Long/Different Than Expected

✅ That's normal. Supabase uses connection pooling by default, which has a different host than the direct connection.

### Can't Find "Connection String" Dropdown

- [ ] Make sure you're in **Settings → Database**
- [ ] Look for text that says "Connection string" or "Prisma"
- [ ] If you see "Connection Pooling", that's the right section

### Password Keeps Showing as [PASSWORD]

- [ ] The URL template shows `[PASSWORD]` as placeholder text
- [ ] You MUST replace it with actual password from Step 1
- [ ] Copy the URL and manually replace `[PASSWORD]` before sharing

### "Can't connect to database" After Setup

- [ ] Wait 5 minutes - Supabase sometimes takes time to fully activate
- [ ] Check your password is correct (case-sensitive)
- [ ] Verify your IP isn't blocked (Supabase usually allows all IPs)

---

## Security Notes

- **Never commit `.env` to GitHub** - `.gitignore` prevents this
- **Never share connection string publicly** - share only in DMs or encrypted
- **Never hardcode in code** - always use `.env` variables
- **Rotate password after MVP** - good practice before public launch

---

## Files You'll Have Ready

After this completes, you'll have in `/Users/AlanWatts 1/Documents/Claude/Projects/HackAss/`:

✅ `schema.prisma` - Database schema (8 tables)  
✅ `SCHEMA_DESIGN_DECISIONS.md` - Design explanations  
✅ `BACKEND_SETUP_GUIDE.md` - Step-by-step implementation  
✅ `API_SPECIFICATION.md` - All endpoints documented  
✅ `backend-package.json` - Node dependencies  
✅ `backend-tsconfig.json` - TypeScript config  
✅ `backend-.env.example` - Environment template  

Plus GitHub will have:
🚀 `hack-aggregator-backend` repo - Ready to clone

---

## Timeline

- **Today (Wed 4/29)**: You set up Supabase → Share connection string
- **Today (Wed 4/29)**: I create GitHub repo with all files + database tables
- **Thursday (Thu 4/30)**: Design review checkpoint (backend + frontend)
- **Friday (Fri 5/2)**: Sprint 1 complete (schema ✅, API spec ✅, wireframes ✅)
- **Monday (Mon 5/5)**: Week 2 begins - Start actual development

---

**Ready?** Start with Step 1 above. Once you have the connection string, just share it and I'll get the repo ready.

If you hit any issues or questions:
- Check Troubleshooting section above
- Share the error message and I'll debug it

No pressure on timeline - take your time to get it right. 👍
