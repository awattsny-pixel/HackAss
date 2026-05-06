# Backend Setup Guide

**Status**: Ready to implement  
**Stack**: Node.js + Express + TypeScript + PostgreSQL (Supabase) + Prisma ORM  
**Time to first working app**: ~30 minutes

---

## Prerequisites

- Node.js 18+ installed (`node --version`)
- Git installed (`git --version`)
- GitHub account + org created
- Supabase account + project created

---

## Step 1: Create GitHub Repository

### 1.1 Create the repo on GitHub

```bash
# Go to: https://github.com/awattsny-pixel/HackAss
# Click "New" → Create repository

Repository name: hack-aggregator-backend
Description: Backend API for Hack Aggregator platform
Visibility: Public
Initialize with: None (we'll add files locally)
```

### 1.2 Clone it locally

```bash
cd ~/projects  # or wherever you want to work
git clone https://github.com/awattsny-pixel/hack-aggregator-backend.git
cd hack-aggregator-backend
```

---

## Step 2: Initialize Node Project

### 2.1 Copy the files I created

From `/Users/AlanWatts 1/Documents/Claude/Projects/HackAss/`:
- Copy `backend-package.json` → `package.json`
- Copy `backend-tsconfig.json` → `tsconfig.json`
- Copy `backend-.env.example` → `.env`
- Copy `schema.prisma` → `prisma/schema.prisma`

### 2.2 Folder structure

```
hack-aggregator-backend/
├── src/
│   ├── index.ts              (Express app entry point)
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── hacks.ts
│   │   └── submissions.ts
│   ├── middleware/
│   │   ├── auth.ts
│   │   └── errorHandler.ts
│   ├── utils/
│   │   ├── jwt.ts
│   │   └── logger.ts
│   └── types/
│       └── index.ts
├── prisma/
│   └── schema.prisma         (Database schema)
├── package.json
├── tsconfig.json
├── .env                      (Local environment - DON'T commit)
├── .env.example              (Template - commit this)
├── .gitignore
└── README.md
```

### 2.3 Create `.gitignore`

```bash
cat > .gitignore << 'EOF'
node_modules/
dist/
.env
.env.local
.env.*.local
*.log
.DS_Store
EOF
```

---

## Step 3: Install Dependencies

```bash
npm install
npx prisma generate
```

---

## Step 4: Configure Supabase

### 4.1 Get your connection string

1. Go to your Supabase project dashboard
2. Settings → Database → Connection Pooling (or Direct Connection)
3. Select "Prisma" from the dropdown
4. Copy the connection string

### 4.2 Update .env

```bash
# Edit .env file
DATABASE_URL="postgresql://postgres:[PASSWORD]@[PROJECT_ID].supabase.co:5432/postgres?schema=public"

# Replace:
# [PASSWORD] = your Supabase database password
# [PROJECT_ID] = your project ID (visible in URL)
```

### 4.3 Test connection

```bash
npx prisma db push
# This creates all tables in your Supabase database
```

If successful:
```
✔ Database synced, creating migration history table

The following migration(s) have been applied:
  migrations/20260428120000_init/migration.sql
```

---

## Step 5: Start Development Server

```bash
npm run dev
```

You should see:
```
[nodemon] restarting due to changes...
Server running on http://localhost:3001
```

---

## Step 6: Test the Database

### 6.1 Create a test category

```bash
# Open http://localhost:3001/health (we'll add this route)
# Or use Prisma Studio:

npx prisma studio
# Opens http://localhost:5555
# Navigate to "Category" → Add a new category
```

### 6.2 Verify in Supabase

1. Go to Supabase dashboard
2. SQL Editor → New query
3. Run: `SELECT * FROM "Category";`
4. Should see your test category

---

## Project Structure Details

### `/src/index.ts` (Express App)

```typescript
import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';

const app = express();
const prisma = new PrismaClient();

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(','),
  credentials: true
}));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
```

### `/src/routes/hacks.ts` (Example Route)

```typescript
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// GET /api/hacks - List all hacks
router.get('/', async (req, res) => {
  try {
    const hacks = await prisma.hack.findMany({
      where: { status: 'published' },
      include: { category: true },
      take: 20,
      skip: 0,
      orderBy: { voteCount: 'desc' }
    });
    res.json(hacks);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch hacks' });
  }
});

// GET /api/hacks/:id - Get single hack
router.get('/:id', async (req, res) => {
  try {
    const hack = await prisma.hack.findUnique({
      where: { id: req.params.id },
      include: { category: true, votes: true }
    });
    if (!hack) return res.status(404).json({ error: 'Hack not found' });
    res.json(hack);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch hack' });
  }
});

export default router;
```

---

## Available Commands

```bash
# Development
npm run dev                # Start dev server with hot reload
npm run build              # Compile TypeScript to JavaScript
npm run start              # Run compiled JavaScript

# Database
npx prisma generate       # Generate Prisma client
npx prisma db push        # Create/update database tables
npx prisma migrate dev    # Create a new migration
npx prisma studio        # Open interactive database browser
npx prisma studio --help # See all options

# Code quality
npm run lint             # Run ESLint
npm run test            # Run tests with Vitest

# Deployment
npm run build && npm start  # Production build and start
```

---

## Prisma Tips

### Generate Client (After schema changes)
```bash
npx prisma generate
```

### Create a Migration
```bash
# After editing schema.prisma:
npx prisma migrate dev --name add_new_field
# Give it a descriptive name
```

### Seed Database (for testing)
Create `prisma/seed.ts`:

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Create categories
  const cooking = await prisma.category.create({
    data: {
      name: 'Cooking & Kitchen',
      slug: 'cooking-kitchen',
      description: 'Kitchen hacks and cooking tips'
    }
  });

  // Create sample hack
  await prisma.hack.create({
    data: {
      title: 'Boil water faster with salt',
      description: 'Adding salt to water increases its boiling point...',
      steps: [
        { number: 1, text: 'Add 1 tsp salt per liter of water' },
        { number: 2, text: 'Bring to boil' }
      ],
      whyItWorks: 'Salt increases water boiling point by 1°C per gram',
      categoryId: cooking.id,
      status: 'published'
    }
  });

  console.log('Seeding complete!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
```

Then run:
```bash
npx prisma db seed
```

---

## Debugging

### Check Database Directly

```bash
# Via Prisma Studio
npx prisma studio

# Or via SQL (in Supabase)
SELECT * FROM "Hack" LIMIT 10;
```

### Enable Debug Logging

```bash
# In .env
DEBUG=prisma:*
```

Then run:
```bash
npm run dev
```

### Common Issues

**Problem**: `DATABASE_URL is not set`
- **Solution**: Check `.env` file, add `DATABASE_URL` with Supabase connection string

**Problem**: `Can't reach database server`
- **Solution**: 
  1. Verify Supabase project is running
  2. Check connection string is correct
  3. Ensure your IP is whitelisted (Supabase auto-allows)

**Problem**: `Prisma client not generated`
- **Solution**: Run `npx prisma generate`

---

## Next Steps (Week 2)

Once dev environment is working:

1. **Build Auth Routes** (`/api/auth/register`, `/api/auth/login`)
2. **Build Hack Routes** (CRUD operations on hacks)
3. **Build Voting Routes** (`/api/hacks/:id/vote`)
4. **Add Middleware** (JWT authentication, error handling)
5. **Connect to Frontend** (CORS, API integration)

---

## Resources

- [Prisma Docs](https://www.prisma.io/docs/)
- [Express.js Guide](https://expressjs.com/)
- [Supabase Docs](https://supabase.com/docs)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

---

**Ready to set up?** Follow steps 1-6 above, then we'll sync Thursday to review progress.

If you hit any issues, share the error message and I'll debug it.
