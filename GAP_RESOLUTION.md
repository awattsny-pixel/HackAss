# Hack Aggregator: Gap Resolution & Launch Readiness

**Status**: Deep dive on 8 identified concerns  
**Timeline**: Sprint 1 (Week 1-2) + refined roadmap  
**Owner**: Project Leadership  
**Last Updated**: 2026-04-28

---

## Executive Summary

**Launch Blockers (Resolve Before Sprint 1):**
1. ✓ Cold Start Content Strategy — define rubric + realistic estimates
2. ✓ Moderation Capacity — plan scalable moderation system
3. ✓ Submission Gating — decide MVP scope (enable/disable user submissions)
4. ✓ Legal & Monetization — clarify FTC disclosure + attribution requirements

**Important But Not Blockers:**
5. TikTok Expectations — reset targets to realistic growth
6. Content Quality Rubric — can iterate post-launch
7. Technical Debt — plan for scaling phase (Month 2+)
8. Team Capacity — adjust timeline if needed

---

## GAP #1: Cold Start Problem (BLOCKER)

### Current Plan Issue
- **Estimate**: 8 hours (Task 4.1) to seed 500 hacks
- **Reality**: 500 curated hacks = 40-60 hours minimum
- **Risk**: Launch with low-quality or duplicate content

### Resolution

#### A. Content Sourcing Strategy
**Primary Sources** (in priority order):
1. **Reddit curation** (40%): r/lifeprotips, r/Cooking, r/personalfinance, r/cleaning
   - Search top posts (last 2 years, 1K+ upvotes)
   - Extract title, steps, why it works
   - Time: 15-20 hours
   - Quality: High (community-vetted)

2. **Blog aggregation** (30%): Existing hack blogs with permissive licenses
   - BuzzFeed articles (https://www.buzzfeed.com/life/hacks)
   - Apartment Therapy, Serious Eats (home + cooking)
   - Time: 10-15 hours
   - Quality: Editorial (reliable)

3. **YouTube transcripts** (20%): Quick visual hacks
   - 5-Minute Crafts, Hacks Land (with caution re: copyright)
   - Screenshot key steps + write summary
   - Time: 10-15 hours
   - Quality: Medium (some are fake/misleading)

4. **User imports** (10%): Friends/beta testers submit initial batch
   - Small incentive ($5-10 per approved hack)
   - Time: 5 hours management
   - Quality: Variable

**Total Expected Hacks**: 400-600  
**Total Time**: 40-65 hours  
**Quality Target**: 80%+ pass moderation rubric

#### B. Content Rubric (Define Before Curation)

Every hack must pass **ALL** of these:

| Criterion | Pass | Fail |
|-----------|------|------|
| **Clarity** | Steps are numbered, specific, < 10 steps | Vague instructions, 20+ steps, missing details |
| **Testability** | Can be attempted by average person | Requires specialized equipment or expertise |
| **Benefit** | Clear time/money/effort saved | Marginal improvement or clickbait |
| **Originality** | Not a duplicate in database | Same hack phrased differently |
| **Safety** | No health/safety risks or clearly warns | Dangerous without proper disclaimers |
| **Attribution** | Source linked (Reddit post, blog, YouTube) | No attribution or stolen content |
| **Format** | Title, steps, why-it-works, category | Incomplete or poorly structured |

**Decision**: Any hack failing even 1 criterion is rejected.

#### C. Curation Process

**Step 1: Collection Phase** (Week 1)
- Assign team member: "Content Lead" (full-time)
- Create Airtable/Google Sheets template:
  - Title | Steps | Why It Works | Category | Source | Curator | Status (Approved/Rejected/Needs Review)
- Scrape Reddit, blogs, YouTube into spreadsheet
- ~150 hacks/day = 400 by Friday

**Step 2: Normalization** (Week 1-2)
- Standard format: Title (action + benefit) + 3-7 steps + Why It Works section
- Example bad: "Make better coffee"
- Example good: "Cold brew coffee tastes smoother (less acid) than hot coffee. Mix 1:4 coffee-to-water ratio, let sit 12 hours, strain."
- Time: 20-30 hours

**Step 3: Deduplication** (Week 2)
- Run fuzzy matching on titles (find similar hacks)
- Manual review of potential duplicates
- Keep highest-quality version, discard others
- Time: 5-10 hours

**Step 4: Verification** (Week 2)
- QA pass: 10% spot-check of all curated hacks
- Test a few hacks yourself (does it actually work?)
- Fix any broken formatting
- Time: 5-10 hours

#### D. Revised Task Estimate

**Task 4.1 (Content Seeding)**: Original 8 hours → **65 hours**

**Breakdown**:
- Collection & normalization: 40 hours (Content Lead, full-time Week 1-2)
- Deduplication & verification: 15 hours (Content Lead + Designer, Week 2)
- Import script + admin testing: 5 hours (Backend dev, Week 2)
- Contingency (missing sources, retakes): 5 hours

**Team**: 1 Content Lead (dedicated) + Backend dev support + QA spot-check  
**Output**: 400-600 verified hacks in database, categorized, formatted consistently

#### E. Launch Content Strategy

**Option A: Conservative (Recommended)**
- Launch with 300 curated hacks (Week 4)
- All high-quality (strict rubric)
- Add 50-100 more in Week 5 post-launch
- Advantage: Quality > quantity; less moderation burden
- Risk: Smaller initial catalog, but grows via users

**Option B: Ambitious**
- Launch with 500+ hacks (aggressive timeline)
- Relax rubric slightly (85% vs 90% quality)
- Requires 65+ hours confirmed by Week 2
- Advantage: Larger catalog, more variety
- Risk: More spam/low-quality = more moderation needed

**Recommendation**: Option A. Launch with 300 strong hacks. User submissions fill the gaps.

---

## GAP #2: Moderation & Spam Handling (BLOCKER)

### Current Plan Issue
- **MVP**: Task 4.3 has basic submit form + moderation queue
- **Post-Launch**: Task 5.3 says "2x daily moderation" (morning + evening)
- **Reality**: If you get 10+ submissions/day by Week 6, 2x daily = 1 hour/day = insufficient
- **Risk**: Queue backs up, spam proliferates, users get discouraged

### Resolution

#### A. Moderation Capacity Planning

**Week 1-4 (Pre-Launch)**:
- No user submissions (form exists but gated)
- Only admin curated hacks
- Moderation: None needed

**Week 5-8 (Launch + Ramp)**:
- Enable submissions → waitlist (50 users)
- Expected submissions: 5-10/day
- Moderation: 1 person, 30 min/day
- SLA: Approve/reject within 24 hours

**Week 8-12 (Growth Phase)**:
- Open submissions to all users
- Expected: 20-50+ submissions/day
- Moderation: 1 person, 2+ hours/day
- Risk: Backlog grows

**Month 3+ (Scaling)**:
- Too many for 1 person → implement automation + volunteers
- Expected: 100+ submissions/day
- Moderation: 1 paid mod + 3-5 volunteer mods

**Decision**: Don't enable open user submissions until you have moderation capacity (Week 8+).

#### B. Moderation Workflow (Scalable Design)

**Tier 1: Automated Filtering** (catches 80% of spam)
- Implemented in Week 3, active before submissions enabled
- Rules:
  - Reject if title < 5 words or > 100 chars
  - Reject if steps > 15 or < 2
  - Reject if contains promotional keywords (see Appendix A)
  - Reject if duplicate title (fuzzy match)
  - Flag if from new user (email < 24 hours old)
- Implementation: 3-4 hours (Backend dev, Week 3)

**Tier 2: Human Review** (catches remaining spam + quality issues)
- Moderation dashboard (Task 4.2 already includes this)
- Checklist for each submission:
  - [ ] Title is clear and benefit-focused
  - [ ] Steps are testable and specific
  - [ ] "Why it works" section explains mechanism
  - [ ] No misinformation (obviously false claims)
  - [ ] No spam/affiliate links (unless disclosed)
  - [ ] Passes plagiarism check (manual or tool)
- Options: Approve / Reject with reason / Request changes
- Time: 2-3 min per submission
- SLA: 24 hours during Week 5-8, escalate if backlog > 10

**Tier 3: Community Reporting** (post-launch)
- Users can flag hacks as "doesn't work" / "spam" / "misleading"
- Hacks with 5+ flags auto-hide pending review
- Implementation: Task 3.3 enhancement (Week 3-4)

**Tier 4: Volunteer Mods** (post-Month 1)
- Recruit active community members as volunteer moderators
- Give them Tier 2 dashboard access
- Train via Slack guide + weekly sync
- Recognize monthly via newsletter + admin badge

#### C. Revised Task: Moderation Dashboard

**Task 4.2 (Admin Dashboard)**: Expand scope
- Add submission moderation queue (not just viewing stats)
- Add automated filtering rules (configurable by admin)
- Add user flagging system
- Add mod volunteer management
- Time: Original 3 hours → **8 hours**

**Breakdown**:
- Moderation queue UI: 3 hours
- Approval/rejection workflow: 2 hours
- User flagging system: 2 hours
- Admin filters config: 1 hour

#### D. Moderation SOP (Document)

**When to Approve**:
- Passes all rubric criteria
- Matches community tone (helpful, not sales-y)
- No plagiarism detected

**When to Reject**:
- Fails rubric (e.g., "try this one weird trick")
- Promotional/spam (includes affiliate links, brand name spam)
- Plagiarized or low-quality copy
- Misinformation or health/safety risk

**When to Request Changes**:
- Good hack, but formatting needs work
- Title unclear, steps not specific enough
- Missing attribution

**When to Ban User**:
- 3+ rejected submissions for spam
- Copyright violation or plagiarism
- Harassment or abuse in comments
- Action: Email user, disable submissions, auto-reject future

---

## GAP #3: User Submissions Timing & Gating (BLOCKER)

### Current Plan Issue
- **MVP (Week 4)**: Full submission form enabled
- **Strategy**: "Community flywheel" starts Week 12
- **Conflict**: If form is live but moderation is weak, you'll get overrun with spam
- **Risk**: Users submit garbage → low quality in database → trust erodes

### Resolution

#### A. Phased Submission Strategy

**Phase 1: Closed (Week 1-4, Pre-Launch)**
- ❌ Disable submission form entirely
- Rely on admin-curated hacks only
- Users cannot submit yet
- Rationale: Build trust with quality content first

**Phase 2: Waitlist (Week 5-7, Soft Launch)**
- ✓ Enable form, but gate behind waitlist
- Accept first 50 users (by email signup)
- Moderation: 1 person, 30 min/day
- Purpose: Test workflow, get early community feedback
- Rationale: Low volume = manageable, high touch

**Phase 3: Beta (Week 8-11, Ramp)**
- ✓ Open to all users, but with friction
- Require email verification + profile setup
- Hacks auto-flagged for review (not auto-published)
- Moderation: 1 paid mod + volunteers if needed
- Rationale: More submissions, manageable with process

**Phase 4: Open (Week 12+, Scale)**
- ✓ Full open submissions
- Auto-publish if passes filters + high-rep user
- Community voting helps surface quality
- Moderation: Reactive (flag + review, not all submissions)
- Rationale: Scale with automation + community

#### B. Submission Form Spec

**What to Build for MVP (Task 3.4 / 4.3)**:

**Phase 1-2 (Waitlist)**:
- Simple form with fields:
  - Hack title (required)
  - Steps (array of text inputs)
  - Why it works (required)
  - Category dropdown
  - Image upload (optional, Cloudinary)
  - Email (pre-filled if logged in)
  - Agree to CC BY 4.0 license (required checkbox)
- No submit button visible (replaced with "Join Waitlist")
- Submit button only visible to waitlist users

**Phase 3 (Beta)**:
- Same form, submit button now visible to all users
- Add field: "Have you tested this hack?" (Yes/No)
- Add: "Will you help moderate?" (Yes/No)
- Add validation: Require > 3 steps, title > 5 words

**Phase 4 (Open)**:
- Same as Phase 3
- Add: Show hacks from "new users" separately (good for trust)

**Implementation**:
- Task 4.3 (Submission Form): Build full form but hide submit button
- Task 4.2 (Admin Dashboard): Add "waitlist" setting toggle
- Task 3.1 (Homepage): Add "Join Waitlist" button (Phase 1-2)

#### C. Decision Framework

**Decision Point 1 (End of Week 1)**: 
- Decide: Phase 1 (closed) or Phase 2 (waitlist) at launch?
- Factors: Moderation capacity, community feedback, content quality
- Recommendation: Start Phase 1 (closed) → shift to Phase 2 (Week 5)

**Decision Point 2 (Week 5)**:
- Evaluate: Are curated hacks getting 2K+ upvotes? Low churn?
- If yes → move to Phase 2 (waitlist)
- If no → stay Phase 1, focus on better seed content

**Decision Point 3 (Week 8)**:
- Evaluate: Do you have 200+ active users? Mod bandwidth?
- If yes → move to Phase 3 (beta)
- If no → stay Phase 2, continue waitlist

---

## GAP #4: Legal & Monetization (BLOCKER)

### Current Plan Issue
- **Strategy**: "Embed Amazon links", "Google AdSense", "Sponsored hacks"
- **Reality**: Missing FTC disclosure rules, attribution requirements, legal review
- **Risk**: FTC violations, DMCA takedowns, lack of credibility

### Resolution

#### A. Attribution & Copyright Compliance

**Required for Every Hack**:
1. Source URL (where did this come from?)
   - Reddit post link
   - Blog URL
   - YouTube video link
   - "Original creator" if user-submitted

2. License/Attribution
   - Reddit: Assume CC BY 3.0 (Reddit's default)
   - Blog: Check site's license (most are © all rights reserved)
   - YouTube: Most creator hacks are © (need permission)
   - User-submitted: Assume CC BY 4.0 (require checkbox)

3. Display on Detail Page:
   ```
   Source: r/lifeprotips (Reddit) | Original post
   Shared under Creative Commons CC BY 3.0
   ```

**Decision**: Don't republish blog/YouTube hacks without explicit permission.
- Stick to Reddit (already public, CC-licensed)
- Link to original for blog/YouTube
- Or: Email creators for permission (time-consuming but legally safe)

**Implementation**:
- Database schema: Add `source_url`, `source_type`, `license_type` fields
- Add to hack detail page: "Source" section with link
- Task 1.1 (Database): Include these fields (adds 1 hour to estimate)
- Task 3.3 (Detail Page): Add source display (adds 1 hour)

#### B. FTC Disclosure Rules

**Required**: Disclose when you have financial interest in a product

**Affiliate Links**:
- Add text above every Amazon link: "**Disclosure**: We may earn a small commission if you purchase through this link at no extra cost to you."
- Or: Use asterisk → link to general affiliate disclosure at footer
- Do NOT hide affiliation or use short links (makes it unclear)

**Sponsored Hacks**:
- Mark with badge: "#AD" or "Sponsored" (clearly visible)
- Add disclaimer: "This hack is sponsored by [Brand]. All opinions are our own."
- Do NOT position as organic if brand paid for placement

**Implementation**:
- Create affiliate disclosure page (20 min)
- Update hack detail template to show affiliate warning (30 min)
- Add "sponsored" badge + field to admin panel (1 hour)

#### C. Monetization Rollout Plan

**Week 1-4 (Pre-Launch)**: No monetization
- Focus on quality, user experience, trust-building

**Week 4-5 (Soft Launch)**: Conservative monetization
- Add affiliate links (Amazon, target-specific products mentioned in hacks)
- Add proper FTC disclosure
- Do NOT enable ads yet
- Do NOT have "sponsored" hacks
- Revenue: Low ($0-100/week)

**Week 8 (Growth Phase)**: Expand monetization
- Apply for Google AdSense (requires 100K monthly visitors, so start Week 5)
- When approved: Add banner + sidebar ads
- Test sponsored hacks with 2-3 trusted brands
- Revenue: $200-500/week if 20K visitors/month

**Month 3 (Scale Phase)**: Premium tier + partnerships
- Launch premium tier ($4.99/month, ad-free)
- Affiliate program for brands
- Newsletter sponsorships
- Revenue: $1-2K/month if 50K+ visitors

**Decision**: Start with affiliate links only. Ads come later.

#### D. Legal Checklist

**Before Launch (Week 3-4)**:
- [ ] Verify attribution on all 300+ curated hacks (20 hours)
- [ ] Create Terms of Service (state fair use for user submissions)
- [ ] Create Privacy Policy (Google Analytics, email list)
- [ ] Write FTC affiliate disclosure page
- [ ] Add copyright notice to footer: "© 2026 Hack Aggregator. Content licensed under CC BY 4.0 where applicable."
- [ ] Set up affiliate account (Amazon Associates) + get tracking links
- [ ] Email YouTube/blog creators asking permission (if using their content)

**Implementation**:
- Legal review task: 10-15 hours (can be founder or lawyer)
- Affiliate setup: 2 hours (Backend dev)
- Disclosure pages: 2 hours (Designer/copywriter)

---

## GAP #5: TikTok Growth Projections (Important But Not Blocker)

### Current Plan Issue
- **Strategy**: 50K TikTok followers by Week 12
- **Reality**: Viral growth is unpredictable; this is optimistic
- **Risk**: Team demoralizes when targets aren't hit

### Resolution

#### A. Revised Growth Targets (Conservative)

| Metric | Original | Revised | Rationale |
|--------|----------|---------|-----------|
| TikTok followers at Week 12 | 50K | 10-20K | Viral is unpredictable; depends on algorithm |
| TikTok followers at Month 3 | — | 30-50K | More realistic with consistency |
| TikTok followers at Month 6 | 150K | 100-150K | Achievable if content quality high |
| Daily TikTok video posts | 1-2 | 1-2 | Realistic with small team |

#### B. Success Metrics That Matter More

Instead of follower count, track:
1. **Engagement Rate** (likes + comments / followers)
   - Viral = 3-5% engagement
   - Healthy = 1-2% engagement
   - Target: Hit 1% by Week 8
   
2. **Click-Through Rate** (links in bio clicks / followers)
   - Track via UTM: `utm_source=tiktok&utm_medium=bio`
   - Target: 0.5-1% (e.g., 1K followers = 5-10 daily clicks)
   
3. **Retention** (repeat visitors from TikTok)
   - Not all clicks = quality traffic
   - Track: Users who return 2+ times in a week
   - Target: 20% retention rate

#### C. Content Strategy (Not Follower Count)

**Focus on**:
- Hack quality (more likely to be saved/shared)
- Consistency (post same time daily = algorithm favors)
- Trending audio (use trending sounds when relevant)
- Calls-to-action ("Link in bio for full hack")
- Series/themes (e.g., "Monday Morning Hacks", "Cooking Fails Fixed")

**Success Example**:
- 5K TikTok followers, 50K views/week
- 3% engagement = high-quality followers
- 1% CTR = 500 daily clicks to site
- Better than 50K followers with 0.1% engagement

**Decision**: Growth comes from consistency + quality, not virality chasing.

---

## GAP #6: Content Quality Rubric (Important But Not Blocker)

### Current Plan Issue
- No rubric defined before curation
- Risk: Inconsistent quality, hard to enforce post-launch

### Resolution

**Already defined in GAP #1, Section B**. This rubric is non-negotiable:

**Shorthand Rubric** (use before launching):
1. **Clarity**: Steps are specific + numbered
2. **Testable**: Average person can attempt it
3. **Beneficial**: Saves time, money, or effort
4. **Unique**: Not a duplicate
5. **Safe**: No health risks (or clearly warned)
6. **Attributed**: Source linked
7. **Formatted**: Title + Steps + Why It Works

**Pass**: All 7 criteria ✓  
**Fail**: Even 1 criterion ✗

**Action**: Create 1-page rubric PDF for team before Week 1 starts.

---

## GAP #7: Technical Debt (Not Blocker, Plan for Month 2)

### Current Plan Issue
- **MVP**: Basic schema, no duplicate detection
- **Reality**: At 500 hacks, duplicates become a problem
- **Risk**: Post-launch, hard to refactor without downtime

### Resolution

#### A. Tackle These in Week 2 (Before Launch)

**1. Duplicate Detection Schema** (2 hours)
- Add `hack_fingerprint` field (hash of title + first 3 steps)
- Query on submit: if fingerprint exists, warn user
- Implementation: Task 1.1 expansion (Database schema)

**2. Search Performance** (3 hours)
- Add indexes on: title, category, created_at
- Test full-text search with 500 hacks
- Task 2.3 (Search & Sorting) already includes this

**3. Pagination** (1 hour)
- Implement cursor-based pagination (not offset)
- Reason: Offset + sorting by votes = slowdown at large offset
- Task 2.2 (Hack CRUD) update

**Total**: 6 hours added to Week 2

#### B. Skip for MVP (Plan for Week 5-8)

- Analytics tracking (Mixpanel, Amplitude)
- Caching layer (Redis)
- Rate limiting (Redis-based)
- Full-text search optimization (PostgreSQL GIN indexes)

**Reason**: Overkill at <50K monthly visitors. Add when needed.

---

## GAP #8: Team Capacity (Not Blocker, Adjust Timeline If Needed)

### Current Plan Issue
- **Assumption**: 6 people, 40 hrs/week, 100% availability
- **Reality**: Most teams have other commitments
- **Risk**: Timeline slips if capacity is lower

### Resolution

#### A. Minimum Viable Team (3-4 People)

| Role | Hours/Week | Tasks |
|------|-----------|-------|
| **Backend Dev** | 40 | API, database, auth, search (Tasks 2.x) |
| **Frontend Dev** | 40 | UI, responsive, voting (Tasks 3.x) |
| **Content Lead** | 40 | Seed 300 hacks, curation (Task 4.1) |
| **Designer/PM** | 20 | Wireframes (Task 1.2), admin dashboard, launch QA |

**Total**: 140 hours/week = 3.5 FTE  
**Duration**: 3 weeks to MVP (vs 4 weeks with 6 people)

#### B. If Capacity is Lower

**Scenario: 2-person team (Backend + Frontend)**
- Cut scope: Launch with 200 hacks (not 500)
- Cut features: No admin panel (use simple Airtable UI)
- Cut design polish: Basic mobile-first (not perfect responsive)
- Timeline: 5-6 weeks to MVP

**Scenario: 1 full-time + part-time support**
- Cut scope further: Launch with 100 hacks, core features only
- Remove: Admin panel, submission form (v2)
- Timeline: 6-8 weeks

**Decision**: Be honest about capacity. Adjust scope, not timeline.

---

## Revised Roadmap & Task Estimates

### Summary: What Changed

| Task | Original | Revised | Reason |
|------|----------|---------|--------|
| 1.1 Database Schema | 4 hrs | 5 hrs | Add duplicate detection + source fields |
| 1.2 Wireframes | 6 hrs | 6 hrs | No change |
| 1.3 API Spec | 3 hrs | 3 hrs | No change |
| 1.4 Dev Setup | 4 hrs | 4 hrs | No change |
| **2.1 Auth** | 6 hrs | 6 hrs | No change |
| **2.2 Hack CRUD** | 6 hrs | 7 hrs | Add cursor pagination |
| **2.3 Search** | 4 hrs | 6 hrs | Add performance indexes |
| **2.4 Admin** | 4 hrs | 8 hrs | Expanded moderation features |
| **2.5 Validation** | 2 hrs | 3 hrs | Add duplicate check, submission gating |
| **3.1 Homepage** | 4 hrs | 4 hrs | No change |
| **3.2 Browse** | 5 hrs | 5 hrs | No change |
| **3.3 Detail** | 4 hrs | 5 hrs | Add source attribution display |
| **3.4 Search UI** | 3 hrs | 3 hrs | No change |
| **3.5 Responsive** | 4 hrs | 4 hrs | No change |
| **3.6 Auth UI** | 3 hrs | 4 hrs | Add waitlist gating logic |
| **4.1 Content Seeding** | 8 hrs | 65 hrs | Realistic curation (40 hrs) + dedup (10 hrs) + verify (10 hrs) + import (5 hrs) |
| **4.2 Admin Dashboard** | 3 hrs | 8 hrs | Add mod queue, filtering, reporting |
| **4.3 Submission Form** | 3 hrs | 5 hrs | Add gating, license checkbox, validation |
| **4.4 Testing & QA** | 6 hrs | 8 hrs | More edge cases + moderation flow testing |
| **4.5 Deploy & Infra** | 4 hrs | 4 hrs | No change (but add legal review separately) |
| **4.6 Launch Prep** | 4 hrs | 4 hrs | No change |
| **NEW: Legal Review** | — | 15 hrs | Attribution, FTC disclosure, T&C, privacy policy |
| **NEW: Content Rubric** | — | 2 hrs | Create rubric doc, train team |

**Sprint 1 Total**: 19 hours → 21 hours (no change)  
**Sprint 2 Total**: 22 hours → 30 hours (+8 for expanded moderation)  
**Sprint 3 Total**: 23 hours → 25 hours (+2 for attribution display)  
**Sprint 4 Total**: 29 hours → 111 hours (65 for content seeding + 15 for legal + updates)

**Grand Total**: 93 hours → 187 hours (+94 hours)

### Recommended Team Allocation

**Week 1-2 (Design & Setup)**:
- Backend Dev: 40 hrs (database, API spec, auth foundation)
- Frontend Dev: 40 hrs (wireframes, component setup)
- Content Lead: 40 hrs (research sources, start curation)
- Designer: 20 hrs (wireframe polish, component system)
- **Total**: 140 hrs (3.5 FTE)

**Week 2-3 (Backend)**:
- Backend Dev: 40 hrs (API, search, moderation features)
- Frontend Dev: 40 hrs (start UI build)
- Content Lead: 40 hrs (finish curation, deduplication)
- **Total**: 120 hrs (3 FTE)

**Week 3-4 (Frontend & Content)**:
- Backend Dev: 40 hrs (testing, deployment prep)
- Frontend Dev: 40 hrs (UI completion, responsive)
- Content Lead: 40 hrs (verification, import, legal support)
- Designer: 20 hrs (polish, final QA)
- Legal: 15 hrs (T&C, privacy policy, FTC disclosure) — can be external
- **Total**: 155 hrs (4 FTE + external legal)

**Revised Timeline**: 4 weeks (same as original, with realistic estimates)

---

## Decisions Required This Week

### Decision 1: Content Launch Strategy
**Options**:
- A) Conservative: 300 quality hacks (recommended)
- B) Ambitious: 500 hacks (aggressive, requires 65+ hrs confirmed)

**Owner**: Content Lead + PM  
**Deadline**: EOW (decide before Week 1 starts)

### Decision 2: Submission Gating
**Options**:
- A) Closed at launch (Phase 1 only, no submissions Week 1-4)
- B) Waitlist at launch (Phase 2, 50 users Week 5)
- C) Open at launch (Phase 3 risk, spam likely)

**Owner**: PM + Moderation Lead  
**Deadline**: EOW (determines Task 4.3 scope)

### Decision 3: Monetization at Launch
**Options**:
- A) None (focus on traffic first)
- B) Affiliate links only + FTC disclosure
- C) Ads + affiliate (requires AdSense approval first)

**Owner**: PM + Legal  
**Deadline**: EOW (determines legal review scope)

### Decision 4: Team Capacity
**Do we have**:
- [ ] 1 full-time Backend Dev (40 hrs/week, Weeks 1-4)
- [ ] 1 full-time Frontend Dev (40 hrs/week, Weeks 1-4)
- [ ] 1 full-time Content Lead (40 hrs/week, Weeks 1-4)
- [ ] 1 part-time Designer (20 hrs/week, Weeks 1-2, 4)
- [ ] Access to external legal (10-15 hrs, Weeks 2-4)

**Owner**: Project Manager  
**Deadline**: EOW (adjust timeline if not available)

---

## Appendix A: Spam Keywords (Auto-Filter)

Words/phrases that trigger auto-rejection for user submissions:
- "make money fast", "get rich", "crypto", "NFT"
- "click here", "limited time", "act now"
- "dm for details", "link in bio"
- "sponsored", "ad", "affiliate"
- URLs (unless in proper attribution field)
- EXCESSIVE CAPS or emoji spam

---

## Next Steps

1. **Day 1**: Share this document with team
2. **Day 2**: Team discusses & makes 4 decisions above
3. **Day 3**: Update task list with revised estimates
4. **Day 4**: Content Lead starts curation work
5. **Day 5**: First team sync on progress

---

**Status**: Ready for Sprint 1 kickoff  
**Last Review**: 2026-04-28
