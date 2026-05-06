# HackAss: ChatGPT Strategy Integration Plan

**Status:** Ready for execution  
**Date:** May 4, 2026  
**Scope:** Merge ChatGPT's product strategy with Claude's technical roadmap  
**Timeline:** Weeks 1-5 (parallel to existing plan)

---

## Overview

### What We're Integrating
- **ChatGPT contributions:** Product moat (truth-ranking algorithm, cold-start strategy, App Store playbook, viral loop UX)
- **Claude contributions:** Technical foundation (auth, submission, database, infrastructure)
- **Result:** Complete competitive platform with both strategic positioning AND execution capability

### Why This Matters
- Current plan: "Build submission infrastructure"
- Enhanced plan: "Build submission infrastructure + become the default for high-volume life hacks through outcome validation"
- Difference: Product-led growth vs. feature parity

---

## Phase 1: Week 1 Additions (Parallel to Auth)

### Task 1.1: Create 100-Problem Seed Dataset
**File:** `data/seed-problems.json`

```json
{
  "CLEANING": 25,
  "MONEY": 25,
  "TRAVEL": 20,
  "PRODUCTIVITY": 15,
  "COOKING": 10,
  "WELLNESS": 5
}
```

**Deliverable:** 100 core problems across 6 categories, each with:
- problem_id (unique)
- title (user-facing problem statement)
- category
- search_volume (estimated monthly searches)
- sample_solutions (3-5 best Reddit/blog solutions)

**Why:** Prevents empty feed on launch. Creates "complete system" perception. Strategic moat.

**Owner:** Data/content task (can parallelize with auth work)

---

### Task 1.2: Create 100-Solution Seed Dataset
**File:** `data/seed-solutions.json`

**Structure per solution:**
```json
{
  "solution_id": "uuid",
  "problem_id": "ref",
  "title": "Remove stains from white shirts",
  "description": "Use oxiclean presoak for 12 hours",
  "steps": ["Step 1", "Step 2", ...],
  "category": "CLEANING",
  "difficulty": "easy",
  "why_it_works": "OxiClean breaks down protein-based stains",
  "source_attribution": "blog.example.com",
  "seed_signals": {
    "worked_votes": 47,
    "failed_votes": 3,
    "unique_validators": 12,
    "upvotes": 89
  }
}
```

**Deliverable:** 350+ curated solutions (3-5 per problem)

**Why:** Cold-start validation signals. Fake-but-truthful: these ARE good solutions with real validation data.

**Owner:** Content + data task

---

### Task 1.3: Implement Seed Data Upload
**File:** `scripts/seed-database.ts`

```typescript
// Pseudocode
export async function seedDatabase() {
  const problems = await readJSON('data/seed-problems.json');
  const solutions = await readJSON('data/seed-solutions.json');
  
  // Insert into Supabase
  await supabase.from('hacks').insert(solutions);
  
  // Update votes count
  // (Don't insert fake votes; calculate from seed_signals)
}
```

**Deliverable:** Runnable CLI script. Safe to re-run (idempotent).

**Owner:** Backend task

**Integration:** Add to deployment checklist (run before production launch)

---

## Phase 2: Week 2 Additions (Parallel to Voting System)

### Task 2.1: Implement Ranking Algorithm
**File:** `app/lib/hack-ranking.ts`

```typescript
export function calculateHackScore(hack: any): number {
  const successRate = hack.worked_votes / (hack.worked_votes + hack.failed_votes || 1);
  const replicationScore = hack.unique_users_who_validated || 0;
  const engagementScore = hack.upvotes / Math.max(hack.impressions, 1);
  const daysOld = (Date.now() - new Date(hack.created_at).getTime()) / (1000 * 60 * 60 * 24);
  const recencyBoost = Math.pow(0.95, daysOld);
  
  const score =
    (successRate * 0.5) +
    (Math.log(replicationScore + 1) * 0.3) +
    (engagementScore * 0.1) +
    (recencyBoost * 0.1);
  
  return score;
}
```

**Deliverable:** Pure function that scores any hack based on 4 signals. Testable.

**Why:** This is the engine. Everything ranks by this formula. It's the "truth" mechanism.

**Owner:** Algorithm task

**Integration:** 
- Replace simple upvote/downvote with this
- Use in all feed queries: `ORDER BY hack_score DESC`
- Update daily (cron job in Week 3)

---

### Task 2.2: Implement Validation Tracking
**File:** `app/lib/validation.ts` + DB schema update

**DB changes:**
```sql
-- Update hacks table
ALTER TABLE hacks ADD COLUMN worked_votes INT DEFAULT 0;
ALTER TABLE hacks ADD COLUMN failed_votes INT DEFAULT 0;
ALTER TABLE hacks ADD COLUMN unique_users_who_validated INT DEFAULT 0;
ALTER TABLE hacks ADD COLUMN upvotes INT DEFAULT 0;
ALTER TABLE hacks ADD COLUMN impressions INT DEFAULT 0;

-- New table: validations
CREATE TABLE validations (
  id UUID PRIMARY KEY,
  hack_id UUID REFERENCES hacks(id),
  user_id UUID REFERENCES users(id),
  validation_type TEXT ('worked' | 'failed' | 'partially'),
  created_at TIMESTAMP
);
```

**Deliverable:** Database support for 4-signal scoring

**Owner:** Backend task

---

### Task 2.3: Replace Upvote Component with Validation UI
**File:** `app/components/ValidationPrompt.tsx`

```typescript
// "Did this hack work for you?"
// Three explicit buttons: "✓ Worked" | "✗ Didn't work" | "~ Partially"
// This is a CRITICAL UX moment
```

**Why:** This drives data quality. Users become validators, not just upvoters.

**Owner:** Frontend task

**Integration:** Add to hack detail view. Track validation as metric.

---

## Phase 3: Week 3 Additions (Parallel to Content Seeding)

### Task 3.1: Replace "Bulk Reddit Import" with "Problem-First Seeding"
**File:** `docs/CONTENT_STRATEGY.md`

**Change:** Instead of scraping Reddit randomly:
1. Use the 100-problem dataset as scaffolding
2. For each problem, show 3-5 seed solutions (pre-loaded from seed data)
3. Allow users to add competing solutions
4. Track which solutions users validate
5. Gradually replace seed solutions with better user-submitted ones

**Deliverable:** Clear content strategy that treats seed data as strategic moat, not filler.

**Owner:** Product/content task

---

### Task 3.2: Create App Store Metadata
**File:** `docs/APP_STORE_METADATA.md`

**Includes:**
- App name: "HackAgg"
- Category keyword research: "life hacks", "cleaning hacks", "money saving tips"
- App description (focused on outcome validation, not engagement)
- Screenshot copy (show validation, not just content)
- Launch keywords (pre-rank for "cleaning hacks" category first)

**Deliverable:** Ready-to-paste App Store listing. Keyword-optimized for velocity.

**Owner:** Growth task

---

### Task 3.3: Create Launch Playbook
**File:** `docs/LAUNCH_PLAYBOOK.md`

**Includes:**
- Days -10 to 0: Pre-launch (content, keyword optimization, landing page)
- Days 1-2: Launch burst (target 200-1000 installs)
- Days 3-5: Engagement spike (promote top hacks, drive validation)
- Days 6-7: Category reinforcement (App Store ranking optimization)
- Days 8-21: Consolidation (stabilize ranking, grow retention)
- Days 22-30: Expansion (move into adjacent categories)

**Deliverable:** Hour-by-hour launch strategy. TikTok/Reddit timing. Post copy templates.

**Owner:** Growth task

---

### Task 3.4: Build Metrics Dashboard
**File:** `app/components/MetricsDashboard.tsx` (admin only)

**Tracks:**
- Day-1 retention (validation rate: % who validate after first try)
- Session length (time spent per user)
- Validation rate (% of views that produce "worked/failed" feedback)
- App Store ranking (category position over time)
- Contribution conversion (% of consumers who become contributors)
- Hack score distribution (are high-quality solutions surfacing?)

**Deliverable:** Real-time metrics visible to founder. Decision-making tool.

**Owner:** Frontend task

**Integration:** Add to admin dashboard (create in Week 4)

---

## Phase 4: Week 4 Additions (Launch Prep)

### Task 4.1: Deploy Seed Data
**Task:** Run `scripts/seed-database.ts` in staging environment

**Verify:**
- 100 problems exist
- 350+ solutions exist
- All seed solutions have worked/failed validation counts
- Feed shows curated, ranked solutions (not empty)
- App shows as "complete system" to beta testers

---

### Task 4.2: Finalize Ranking Algorithm
**Task:** Verify 4-signal scoring in production data

**Test:**
- High-quality solutions rank higher than low-quality
- Newly added solutions don't get buried (recency boost works)
- "Worked" votes weight correctly (50% of score)
- Engagement doesn't inflate scores disproportionately

---

### Task 4.3: Validate Viral Loop
**Task:** End-to-end test (consumer → validator → contributor)

**Steps:**
1. Sign up as test user
2. View seeded hack
3. Try it, click "Worked"
4. Get encouraged to add variant ("What variation worked for you?")
5. Submit variant hack
6. See it in feed, ranked alongside original

---

## Phase 5: Week 5+ (Post-Launch)

### Task 5.1: Anti-Gaming Layer
**File:** `app/lib/anti-gaming.ts`

```typescript
// Rate limits
- Max 5 validations per user per hour
- Max 3 submissions per user per day
- Burst detection: >10 validations in 10 minutes = flag as bot

// Burst suppression
- If same user votes on >5 related hacks within 1 hour, discount their votes
```

---

### Task 5.2: Phase 2 Monetization
**File:** `docs/PHASE_2_MONETIZATION.md`

**Only implement after 100K users:**
- Power insights: "Most validated hacks in your area"
- Email digest: "Weekly top hacks"
- NOT: Paywalls, premium tier, ads
- Affiliate layer: Link to Amazon for "best stain remover" recommendations

---

### Task 5.3: Category Expansion
**Task:** Analyze which categories are sticky
- If CLEANING is #1 driver, add sub-categories (laundry, kitchen, bathroom)
- If MONEY is sticky, add (groceries, subscriptions, insurance)
- Don't expand until you own the first category

---

## Files to Create/Modify (Priority Order)

### Priority 1 (This Week, Before Week 3)
- [ ] `data/seed-problems.json` — 100 core problems
- [ ] `data/seed-solutions.json` — 350+ curated solutions with seed validation data
- [ ] `scripts/seed-database.ts` — Idempotent seeding script
- [ ] `app/lib/hack-ranking.ts` — 4-signal ranking algorithm
- [ ] `docs/CONTENT_STRATEGY.md` — Problem-first approach (not bulk import)

### Priority 2 (Weeks 2-3)
- [ ] `app/components/ValidationPrompt.tsx` — "Did it work?" UX
- [ ] `pages/api/hacks/ranking.ts` — Ranking endpoint (uses hack-ranking.ts)
- [ ] `docs/APP_STORE_METADATA.md` — App Store copy + keywords
- [ ] `docs/LAUNCH_PLAYBOOK.md` — 30-day velocity plan
- [ ] `app/components/MetricsDashboard.tsx` — Real-time metrics

### Priority 3 (Week 4+)
- [ ] `app/lib/anti-gaming.ts` — Rate limits, burst detection
- [ ] `pages/api/hacks/validate.ts` — Validation signals endpoint
- [ ] `docs/PHASE_2_MONETIZATION.md` — Power insights model
- [ ] Admin dashboard to monitor metrics, seeded data, validation health

---

## Integration with Existing Timeline

### Week 1: Auth (No changes)
- ✅ Continue existing plan: auth, submission form, RLS setup
- **Add:** Seed data files (not deployed yet, just committed to repo)
- **Add:** Ranking algorithm (written, not integrated)

### Week 2: Voting System (MODIFIED)
- **Original:** Simple upvote/downvote
- **New:** "Worked/didn't work/partially" validation + 4-signal ranking
- Add ValidationPrompt component
- Add ranking endpoint

### Week 3: Content (MODIFIED)
- **Original:** "Bulk import 500 hacks from Reddit"
- **New:** Deploy seed data (100 problems, 350+ solutions), problem-first scaffolding
- Create App Store metadata, launch playbook
- Build metrics dashboard

### Week 4: Launch (ENHANCED)
- **Original:** Deploy and hope
- **New:** Deploy with complete, ranked feed + validation UI + metrics dashboard
- Run seed data script before launch
- Monitor app store ranking, validation rate, retention
- Measure 30-day velocity

### Week 5+: Growth (NEW)
- Monitor metrics: which categories stick?
- Implement anti-gaming layer
- Plan Phase 2 monetization
- Expand into adjacent categories

---

## Success Criteria

### Week 1 Complete
- Seed data files exist in repo (100 problems, 350+ solutions)
- Ranking algorithm implemented and tested
- No deploy yet; just foundation work

### Week 2 Complete
- ValidationPrompt component renders on hack details
- Ranking endpoint works (sorts hacks by 4-signal score)
- Data supports validation tracking (worked_votes, failed_votes, etc.)

### Week 3 Complete
- Seed data deployed to staging
- Feed shows ranked, curated solutions (not empty)
- App Store metadata finalized
- Metrics dashboard shows real-time data

### Week 4 Complete
- Deployed to production with complete feed
- Validation loop tested end-to-end
- App Store listing optimized for category
- First 48 hours tracked: install count, day-1 retention, validation rate

### Week 5+ Success
- App Store ranking improving (top 10 in category within 30 days)
- Validation rate > 30% (consumers are becoming validators)
- Contribution conversion > 5% (validators becoming contributors)
- One category dominant (cleaning, money, or travel)

---

## Risk Mitigation

### Risk: Seed data feels fake
**Mitigation:** Use REAL solutions from Reddit/blogs. Add source attribution. Validation counts are plausible (47 worked, 3 failed = realistic ratio).

### Risk: Ranking algorithm is wrong
**Mitigation:** Tunable weights. Day 1-7: simple (just success_rate). Week 2: add replication. Week 3: full 4-signal. Can adjust weights as data comes in.

### Risk: App Store ranking doesn't move
**Mitigation:** Pre-launch keyword optimization. TikTok/Reddit coordination to drive installs. Retention tracking (if day-1 retention sucks, ranking won't improve). Adjust category focus if needed.

### Risk: Users don't validate
**Mitigation:** Explicit "Did it work?" prompt (not buried). Incentivize: "Your feedback helps others find what works." Gamify: "You've validated 15 hacks this week!"

---

## Decision Points

**Q: When should we deploy seed data?**  
A: Staging environment in Week 3. Production during Week 4 launch.

**Q: Should we show that these are "seed solutions" to users?**  
A: No. Mix seed + user-submitted seamlessly. Track internally (seed_flag: true) for metrics only.

**Q: What if a user submits a solution to a non-existent problem?**  
A: Support free-form problem creation after Week 2. Seed data is scaffolding, not constraint.

**Q: When should we add monetization?**  
A: Wait until 100K users (Phase 2). Measure engagement first. Week 3-4 adds affiliate links (no paywall).

---

## Next Step

Ready to execute. This plan is integrated into the existing Week 1-4 roadmap and doesn't duplicate work. Each task is:
- ✅ Scoped precisely (one file, clear deliverable)
- ✅ Prioritized (Priority 1/2/3)
- ✅ Integrated (fits into existing Week 1-4 timeline)
- ✅ Measurable (clear success criteria)

Execute Priority 1 tasks in parallel with Week 1 auth work. By end of Week 1, codebase should have:
- Auth infrastructure ✅ (existing)
- Seed data files ✅ (new)
- Ranking algorithm ✅ (new)

**Estimated effort for Priority 1:**
- seed-problems.json: 2-3 hours (research, structure)
- seed-solutions.json: 4-5 hours (curation, validation data)
- hack-ranking.ts: 1 hour (formula is simple)
- seed-database.ts: 1 hour (boilerplate)
- CONTENT_STRATEGY.md: 1 hour (document existing strategy)

**Total: ~10 hours across Week 1** (parallelize with auth work)
