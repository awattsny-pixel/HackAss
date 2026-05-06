# Sprint 1 Implementation Plan: Design & Development

**Status**: Ready to kick off  
**Duration**: Week 1-2 (April 28 - May 9)  
**Mode**: Parallel Backend + Frontend tracks with daily sync  
**Owner**: Alan (design + coordination) + Claude (architecture + code)

---

## Working Assumptions (Per Recommendations)

✓ Content: **300 hacks** at launch (conservative, quality-first)  
✓ Submissions: **Phased** (closed Weeks 1-4 → waitlist Week 5 → open Week 8)  
✓ Monetization: **Affiliate links + FTC disclosure** (no ads/sponsors at launch)  
✓ Team: **3.5 FTE confirmed** (Backend, Frontend, Content Lead, Designer)  

---

## Parallel Track Structure

```
WEEK 1-2: DESIGN & SETUP
├── TRACK A: BACKEND ARCHITECTURE
│   ├── Task 1.1: Database Schema Design (5 hrs)
│   ├── Task 1.3: API Specification (3 hrs)
│   └── Task 1.4: Dev Environment Setup (4 hrs)
│
└── TRACK B: FRONTEND DESIGN
    ├── Task 1.2: Wireframes & Mockups (6 hrs)
    ├── Task 1.5: Content Rubric & Curation Guide (2 hrs)
    └── SYNC POINT: Component library planning (to use shared design system)
```

**Dependency**: Wireframes inform API spec, but can start in parallel.  
**Sync Point**: Friday EOW (verify schema matches wireframe needs)

---

## TRACK A: Backend Architecture (Database + API)

### Task 1.1: Database Schema Design (5 hours)

**What**: Design PostgreSQL schema with Prisma models

**Owner**: Claude (with Alan's sign-off on design decisions)

**Deliverables by Wed (April 30)**:
- [ ] Schema diagram (Prisma or simple text visualization)
- [ ] Prisma schema file (schema.prisma)
- [ ] Documentation: Table relationships, indexes, constraints
- [ ] Decision log: Why we chose X over Y

**Tables to design**:
```
users
  - id, email, password_hash, created_at, username, reputation_score
  
hacks
  - id, title, description, steps (JSON), why_it_works
  - category_id, image_url
  - source_url, source_type, attribution_text, license_type
  - created_by (user_id), created_at, updated_at
  - vote_count, view_count, status (published/pending/archived)
  - hack_fingerprint (for duplicate detection)

categories
  - id, name, slug, description

votes
  - id, hack_id, user_id, vote_type (upvote/downvote), created_at

submissions
  - id, hack_id (null if user-submitted), user_id
  - status (pending/approved/rejected), moderation_reason
  - created_at, reviewed_at, reviewed_by (mod_id)

admin_filters
  - id, filter_name, regex_pattern, action (reject/flag), enabled
```

**Key decisions to document**:
- JSON vs separate tables for steps? → JSON (simpler, faster for MVP)
- Fingerprint algorithm? → SHA256(title + first_3_steps)
- Soft delete vs hard delete? → Soft delete (preserve history)
- Indexing strategy? → (title, category, created_at, votes)

**Alan's role**: Review schema, challenge decisions, suggest optimizations

---

### Task 1.3: API Specification (3 hours)

**What**: Document all REST endpoints, request/response formats

**Owner**: Claude (based on wireframes + schema)

**Deliverables by Thurs (May 1)**:
- [ ] API spec document (OpenAPI/Swagger format or markdown)
- [ ] All GET/POST/PUT/DELETE endpoints listed
- [ ] Request/response examples for each
- [ ] Error codes documented
- [ ] Rate limiting & auth flow detailed

**Core endpoints**:
```
Auth:
  POST /auth/register
  POST /auth/login
  POST /auth/logout
  GET /auth/me (current user)

Hacks (Read):
  GET /hacks (list, paginated, sortable)
  GET /hacks/:id (single hack with full details)
  GET /categories (list categories)
  GET /hacks?category=cooking (filter)
  GET /search?q=... (full-text search)

Hacks (Interact):
  POST /hacks/:id/vote (body: { vote: 'up' | 'down' })
  POST /hacks/:id/unvote

Submissions:
  POST /submissions (create hack submission)
  GET /submissions/:id (user's submission)

Admin:
  GET /admin/submissions (list pending)
  PATCH /admin/submissions/:id/approve
  PATCH /admin/submissions/:id/reject (body: { reason: '...' })
  POST /admin/spam-filters (create filter rule)
  POST /admin/users/:id/ban
  DELETE /hacks/:id (soft delete)
```

**Alan's role**: Review for completeness, suggest missing endpoints

---

### Task 1.4: Dev Environment Setup (4 hours)

**What**: Initialize repos, tooling, deployment targets

**Owner**: Claude (Alan can set up accounts/access)

**Deliverables by Fri (May 2)**:
- [ ] GitHub repos created (backend + frontend, with branches)
- [ ] Node.js + Express + TypeScript scaffolding
- [ ] React + Vite scaffolding
- [ ] ESLint + Prettier + TypeScript config
- [ ] .env template file documented
- [ ] Vercel project created (for frontend)
- [ ] Render/Railway project created (for backend)
- [ ] Database: Supabase project created, connection string in .env

**Alan's role**: 
- Create GitHub account/org (if needed)
- Create Supabase project
- Create Vercel/Render accounts
- Provide credentials to Claude

---

## TRACK B: Frontend Design (Wireframes + Design System)

### Task 1.2: Wireframes & UI Components (6 hours)

**What**: Design mockups for all major pages + component library plan

**Owner**: Alan (Designer role) + Claude (component specs)

**Deliverables by Wed (April 30)**:
- [ ] Wireframes for 6 main pages (Figma or high-fidelity mockups)
- [ ] Mobile + desktop versions
- [ ] Component inventory (buttons, cards, forms, etc.)
- [ ] Design token decisions (colors, typography, spacing)

**Pages to wireframe**:
1. **Homepage** (hero, featured hack, category grid, footer)
2. **Browse/Category** (hack list, filters, sorting, pagination)
3. **Hack Detail** (full hack, steps, voting, related, attribution)
4. **Search Results** (filtered list, empty state)
5. **User Profile** (auth, voting history, submissions, logout)
6. **Admin Dashboard** (moderation queue, stats, filters) — simplified

**Component Library** (to specify for dev):
- Button (variants: primary, secondary, disabled)
- Card (hack card, category card)
- Form (input, textarea, select, checkbox)
- Modal (voting, submission, confirmation)
- List (hack list, paginated)
- Badge (category, votes, status)
- Navigation (header, footer)
- Icons (upvote, downvote, search, menu)

**Design Decisions to Document**:
- Color palette (navy + teal + accent)
- Typography (headings, body, captions)
- Spacing scale (0.5rem, 1rem, 1.5rem, 2rem)
- Button sizing (responsive, touch-friendly)
- Mobile breakpoints (sm: 480px, md: 768px, lg: 1024px)

**Claude's role**: 
- Review designs for technical feasibility
- Suggest component structure for React
- Plan responsive breakpoints
- Propose reusable component patterns

---

### Task 1.5: Content Rubric & Curation Guide (2 hours)

**What**: Define what makes a "quality" hack before seeding

**Owner**: Alan (Content Lead) + Claude (documentation)

**Deliverables by Thurs (May 1)**:
- [ ] Content_Rubric.md (1-page rubric, 7 criteria)
- [ ] Curation_Template.xlsx (Airtable/Google Sheets template)
- [ ] 30-min team training session scheduled

**Rubric** (pass/fail):
1. **Clarity**: Steps are numbered, specific, < 10 steps
2. **Testable**: Average person can attempt it
3. **Beneficial**: Saves time, money, or effort (clear benefit)
4. **Unique**: Not a duplicate in database
5. **Safe**: No health risks (or clearly warned)
6. **Attributed**: Source linked (Reddit, blog, YouTube)
7. **Formatted**: Title + Steps + Why It Works + Category

**Pass**: All 7 criteria ✓  
**Fail**: Even 1 criterion ✗

**Curation Template columns**:
- Title
- Steps (copy-pasted or summarized)
- Why It Works
- Category
- Source URL
- Source Type (Reddit/Blog/YouTube/User)
- Curator Name
- Status (Approved/Rejected/Needs Review)
- Notes

---

## Coordination & Sync Points

### Daily Sync (10 min, async via Slack)
- What did you ship today?
- What's blocking you?
- Do designs/schema need to talk?

### Wed EOD Checkpoint (April 30)
- Schema draft reviewed (does it match wireframes?)
- Wireframes reviewed (are they buildable?)
- Decide: Any changes before moving forward?

### Fri EOD Sprint 1 Wrap
- Schema finalized
- API spec finalized
- Wireframes finalized
- All 4 tasks marked complete
- Ready for Week 2: Dev environment + coding

---

## Week 2: Dev Environment & Foundation Code

**Monday May 5** (after Sprint 1 decisions locked):

### TRACK A: Backend Setup
**Task 2.0: Dev Environment & Project Structure** (4 hours)
- [ ] GitHub repos set up, branches created (main, dev, feature/)
- [ ] Supabase PostgreSQL connected
- [ ] Prisma migrations working locally
- [ ] Express.js + TypeScript project structure
- [ ] .env configured, sample .env.example created
- [ ] Database seeded with 5 sample hacks (test data)
- [ ] First test: Can query "SELECT * FROM hacks" locally

**By Friday May 9**: 
- Backend environment ready, can run `npm run dev` and hit localhost:3001

### TRACK B: Frontend Setup
**Task 2.1: React + Vite Setup & Component Library** (6 hours)
- [ ] Vite project created, dev server working
- [ ] React Router set up (basic routing)
- [ ] Tailwind CSS or styled-components configured
- [ ] Component library folder structure created
- [ ] 5 core components built + Storybook previews:
  - Button.tsx
  - Card.tsx
  - Input.tsx
  - Navigation.tsx
  - Badge.tsx
- [ ] Responsive design tested on mobile

**By Friday May 9**:
- Frontend environment ready, can run `npm run dev` and see component library

---

## Role Clarity: What You Do vs What I Do

### Alan (Designer + PM Role)
✓ Create wireframes + mockups (Figma/Adobe XD)  
✓ Define content rubric (with my input)  
✓ Lead team coordination  
✓ Set up GitHub/Supabase accounts  
✓ Review my work (schema, API, code)  
✓ Make design decisions (colors, typography, components)  
✓ Create Airtable curation template  

### Claude (Backend + Frontend Architecture)
✓ Design database schema (you approve)  
✓ Document API spec (you validate)  
✓ Set up dev environments  
✓ Generate boilerplate code  
✓ Build component library (from your designs)  
✓ Implement responsive design  
✓ Write all production code (with your review)  

### Together
- Daily sync on blockers
- Weekly design/code review
- Decision log (why we chose X)
- Test all deliverables before marking done

---

## Deliverables Checklist

### Week 1 (by Friday May 2)
**Backend**:
- [ ] Database schema (Prisma schema.prisma + diagram)
- [ ] API specification (endpoints + request/response examples)
- [ ] Dev environment ready (repos, tooling, .env template)

**Frontend**:
- [ ] Wireframes for 6 pages (desktop + mobile)
- [ ] Component inventory + design tokens
- [ ] Content rubric document + curation template

### Week 2 (by Friday May 9)
**Backend**:
- [ ] Dev environment working (localhost:3001, PostgreSQL connected)
- [ ] First test query working
- [ ] Test data loaded

**Frontend**:
- [ ] Dev environment working (localhost:5173, components built)
- [ ] 5 core components in Storybook
- [ ] Responsive design verified

---

## Verification Before We Move Forward

Each deliverable must be **verified + approved** before moving to next:

**Schema**: 
- [ ] Reviewed by both parties
- [ ] All tables make sense
- [ ] Indexes planned
- [ ] No contradictions with wireframes

**Wireframes**:
- [ ] 6 pages complete
- [ ] Mobile + desktop versions
- [ ] Component library mapped
- [ ] Responsive design feasible

**Dev Environment**:
- [ ] Can clone repos and run locally
- [ ] Can connect to database
- [ ] Can start dev servers
- [ ] All team members can reproduce

---

## Timeline Summary

| Date | Phase | Owner | Deliverables |
|------|-------|-------|--------------|
| **Tue 4/28** | Kickoff | Both | Review plan, confirm approach |
| **Wed 4/30** | Week 1 checkpoint | Both | Schema draft + Wireframes draft |
| **Fri 5/2** | Week 1 complete | Both | Schema ✓ + Wireframes ✓ + API spec ✓ |
| **Mon 5/5** | Week 2 kickoff | Both | Decisions locked, team briefed |
| **Fri 5/9** | Week 2 complete | Both | Dev environments ready |
| **Mon 5/12** | Week 3 start | Backend dev + Frontend dev | Begin API implementation |

---

## Getting Started: First 3 Steps

1. **Today (Tue 4/28)**: 
   - [ ] You: Create GitHub org + repos (backend, frontend)
   - [ ] You: Create Supabase project, get connection string
   - [ ] Me: Review this plan, start schema design

2. **Tomorrow (Wed 4/29)**:
   - [ ] You: Sketch wireframes for 3 main pages
   - [ ] Me: Draft schema, share for feedback
   - [ ] Both: 30-min sync on approach

3. **Thurs 4/30**:
   - [ ] You: Wireframes nearly done, design tokens documented
   - [ ] Me: Schema + API spec drafts ready
   - [ ] Both: Formal review checkpoint

---

## Questions Before We Start

- Do you have Figma/Adobe XD set up for wireframes?
- What's your GitHub org name (for repos)?
- Should we use Tailwind CSS (recommended) or styled-components?
- Any specific preference for backend hosting (Render vs Railway)?

**Ready to start?** Let's confirm these answers and kick off design tomorrow.

---

**Next**: You answer the 4 questions above, I'll start schema design today.
