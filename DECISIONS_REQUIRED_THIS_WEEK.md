# Hack Aggregator: Critical Decisions Required This Week

**Status**: Blocking Sprint 1 start  
**Deadline**: End of Week (April 28-May 2)  
**Owner**: Project Leadership  
**Action**: Sync with team, make 4 decisions, update task list

---

## Context

Deep review of original plan identified **8 gaps**. 4 are **blockers** that require decisions before Sprint 1 Day 1:

1. **Content seeding**: 8 hours → 65 hours (realistic estimate)
2. **Moderation capacity**: 2x daily → phased approach (closed → waitlist → open)
3. **Submission gating**: Enable at launch? (risks spam) Or gate until ready? (safer)
4. **Legal & monetization**: Which revenue model at launch? (affects scope)

**Supporting documents**:
- `GAP_RESOLUTION.md` — detailed specs for all 8 gaps
- `COWORK_PROJECT_TASKS_REVISED.txt` — updated tasks with realistic hours

---

## Decision 1: Content Launch Strategy

**Question**: How many quality hacks do we launch with?

### Option A: Conservative (RECOMMENDED)
- **Target**: 300 hacks at launch
- **Timeline**: 65 hours of curation (Week 1-4)
- **Quality**: High (all pass rubric, verified)
- **Risk**: Smaller catalog, but trust-building
- **Growth**: Users add hacks post-launch via submissions
- **Moderation**: Lower burden initially

### Option B: Ambitious
- **Target**: 500 hacks at launch
- **Timeline**: 65 hours (same, compressed)
- **Quality**: Medium-high (may skip some rubric checks)
- **Risk**: More spam, higher moderation burden
- **Growth**: Larger initial catalog
- **Requires**: Content Lead 100% committed, verified availability

### Recommendation
**Option A (Conservative)**.

**Why**: 300 high-quality hacks launch trust. 500 mediocre hacks erode trust. Users will submit 100+ more in first month anyway. Better to start strong.

### Your Call
**Choose one**:
- [ ] Option A (300 hacks, quality focus)
- [ ] Option B (500 hacks, growth focus)

**Owner**: Content Lead + PM  
**Impact**: Task 4.1 scope (65 vs 70+ hours, same duration)

---

## Decision 2: User Submission Timing (Gating Strategy)

**Question**: Should users be able to submit hacks at launch?

### Option A: Closed at Launch (RECOMMENDED)
- **Phase 1** (Weeks 1-4): Submission form hidden entirely
- **What users see**: "Coming soon" or no form
- **When to enable**: Week 5 after soft launch successful
- **Reason**: No moderation capacity yet, avoid spam explosion
- **Risk**: Users expect to submit, may leave disappointed
- **Upside**: Clean launch, quality hacks only

### Option B: Waitlist at Launch
- **Phase 2** (Weeks 1-4): Form visible, but "Join Waitlist" button (not submit)
- **Phase 2a** (Week 5): First 50 users can submit (gated)
- **Why**: Builds anticipation, gets early feedback
- **Risk**: Waitlist users expect to submit Week 1, they can't
- **Upside**: Community feedback, early adopters excited

### Option C: Open at Launch (NOT RECOMMENDED)
- **Phase 3** (Week 1): Form live to all users
- **Risk**: 100+ spam submissions by Day 3, overwhelms moderation
- **Upside**: No one feels excluded
- **Downside**: Moderation disaster

### Recommendation
**Option A → Option B transition**.
- **Week 1-4**: Closed (Phase 1)
- **Week 5**: Open waitlist (Phase 2, 50 users)
- **Week 8**: Open to all (Phase 3, after 200K+ hacks curated + mods ready)

### Your Call
**Choose one**:
- [ ] Option A (Closed at launch)
- [ ] Option B (Waitlist at launch)
- [ ] Option C (Open at launch - not recommended)

**Owner**: PM + Backend Lead  
**Impact**: Task 3.6 (Auth UI), Task 4.3 (Submission Form) scope  
**Timeline**: Affects when to build submission gating logic (Week 1 or Week 2)

---

## Decision 3: Monetization Strategy at Launch

**Question**: What's the revenue model on Day 1?

### Option A: No Monetization (RECOMMENDED)
- **Launch strategy**: No ads, no affiliate, no sponsored
- **Why**: Focus on product + traffic first
- **When to monetize**: Week 8+ (when 20K+ visitors/month)
- **Time saved**: No legal review needed (beyond basic T&C)
- **Risk**: Opportunity cost (could earn small amount immediately)
- **Upside**: Focuses team on growth, not revenue

### Option B: Affiliate Links Only (GOOD MIDDLE GROUND)
- **Launch strategy**: Amazon affiliate links in hacks (with proper disclosure)
- **FTC compliance**: Add "Affiliate Disclosure" section to footer
- **Revenue**: $50-200/month if 5K visitors/month
- **Effort**: 3 hours legal review (FTC + affiliate T&C)
- **Upside**: Early revenue, minimal friction
- **Risk**: Users see affiliate links, may perceive as sales-y

### Option C: Ads + Affiliate (NOT READY)
- **Problem**: Google AdSense requires 100K+ monthly visitors + months approval
- **Timeline**: Can't be ready Week 1
- **Option**: Apply Week 5, go live Week 8 if approved
- **Not recommended for launch day**

### Recommendation
**Option B (Affiliate links only)**.

**Why**: 
- Generate small revenue immediately ($50-200/month)
- Proper FTC disclosure = legal safety
- Users expect affiliate links on hack sites
- Don't try ads yet (won't qualify, slows approval)

**Legal work needed**:
- Create FTC affiliate disclosure page (1 hour)
- Update Terms of Service to mention affiliate links (1 hour)
- Create Privacy Policy (2 hours)
- Add affiliate links to top 50 hacks (2 hours)
- **Total**: 6 hours (doable in Week 3-4)

### Your Call
**Choose one**:
- [ ] Option A (No monetization, focus on growth)
- [ ] Option B (Affiliate links + FTC disclosure)
- [ ] Option C (Ads + affiliate - punt to Week 8)

**Owner**: PM + Legal  
**Impact**: Task 4.5 scope (legal review), Task 4.6 (launch prep), revenue timeline

---

## Decision 4: Confirm Team Capacity

**Question**: Do we have the people to execute this?

### Required for 4-Week MVP (3.5 FTE)
- [ ] **Backend Dev**: 40 hrs/week, Weeks 1-4, available NOW?
- [ ] **Frontend Dev**: 40 hrs/week, Weeks 1-4, available NOW?
- [ ] **Content Lead**: 40 hrs/week, Weeks 1-4, available NOW?
- [ ] **Designer (PT)**: 20 hrs/week, Weeks 1-2 + 4, available NOW?
- [ ] **Legal Support**: 10-15 hrs, Weeks 2-4 (internal or external)?

### If Someone is Missing
**Adjust timeline**:
- 2 FTE (Backend + Frontend only): 6 weeks, smaller scope (200 hacks)
- No designer: 5 weeks, basic responsive design (skip polish)
- No content lead: 6-8 weeks, 200 hacks (part-time curation)

### If Capacity is Lower
**Decisions**:
- Reduce content: 200 hacks instead of 300 (saves 20 hours)
- Reduce scope: No admin panel or moderation dashboard in MVP (saves 8 hours)
- Extend timeline: 5-6 weeks instead of 4

### Your Call
**Confirm**:
- [ ] Backend Dev: Name + capacity commitment
- [ ] Frontend Dev: Name + capacity commitment
- [ ] Content Lead: Name + capacity commitment
- [ ] Designer: Name + capacity commitment
- [ ] Legal: Internal or external? Budget?

**Owner**: Project Manager  
**Impact**: Timeline (if anyone missing, add 1-2 weeks)

---

## Decision Summary

| Decision | Option A | Option B | Option C | Recommended |
|----------|----------|----------|----------|-------------|
| Content | 300 hacks | 500 hacks | — | **A** |
| Submissions | Closed | Waitlist | Open | **A** → **B** (Week 5) |
| Monetization | None | Affiliate | Ads | **B** |
| Team | 3.5 FTE | Lower | — | **Confirm 3.5 FTE** |

---

## Next Steps (Do This)

### Today (Monday)
- [ ] Copy this doc to Slack + project channel
- [ ] Schedule 1-hour decision sync with leadership team

### Decision Sync (Tuesday-Wednesday)
- [ ] Go through 4 decisions with team
- [ ] Assign decision owner to each
- [ ] Lock choices by EOD Wednesday

### Update Tasks (Thursday)
- [ ] Copy decisions to `COWORK_PROJECT_TASKS_REVISED.txt`
- [ ] Brief team on revised estimates (187 hours total)
- [ ] Create Jira/Cowork tickets with new scopes

### Kickoff Ready (Friday)
- [ ] Day 1 of Sprint 1: Ready to start
- [ ] Content Lead: Rubric created, Airtable ready
- [ ] Backend Dev: Database schema design started
- [ ] Frontend Dev: Wireframes in progress

---

## Risk Checklist

**If you choose Option A + Option A + Option B + 3.5 FTE**:
- ✓ Conservative launch (safest bet)
- ✓ Realistic timeline (4 weeks, no crunch)
- ✓ Quality-focused (300 great hacks vs 500 mediocre)
- ✓ Growth-focused TikTok (realistic 5-10K followers)
- ✓ Early revenue (small, but proves model)
- ✓ Scalable moderation (phased approach)

**Risks you're accepting**:
- Smaller initial catalog (but users add more)
- No ads at launch (but fine, focus on growth)
- Slower viral growth (but consistent is better)

---

## Questions?

**Read**: `GAP_RESOLUTION.md` (detailed specs for each gap)  
**Read**: `COWORK_PROJECT_TASKS_REVISED.txt` (full task list with estimates)  
**Ask**: Tag @pm in Slack with questions

---

**Due**: Decisions locked by EOD Wednesday, May 1st  
**Kickoff**: Sprint 1 starts Monday, May 5th
