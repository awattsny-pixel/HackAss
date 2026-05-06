# Database Schema Design Decisions

**Created**: April 28, 2026  
**Status**: Draft (ready for review Thursday)  
**Technology**: PostgreSQL (Supabase) + Prisma ORM

---

## Overview

This schema supports the Hack Aggregator MVP with focus on:
- ✓ User-generated hack content (crowdsourced)
- ✓ Voting/curation system (upvote/downvote)
- ✓ Moderation (admin approval + spam filtering)
- ✓ Attribution (proper source crediting)
- ✓ Performance (indexes on common queries)
- ✓ Scalability (simple, normalized design)

**Total Tables**: 8  
**Key Entities**: User, Hack, Category, Vote, Submission, SpamFilter, FlagReport

---

## Table-by-Table Design

### 1. USER (Authentication)

```prisma
model User {
  id           String   @id @default(cuid())
  email        String   @unique
  username     String   @unique
  passwordHash String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

**Why these fields**:
- `id`: Unique identifier (using CUID for distributed systems)
- `email`: For login + password reset
- `username`: For public profile URL (e.g., /user/alan)
- `passwordHash`: Hashed password (never store plaintext)
- `createdAt/updatedAt`: Audit trail

**Indexes**:
- `email` (UNIQUE + indexed) — Fast login lookup
- `username` (UNIQUE + indexed) — Fast profile lookup

**Decisions**:
- ❌ No "name" field (use username instead, simpler)
- ❌ No "reputation_score" field yet (can add in Month 2)
- ✓ Use CUID instead of UUID (smaller, sortable by time)

---

### 2. CATEGORY (Hack Classification)

```prisma
model Category {
  id          String   @id @default(cuid())
  name        String   @unique
  slug        String   @unique
  description String?
  createdAt   DateTime @default(now())
}
```

**Why these fields**:
- `name`: Display name (e.g., "Cooking & Kitchen")
- `slug`: URL-friendly identifier (e.g., "cooking-kitchen")
- `description`: What this category is about

**Indexes**:
- `slug` (UNIQUE + indexed) — Fast category lookup by URL

**Decisions**:
- ✓ Start with predefined categories (not user-created)
- ✓ Simple flat structure (no subcategories, can add later)
- ❌ No icon/color fields (can add to Figma design, store in frontend)

**Initial Categories**:
```
1. Cooking & Kitchen
2. Cleaning & Organization
3. Money-Saving
4. Travel
5. Productivity & Work
6. Home Organization
7. Laundry & Clothing
8. Tech & Gadgets
9. Beauty & Personal Care
10. Fitness & Health
```

---

### 3. HACK (Core Content)

```prisma
model Hack {
  id                String   @id @default(cuid())
  title             String
  description       String
  steps             Json     // [{ number: 1, text: "..." }, ...]
  whyItWorks        String
  imageUrl          String?
  
  sourceUrl         String?
  sourceType        String?  // "reddit" | "blog" | "youtube" | "user"
  attributionText   String?
  licenseType       String?  // "cc-by-3.0" | "cc-by-4.0" | "copyright"
  
  categoryId        String
  createdById       String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  
  voteCount         Int      @default(0)
  viewCount         Int      @default(0)
  status            String   @default("published")
  hackFingerprint   String?
}
```

**Why these fields**:

**Content Fields**:
- `title`: Display title (benefit-focused, e.g., "Remove stains in 30 seconds")
- `description`: Full hack explanation
- `steps`: JSON array (flexible, no schema needed)
- `whyItWorks`: Explanation of mechanism
- `imageUrl`: Hero image for hack (Cloudinary or similar)

**Attribution Fields** (critical for legal compliance):
- `sourceUrl`: Link to original (Reddit post, blog, YouTube)
- `sourceType`: What kind of source
- `attributionText`: Human-readable attribution
- `licenseType`: What license the content is under

**Metadata Fields**:
- `categoryId`: Foreign key to Category
- `createdById`: Who submitted it (null = admin-curated)
- `voteCount`: Denormalized (cached from votes table)
- `viewCount`: Track engagement
- `status`: "published" | "pending" | "archived" | "rejected"
- `hackFingerprint`: Hash for duplicate detection

**Indexes**:
- `categoryId` — Filter by category
- `createdById` — Find user's hacks
- `status` — Show only published hacks
- `voteCount` — Sort by popularity
- `createdAt` — Sort by date
- `hackFingerprint` — Duplicate detection
- **Full-text index** (title + description) — For search

**Decisions**:
- ✓ **JSON for steps** (vs separate Steps table)
  - Pro: Simpler queries, faster for MVP, no schema needed
  - Con: Can't index individual steps
  - Con: Harder to query "hacks with > 5 steps"
  - Decision: Good for MVP, refactor to table in Month 3 if needed

- ✓ **Denormalized voteCount** (cache from votes table)
  - Pro: Fast sorting/filtering without JOIN
  - Con: Must update on every vote
  - Decision: Accept stale data (update every 5 sec is fine)

- ✓ **hackFingerprint for duplicate detection**
  - Algorithm: SHA256(title + first 3 steps)
  - Check before insert: `WHERE hackFingerprint = ?`
  - Prevents 50 versions of "How to boil water"

- ❌ **No "difficulty" field** (can add in Month 2)
- ❌ **No "time_required" field** (can add later)
- ✓ **imageUrl is optional** (not all hacks need images)

---

### 4. VOTE (Crowdsourced Curation)

```prisma
model Vote {
  id        String   @id @default(cuid())
  hackId    String
  userId    String
  voteType  String   // "upvote" | "downvote"
  createdAt DateTime @default(now())
  
  @@unique([hackId, userId])
}
```

**Why this design**:
- One vote per user per hack (composite unique constraint)
- User can change vote (upvote → downvote → remove)
- Simple record of who voted on what

**Implementation**:
- Create vote: `INSERT INTO votes ...`
- Change vote: `UPDATE votes SET voteType = ? WHERE hackId = ? AND userId = ?`
- Remove vote: `DELETE FROM votes WHERE hackId = ? AND userId = ?`

**Indexes**:
- `hackId` — Find all votes for a hack
- `userId` — Find user's votes
- `createdAt` — Sort by date

**Decisions**:
- ✓ Simple upvote/downvote (no emoji reactions yet)
- ✓ User can change mind (vote is mutable)
- ✓ No "weighted" votes (all votes = equal)

---

### 5. SUBMISSION (User-Submitted Hacks)

```prisma
model Submission {
  id                String   @id @default(cuid())
  hackId            String?
  userId            String
  status            String   @default("pending")
  moderationReason  String?
  reviewedAt        DateTime?
  reviewedById      String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}
```

**Why this design**:
- Track user submissions separately from published hacks
- Admin can approve/reject/request changes
- Audit trail (who reviewed, when)

**Status Flow**:
```
pending → approved → published (Hack record created)
       → rejected (deletedsubmission, no Hack record)
       → under_review (message to user: "we're looking at this")
```

**Indexes**:
- `userId` — Find user's submissions
- `status` — Filter by pending/approved/rejected
- `createdAt` — Sort by date

**Decisions**:
- ✓ Separate table from Hack (clean separation)
- ✓ hackId nullable (submission might not become a hack)
- ✓ Audit trail (reviewedBy + reviewedAt)

---

### 6. SPAMFILTER (Automated Moderation)

```prisma
model SpamFilter {
  id           String   @id @default(cuid())
  filterName   String   @unique
  regexPattern String
  action       String   // "reject" | "flag"
  enabled      Boolean  @default(true)
  createdAt    DateTime @default(now())
}
```

**Example Filters**:
```
1. filterName: "money_fast"
   regexPattern: "(make|get|earn).*money.*fast"
   action: "reject"

2. filterName: "crypto_spam"
   regexPattern: "(crypto|bitcoin|nft|blockchain)"
   action: "flag"

3. filterName: "profanity"
   regexPattern: "[offensive words]"
   action: "reject"
```

**Decisions**:
- ✓ Configurable by admin (don't hardcode)
- ✓ Can enable/disable without code change
- ✓ Simple regex (not ML, keeps it fast)
- ✓ Two actions: reject (auto-block) vs flag (human review)

---

### 7. FLAGREPORT (User Reports)

```prisma
model FlagReport {
  id        String   @id @default(cuid())
  hackId    String
  reason    String   // "spam" | "inappropriate" | "misinformation" | "doesn't-work"
  count     Int      @default(1)
  createdAt DateTime @default(now())
  
  @@unique([hackId, reason])
}
```

**Why this design**:
- Users can report hacks (doesn't work, spam, misinformation)
- Count flags per hack per reason
- Auto-hide hacks with 5+ flags of same reason

**Implementation**:
```sql
-- When user reports:
INSERT INTO flag_reports (hackId, reason, count)
VALUES (?, ?, 1)
ON CONFLICT (hackId, reason) DO UPDATE
SET count = count + 1;

-- Auto-hide hacks with 5+ flags:
SELECT * FROM hacks
WHERE id IN (
  SELECT hackId FROM flag_reports
  WHERE count >= 5
)
```

**Decisions**:
- ✓ Aggregate by reason (different reports need different action)
- ✓ Composite unique (one record per hack+reason combo)
- ✓ Simple counter (not list of reporters, privacy-friendly)

---

### 8. (Future) ADMIN_LOG

**Not in MVP** but worth planning:

```prisma
model AdminLog {
  id        String   @id @default(cuid())
  adminId   String
  action    String   // "approve" | "reject" | "delete" | "ban"
  targetId  String   // The hack/user affected
  reason    String?
  createdAt DateTime @default(now())
}
```

**Why later**:
- Not essential for MVP
- Can add in Week 2 if needed
- Good for audit trails in Month 2

---

## Key Design Decisions

### 1. Denormalization (voteCount)

**Question**: Should we cache voteCount on Hack or calculate from Votes table?

**Answer**: Cache it (denormalize)

**Why**:
- MVP will sort by votes frequently (trending hacks)
- Calculating with JOIN on every query is slow
- Acceptable to have 5-second staleness
- Can refactor to view/materialized view in Month 3

**Implementation**:
- On every vote: `UPDATE hacks SET voteCount = ? WHERE id = ?`
- Periodically sync: Background job runs every 5 min to recalculate

### 2. JSON for Steps

**Question**: Should steps be JSON or separate Step table?

**Answer**: JSON (for MVP)

**Why**:
- Simpler schema, faster queries
- No need to query individual steps (yet)
- Flexible: add fields without migration
- Refactor to table in Month 3 if needed

### 3. Soft Delete vs Hard Delete

**Question**: When hack is rejected, should we delete it or mark as archived?

**Answer**: Mark as archived (soft delete)

**Why**:
- Keep audit trail
- Can un-reject if needed
- Don't lose user data
- Hard delete hacks with `status = "archived"` only after 90 days

### 4. Attribution Fields

**Question**: How to handle copyright/attribution?

**Answer**: 4 fields (sourceUrl, sourceType, attributionText, licenseType)

**Why**:
- Legal compliance (show sources)
- FTC disclosure (affiliate hacks need clear attribution)
- DMCA compliance (link to original)
- Different sources need different handling

### 5. hackFingerprint

**Question**: How to prevent duplicate hacks?

**Answer**: Hash on insert, check before allowing

**Algorithm**:
```javascript
const crypto = require('crypto');
const fingerprint = crypto
  .createHash('sha256')
  .update(hack.title + hack.steps[0] + hack.steps[1])
  .digest('hex');
```

**Check**:
```sql
SELECT COUNT(*) FROM hacks WHERE hackFingerprint = ?
-- If > 0: Warn user "Similar hack exists"
```

---

## Queries We'll Need

### Homepage
```sql
-- Featured hack (random recent, high votes)
SELECT * FROM hacks 
WHERE status = 'published' 
ORDER BY voteCount DESC, createdAt DESC 
LIMIT 1

-- Category grid
SELECT id, name, slug, COUNT(h.id) as hackCount
FROM categories c
LEFT JOIN hacks h ON c.id = h.categoryId AND h.status = 'published'
GROUP BY c.id
```

### Browse Page
```sql
-- Hacks by category with sorting
SELECT * FROM hacks
WHERE categoryId = ? AND status = 'published'
ORDER BY voteCount DESC
LIMIT 20 OFFSET ?
```

### Search
```sql
-- Full-text search (PostgreSQL)
SELECT * FROM hacks
WHERE title @@ to_tsquery(?) AND status = 'published'
LIMIT 50
```

### Admin Panel
```sql
-- Pending submissions
SELECT s.*, u.username, h.title
FROM submissions s
JOIN users u ON s.userId = u.id
LEFT JOIN hacks h ON s.hackId = h.id
WHERE s.status = 'pending'
ORDER BY s.createdAt ASC
```

---

## Migration Path

### Week 1 (MVP Launch)
- Create all 8 tables
- Add indexes for common queries
- Seed with 300 curated hacks

### Week 2
- Add audit logging (optional)
- Monitor slow queries
- Add materialized view for trending hacks

### Month 2
- Refactor JSON steps to Steps table
- Add admin_log table
- Add user_reputation table

### Month 3+
- Add comments/replies system
- Add collections (user-curated hack lists)
- Add premium content flags

---

## Ready for Review

This schema is ready for Thursday checkpoint review. Questions to discuss:

- [ ] Does schema support all wireframe features?
- [ ] Any missing tables or fields?
- [ ] Should we adjust indexes?
- [ ] Any concerns about JSON vs table for steps?
- [ ] Attribution strategy correct?
- [ ] Rate limiting / soft limits needed?

**Next step**: You review designs, I review wireframes, we sync Thursday.
