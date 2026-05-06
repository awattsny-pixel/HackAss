# Thursday Design Review Checklist

**Date**: Thursday, April 30, 2026  
**Time**: 30 minutes  
**Participants**: Alan (Frontend) + Claude (Backend)  
**Goal**: Validate that wireframes align with database schema & API spec  

---

## Pre-Review (Before Thursday Meeting)

### Alan Should Prepare 📐
- [ ] Figma file created with 2-3 wireframes
  - [ ] Homepage (how users discover hacks)
  - [ ] Hack Detail (how users view a single hack)
  - [ ] Browse/Category (how users filter and search)
  - [ ] Mobile & desktop versions for each
- [ ] Design tokens defined
  - [ ] Color palette (primary, secondary, backgrounds)
  - [ ] Typography (font family, sizes, weights)
  - [ ] Spacing system (margins, padding scale)
  - [ ] Component list (button, card, input, etc.)
- [ ] Share Figma link before Thursday meeting

### Claude Should Prepare 🔧
- [ ] API Specification reviewed ✅ (done Wed 4/29)
- [ ] Database schema understood ✅ (done Tue 4/28)
- [ ] Endpoint list organized by resource ✅
- [ ] Prepare alignment questions (see below)

---

## Design Review Meeting Flow

### Part 1: UI Overview (5 min)

Alan walks through wireframes:
1. What is the user doing on each page?
2. What data are they seeing?
3. What actions can they take?

Claude takes notes on:
- What API endpoints are needed
- What data needs to flow
- Any missing features from the schema

---

### Part 2: API Alignment Check (15 min)

Go through each wireframe and map to API:

#### Homepage Wireframe
- [ ] **Feature**: Featured hacks carousel
  - **API Needed**: `GET /api/hacks?sort=trending&limit=5`
  - **Data**: hack.id, hack.title, hack.imageUrl, hack.voteCount
  - **Schema Fields**: ✅ All present
  
- [ ] **Feature**: Browse by category buttons
  - **API Needed**: `GET /api/categories`
  - **Data**: category.id, category.name, category.hackCount
  - **Schema Fields**: ✅ All present
  
- [ ] **Feature**: Search bar
  - **API Needed**: `GET /api/search?q=salt`
  - **Data**: Full-text search results
  - **Schema Fields**: ✅ Full-text index on hack.title + description

#### Hack Detail Wireframe
- [ ] **Feature**: Full hack details (title, steps, why it works)
  - **API Needed**: `GET /api/hacks/:id`
  - **Data**: All hack fields including steps (JSON), whyItWorks
  - **Schema Fields**: ✅ All present

- [ ] **Feature**: Vote buttons (upvote/downvote)
  - **API Needed**: `POST /api/hacks/:id/vote`
  - **Data**: User's current vote, total votes
  - **Schema Fields**: ✅ Vote table + hack.voteCount
  
- [ ] **Feature**: Attribution/source link
  - **API Needed**: Included in `GET /api/hacks/:id`
  - **Data**: hack.sourceUrl, hack.attributionText, hack.licenseType
  - **Schema Fields**: ✅ All present

- [ ] **Feature**: Flag hack button
  - **API Needed**: `POST /api/hacks/:id/flag`
  - **Data**: Reason for flag (spam, duplicate, etc.)
  - **Schema Fields**: ✅ FlagReport table

- [ ] **Feature**: Submit improvement/correction
  - **API Needed**: `POST /api/submissions`
  - **Data**: hackId, proposed changes
  - **Schema Fields**: ✅ Submission table

#### Browse/Category Wireframe
- [ ] **Feature**: Category list with hack counts
  - **API Needed**: `GET /api/categories`
  - **Data**: category, hackCount
  - **Schema Fields**: ✅ Can aggregate from hacks

- [ ] **Feature**: Filter by category + sort
  - **API Needed**: `GET /api/hacks?category=cooking-kitchen&sort=popular`
  - **Data**: Filtered hack list
  - **Schema Fields**: ✅ All indexes present

- [ ] **Feature**: Pagination (load more)
  - **API Needed**: `GET /api/hacks?page=2&limit=20`
  - **Data**: page, limit, total
  - **Schema Fields**: ✅ Can paginate with SQL OFFSET/LIMIT

---

### Part 3: Authentication Flow (3 min)

- [ ] **Feature**: Register/Login screens exist
  - **API Needed**: `POST /api/auth/register`, `POST /api/auth/login`
  - **Data**: email, username, password → JWT token
  - **Schema Fields**: ✅ User table + JWT secret in .env

- [ ] **Feature**: Logged-in user state (profile, my hacks)
  - **API Needed**: `GET /api/auth/me`
  - **Data**: userId, email, username
  - **Schema Fields**: ✅ User table

---

### Part 4: Gap Identification (5 min)

**Questions to Ask**:

1. **Is anything in the wireframes NOT in the API spec?**
   - If yes: Do we need to add an endpoint?
   - Example: "User profile page" → Need `GET /api/users/:username`

2. **Is anything in the API spec NOT in the wireframes?**
   - If yes: Can it wait for Month 2? Should we include it?
   - Example: Comments → Not in MVP, can add Month 2

3. **Are there data type mismatches?**
   - Frontend expects string for hack.steps but API returns JSON array?
   - Need to clarify serialization format

4. **Are there missing edge cases?**
   - What if user votes, then unvotes? (API handles with `voteType: null`)
   - What if hack is flagged 10 times? (Auto-hide pending review - not in current spec, could add)

5. **Is pagination/performance acceptable?**
   - Homepage loads "featured hacks" - can we do this efficiently? (Yes, `voteCount` index)
   - Search across 1000s of hacks - full-text index helps? (Yes, PostgreSQL FTS)

---

## Decision Framework (for Thursday)

If gaps found, use this logic:

| Gap Type | Decision | Action |
|----------|----------|--------|
| UI feature without API | **Ask**: Is it MVP or Month 2? | If MVP: Add endpoint before Friday. If Month 2: Document and skip. |
| API feature without UI | **Ask**: Is it MVP or Month 2? | If MVP: Add to wireframe before Friday. If Month 2: Document and skip. |
| Data type mismatch | **Ask**: Which is right? | Choose one, update the other to match. |
| Performance concern | **Ask**: Can we add an index? | If yes: Add to schema, regenerate. If no: Document workaround. |

**Principle**: If it's in both (wireframes + API), it's good. Gaps are okay if we agree they're Month 2.

---

## Post-Review Actions

### If No Major Gaps Found ✅
- [ ] Both sign off: "Ready for Week 2"
- [ ] No schema changes needed
- [ ] No API changes needed
- [ ] Frontend team can start building components Monday

### If Gaps Found ⚠️
- [ ] Document the gap
- [ ] Decide: Fix Friday or defer to Month 2?
- [ ] If Friday: Assign to Alan or Claude
- [ ] Update schema/API accordingly
- [ ] Re-test alignment Friday morning

---

## Alignment Scorecard (Rate 1-5)

Use these after the review:

**Schema ↔ Wireframes Alignment**
- 5: Perfect match, everything needed is there
- 4: Minor additions needed, mostly good
- 3: Some gaps, need refinement
- 2: Major gaps, significant rework needed
- 1: Fundamentally misaligned

**API ↔ UI Flows Alignment**
- 5: Every button maps to an endpoint
- 4: 95%+ mapped, minor tweaks
- 3: 80%+ mapped, some missing
- 2: 60%+, significant gaps
- 1: <50%, major redesign needed

**Design Tokens ↔ Implementability**
- 5: All tokens directly map to Tailwind
- 4: Most map, minor custom CSS
- 3: Some map, some custom needed
- 2: Significant custom CSS required
- 1: Palette doesn't match brand/Tailwind

**Target**: All three scores should be 4-5

---

## Documents to Reference During Review

| Document | Why | Who Uses |
|----------|-----|----------|
| `API_SPECIFICATION.md` | Shows all endpoints, request/response formats | Both - constantly referenced |
| `schema.prisma` | Shows database fields available | Claude - to verify data exists |
| Figma wireframes | Shows what user sees | Alan - main talking point |
| `SCHEMA_DESIGN_DECISIONS.md` | Explains why fields exist | Claude - if "why is this field here?" |

---

## Scheduling the Review

**When**: Thursday, April 30, 2026, 30 minutes  
**Format**: 
- Option A: Video call (recommended for real-time whiteboarding)
- Option B: Async (Figma link shared, Claude reviews & responds in writing)

**What to Bring**:
- Alan: Figma link, design tokens (colors, fonts)
- Claude: API spec, schema reference

---

## Success Criteria for Thursday

By end of the 30-minute review:

- [ ] All wireframes reviewed
- [ ] All API endpoints validated against UI flows
- [ ] No major gaps identified (or gaps documented as Month 2)
- [ ] Design tokens reviewed for feasibility
- [ ] Both teams clear on what Month 2 looks like
- [ ] Confidence level: Both give thumbs up 👍

If all above ✅, then:
- [ ] Friday: Any final refinements
- [ ] Monday: Start Week 2 development

---

## Example: Walking Through Homepage

**Alan shows wireframe**:
> "Homepage has: featured hacks carousel (5 hacks), category browse buttons, search bar, recent hacks list"

**Claude asks**:
- Featured hacks: How do we decide which 5? (Answer: Most popular + recent - uses `sort=trending`)
- Categories: Do we show hack counts? (Answer: Yes, "42 hacks") 
- Recent: Are these newest or trending? (Answer: Newest first)
- Search: Real-time or submit button? (Answer: Submit button)

**Claude maps to API**:
```
Homepage needs:
✅ GET /api/hacks?sort=trending&limit=5 (featured)
✅ GET /api/categories (category list)
✅ GET /api/hacks?sort=newest&limit=10 (recent)
✅ GET /api/search?q=<query> (search)
```

**Validation**:
- All endpoints exist in `API_SPECIFICATION.md`? Yes ✅
- All data fields in schema? Yes ✅
- Any missing features? No ✅

→ **Result**: Homepage is aligned ✅

---

## Quick Troubleshooting

**"This feature isn't in the API spec"**
→ Add it to API (takes 5 min) OR defer to Month 2

**"The schema doesn't have this field"**
→ Add field to schema (takes 5 min) OR redesign feature

**"This will be slow to query"**
→ Add index to schema (takes 5 min) OR optimize query

**"We disagree on how to do this"**
→ Document both approaches, decide Friday

---

## Thursday Meeting Agenda (Suggested Order)

```
0:00-0:05 | Alan presents wireframes (quick tour)
0:05-0:15 | Page-by-page API alignment
0:15-0:20 | Design tokens + feasibility
0:20-0:25 | Gap identification & decisions
0:25-0:30 | Sign-off & Friday plan
```

---

**Next Step**: Alan shares Figma link, we reconvene Thursday  
**Status**: Ready for design review  
**Confidence**: High ✅
