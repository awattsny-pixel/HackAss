# HackAss Development Lessons Learned

## Product Strategy vs Technical Execution

**Rule:** ChatGPT's product strategy and Claude's technical roadmap are complementary, not competitive.

**Why:** ChatGPT provided strategic insights (truth-quality ranking, cold-start seeding, App Store playbook) that don't touch the code layer. Claude's auth/submission infrastructure doesn't address product positioning. Both needed.

**How to apply:** When evaluating new features or pivots, separate "what should we build?" (product) from "how do we build it?" (technical). Different questions, different expertise.

**Lesson source:** Integrating ChatGPT analysis revealed the plans addressed orthogonal problems. Treating them as competing was the mistake.

---

## Cold-Start Problem: Seed Data as Moat

**Rule:** Do NOT bulk-import user content at launch. Instead, build a curated problem space with validated solutions.

**Why:** Bulk imports feel incomplete and untrustworthy. Curated seed data signals "this is a real, organized tool."

**How to apply:**
1. Identify high-frequency user problems (100 core problems)
2. Curate realistic solutions (3-5 per problem)
3. Add REALISTIC validation signals (not inflated)
4. Let user submissions gradually replace seed data

**Lesson source:** Comparing "bulk Reddit import" vs "100-problem scaffold" revealed that curation matters more than volume for trust signals.

---

## Ranking Algorithm: Weighting the Signals

**Rule:** Success rate should dominate ranking (50%), not engagement.

**Why:** Engagement (upvotes) is easy to game. Outcome validation (worked/failed) is hard to fake.

**How to apply:**
- Success rate: 50% — If it doesn't work, nothing else matters
- Replication density: 30% — Multiple people validating > single upvoter
- Engagement: 10% — Weak tie-breaker, easy to game
- Recency: 10% — Prevents stagnation without permanent penalty

**Lesson source:** Designing the ranking formula forced clarity on what "truth" means in your platform. Success % is the only signal that can't be gamed.

---

## Realistic Validation Signals

**Rule:** Seed data signals must pass the sniff test (verify-able in real world).

**Why:** Fake signals undermine credibility. If users realize signals are artificial, they stop trusting the ranking.

**How to apply:**
- Success rate range: 70-95% (not 99%)
- Failed votes: Always 2-5% (realism, not perfection)
- Validators: 2-8x worked votes (typical user behavior ratio)
- Upvotes: Higher than worked votes (people upvote more than validate)
- No solution over 250 worked votes (prevents artificial inflation)

**Lesson source:** When creating seed data, realized inflated signals would be immediately obvious to users. Realism > volume.

---

## File Organization: Data vs Code vs Docs

**Rule:** Keep data (JSON) separate from code (TypeScript) separate from strategy (Markdown).

**Why:** Different update cadences and ownership. Data changes; code rarely does; strategy documents evolve.

**How to apply:**
```
data/                    ← Content (problems, solutions, seed data)
app/lib/               ← Algorithms (ranking, validation)
pages/api/             ← Endpoints (feed, ranking, validation)
docs/                  ← Strategy (content strategy, launch playbook)
scripts/               ← Tools (seeding, migrations, reporting)
```

**Lesson source:** Organizing seed files separately made it clear they're content, not code. Different skill to maintain them.

---

## Idempotent Scripts: Safe to Re-Run

**Rule:** Database scripts must be idempotent (safe to run multiple times).

**Why:** Mistakes happen. Deployments retry. You don't want duplicate data from a script re-run.

**How to apply:**
1. Check if data already exists before inserting
2. Use unique keys to prevent duplicates
3. Log what you're doing (makes debugging easier)
4. Exit gracefully if data already seeded

**Lesson source:** seed-database.ts explicitly checks for existing hacks. Critical for production safety.

---

## Metrics Drive Product Decisions

**Rule:** Decide what to measure BEFORE launching, not after.

**Why:** You can't retrofit metrics onto a live product. You need baseline data.

**How to apply:**
- Week 3: Feed completeness, load times, ranking quality
- Week 4: Day-1 retention, validation rate, category stickiness
- Week 5+: Organic growth rate, seed data decay speed, contribution conversion

**Lesson source:** CONTENT_STRATEGY.md forced clarity on what "success" looks like. Retention > feature count.

---

## Weekly Planning: 3-Phase Integration

**Rule:** Break big integrations into priorities (1, 2, 3) and tie to weekly milestones.

**Why:** Prevents overwhelm. Makes progress visible. Allows course correction mid-week.

**How to apply:**
- Priority 1 (Week 1): Foundation (seed data, algorithm)
- Priority 2 (Week 2-3): Integration (validation UI, endpoints)
- Priority 3 (Week 4+): Polish (anti-gaming, metrics, monetization)

**Lesson source:** INTEGRATION_PLAN.md structured the work into manageable phases. Clarity on dependencies (Priority 1 blocks nothing, enables 2, enables 3).

---

## Explaining the Why: Documentation Matters

**Rule:** Always explain WHY a decision was made, not just WHAT was built.

**Why:** Future-you won't remember the context. Future-teammates need to understand tradeoffs.

**How to apply:**
- "Why not bulk Reddit import?" → Problem-first is more strategic
- "Why 50% weight on success rate?" → Outcome validation can't be gamed
- "Why 100 problems, not 500?" → Curation > volume for trust

**Lesson source:** hack-ranking.ts and CONTENT_STRATEGY.md include full explanations. Makes it easy to adjust later.

---

## Status: Integrate ChatGPT Strategy Into Technical Roadmap

**Completed:** ✅
- Analysis done (CHATGPT_VS_CLAUDE_ANALYSIS.md)
- Integration plan written (INTEGRATION_PLAN.md)
- Priority 1 executed (seed data, ranking algorithm)
- Content strategy documented (CONTENT_STRATEGY.md)

**Next:** Priority 2 (ValidationPrompt, ranking endpoint, App Store metadata)
