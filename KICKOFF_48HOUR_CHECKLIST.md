# 48-Hour Kickoff Checklist

**Objective**: Get both tracks (Backend + Frontend) ready to work in parallel  
**Timeline**: Tue 4/28 (today) + Wed 4/29 (tomorrow)  
**Sync**: Thurs 4/30 (design review checkpoint)

---

## TODAY (Tuesday, April 28)

### Alan's Setup Tasks (30 min)

**GitHub Setup** (15 min):
- [ ] Go to github.com/new/organization
- [ ] Create org: `hack-aggregator` (or `HackAggregator-org`)
- [ ] Make it public (so I can clone in cloud)
- [ ] Invite Claude as collaborator (use email: alan@poppy.com for access request)
- [ ] Share org URL in Slack: `https://github.com/hack-aggregator`

**Supabase Setup** (10 min):
- [ ] Go to supabase.com, sign up (or log in)
- [ ] Create new project: `hack-aggregator-main`
- [ ] Region: Choose closest to you (e.g., us-east-1)
- [ ] Database password: Save securely
- [ ] Get connection string (Settings → Database → Connection String → Prisma)
- [ ] Share connection string via secure method (Slack DM or 1Password)

**Figma Setup** (5 min):
- [ ] Go to figma.com, sign up (free tier)
- [ ] Create new file: `Hack Aggregator - Wireframes`
- [ ] Share link with Claude (so I can see designs as you sketch)

### Claude's Work (1 hour)

**Database Schema Draft** (60 min):
- [ ] Design 6 core tables (users, hacks, categories, votes, submissions, admin_filters)
- [ ] Document relationships, indexes, constraints
- [ ] Create decision log (why JSON for steps vs table, etc.)
- [ ] Produce:
  - `schema.prisma` (Prisma schema file)
  - `SCHEMA_NOTES.md` (design decisions)
  - `SCHEMA_DIAGRAM.txt` (ASCII or text visualization)
- [ ] Share in Slack for review

### End of Day Check-In (5 min)
**Slack message from Alan**:
```
✓ GitHub org created: [URL]
✓ Supabase project created: [project-id]
✓ Figma file: [URL]
✓ Connection string: [shared securely]
```

**Slack message from Claude**:
```
✓ Schema draft complete
✓ Files: schema.prisma, SCHEMA_NOTES.md, SCHEMA_DIAGRAM.txt
✓ Questions/decisions for you:
  1. [question]
  2. [question]
✓ Ready for Wed review
```

---

## TOMORROW (Wednesday, April 29)

### Alan's Work (4 hours)

**Wireframe Design** (3.5 hours):
- [ ] Start with 2 main pages:
  1. **Homepage** (hero + featured hack + category grid + footer)
  2. **Hack Detail** (full hack view + voting + related + attribution)
- [ ] For each page:
  - [ ] Desktop version (1200px+)
  - [ ] Mobile version (375px)
  - [ ] Annotate component names (Button, Card, etc.)
- [ ] Document design decisions:
  - [ ] Color palette (pick 3-4 colors)
  - [ ] Typography (pick heading + body font)
  - [ ] Spacing scale (e.g., 8px, 16px, 24px)
  - [ ] Button sizing (desktop + mobile)
- [ ] Save in Figma, share link

**Rubric & Curation Template** (0.5 hours):
- [ ] Create Content_Rubric.md (7 criteria, pass/fail)
- [ ] Set up Airtable or Google Sheets:
  - [ ] Columns: Title, Steps, Category, Source, Curator, Status
  - [ ] Share template link

### Claude's Work (2 hours)

**API Specification** (90 min):
- [ ] Review your wireframes (15 min)
- [ ] Draft API spec based on wireframes
- [ ] Document:
  - [ ] All GET/POST/PATCH/DELETE endpoints
  - [ ] Request/response examples for 5 core endpoints
  - [ ] Error codes + HTTP status codes
  - [ ] Rate limiting rules
- [ ] Produce: `API_SPECIFICATION.md`

**Dev Environment Planning** (30 min):
- [ ] Plan repo structure:
  ```
  hack-aggregator-backend/
    ├── src/
    │   ├── routes/
    │   ├── middleware/
    │   ├── models/
    │   └── utils/
    ├── prisma/
    │   └── schema.prisma
    ├── package.json
    ├── .env.example
    └── tsconfig.json
  
  hack-aggregator-frontend/
    ├── src/
    │   ├── components/
    │   │   ├── common/
    │   │   ├── pages/
    │   │   └── layout/
    │   ├── hooks/
    │   ├── styles/
    │   └── main.tsx
    ├── public/
    ├── package.json
    ├── vite.config.ts
    └── tailwind.config.js
  ```
- [ ] Prepare setup instructions for you

### End of Day Check-In (10 min)

**Slack message from Alan**:
```
✓ Wireframes (Homepage + Detail): [Figma URL]
✓ Design tokens documented:
  - Colors: [list 3-4]
  - Typography: [heading + body]
  - Spacing: [scale]
✓ Content Rubric: [file path]
✓ Curation Template: [Airtable/Sheet URL]
✓ Ready for Thu review
```

**Slack message from Claude**:
```
✓ Schema review: [decisions/feedback]
✓ API Spec complete: [file path]
✓ Dev environment plan: [file path]
✓ Thu checkpoint: Review designs + schema together
```

---

## THURSDAY (April 30) - Design Review Checkpoint

### 30-Min Sync (10 AM or async Slack)

**What we're reviewing**:
1. ✓ Database schema (is it sound? Does it match wireframes?)
2. ✓ Wireframes (2-3 pages done, component list clear)
3. ✓ API spec (endpoints match wireframe flows?)
4. ✓ Content rubric (will curators understand it?)

**Questions to answer**:
- Does schema support all wireframe features?
- Are API endpoints aligned with UI flows?
- Do wireframes suggest any schema changes?
- Any misalignments to fix before moving forward?

### Decisions
- [ ] Approve schema as-is or request changes?
- [ ] Approve wireframes as-is or request changes?
- [ ] Ready to proceed to Week 2 (dev environment + code)?

### End of Day: Week 1 Wrap
- [ ] All 4 tasks (schema, API, wireframes, rubric) marked COMPLETE
- [ ] Decision log updated with choices made
- [ ] Team briefed: Ready for Week 2 Monday (May 5)

---

## What I'll Have Ready by Thursday

**Backend Deliverables**:
- [ ] `schema.prisma` — Complete Prisma schema (6 tables, relationships, indexes)
- [ ] `SCHEMA_NOTES.md` — Design decisions explained
- [ ] `SCHEMA_DIAGRAM.txt` — Visual representation of tables + relationships
- [ ] `API_SPECIFICATION.md` — All endpoints documented (OpenAPI format)
- [ ] `DEV_ENVIRONMENT.md` — Step-by-step setup guide

**Frontend Deliverables**:
- [ ] `WIREFRAMES.figma` — 2-3 main pages (desktop + mobile)
- [ ] `COMPONENT_INVENTORY.md` — List of all components needed
- [ ] `DESIGN_TOKENS.md` — Colors, typography, spacing, sizing rules
- [ ] `COMPONENT_LIBRARY_PLAN.md` — React component structure

---

## What You'll Have Ready by Thursday

**Design & Content**:
- [ ] `Content_Rubric.md` — 7 criteria for hack quality
- [ ] `CURATION_TEMPLATE` — Airtable/Google Sheets ready to go
- [ ] Wireframes (2-3 pages, desktop + mobile)
- [ ] Design token decisions (colors, fonts, spacing)

**Infrastructure**:
- [ ] GitHub org created + repos ready
- [ ] Supabase project live + connection string
- [ ] Figma file shared

---

## Friday (May 2) - Ready for Week 2

**By EOD Friday**, we should have:
- ✓ Schema finalized
- ✓ API spec finalized
- ✓ Wireframes finalized (all 6 pages drafted)
- ✓ Dev environment instructions ready
- ✓ Both repos created on GitHub
- ✓ Supabase database ready for Prisma migration

**Monday (May 5)**: Decision sync with team, then Week 2 kickoff

---

## Communication Protocol

**Daily Sync** (async, Slack):
- 5 PM: What did you ship today?
- 5 PM: Blockers or questions?
- Next day AM: I respond with updates

**Wednesday Checkpoint** (15 min sync or async):
- Review designs + schema together
- Identify any misalignments
- Plan fixes if needed

**Thursday Design Review** (30 min sync):
- Formal sign-off on Week 1 deliverables
- Go/no-go for Week 2 kickoff

---

## Success Criteria for 48-Hour Kickoff

**By Thursday EOD, we've succeeded if**:
1. ✓ GitHub org + 2 repos created
2. ✓ Supabase project live + connection string shared
3. ✓ Database schema drafted + documented
4. ✓ API specification drafted + reviewed
5. ✓ Wireframes sketched (2-3 pages, mobile + desktop)
6. ✓ Design tokens defined (colors, fonts, spacing)
7. ✓ Content rubric documented
8. ✓ Curation template set up
9. ✓ Both parties understand the plan

**By Friday EOD, we're ready for Week 2 if**:
10. ✓ Schema finalized (no more changes)
11. ✓ API spec finalized (no more changes)
12. ✓ Wireframes finalized (all 6 pages drafted)
13. ✓ Dev environment setup instructions ready
14. ✓ All files in repo (or shared drive)

---

## Starting Right Now

**Today (Tue 4/28)**:
1. [ ] Create GitHub org
2. [ ] Create Supabase project
3. [ ] Create Figma file
4. [ ] Share links in Slack

**I'll start schema design today.** Can you handle the 3 setup steps above?

Once those are done, we'll have everything we need to execute in parallel.

---

**Questions before we start?** Otherwise, let's go! 🚀
