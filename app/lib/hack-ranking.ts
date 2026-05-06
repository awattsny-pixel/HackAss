/**
 * Hack Ranking Algorithm (Revised)
 *
 * Truth Quality Engine: Ranks hacks by outcome validation, not engagement
 *
 * Key improvements:
 * 1. Validator threshold: Prevents low-sample solutions from ranking too high
 *    - <5 validators: 90% penalty (heavily discount)
 *    - <10 validators: 50% penalty (moderately discount)
 *    - 10+ validators: Full score (trusted threshold)
 *
 * 2. Quality-conditional recency decay: High-quality solutions stay visible longer
 *    - 95%+ success rate: Use 0.98 decay (slower) - stays visible 2x longer
 *    - 80-95% success rate: Use 0.95 decay (normal)
 *    - <80% success rate: Use 0.90 decay (faster) - removed quicker
 *
 * 3. Weight distribution (unchanged):
 *    - Success rate: 50% (outcome validation > everything else)
 *    - Replication density: 30% (breadth of real use)
 *    - Engagement: 10% (weak signal, easy to game)
 *    - Recency: 10% (freshness, prevents stagnation)
 */

export interface HackData {
  id: string;
  title: string;
  created_at: string;
  worked_votes: number;
  failed_votes: number;
  unique_users_who_validated: number;
  upvotes: number;
  impressions: number;
}

/**
 * Calculate the quality score for a hack based on 4 signals + validator threshold
 *
 * Prevents two failure modes:
 * 1. Niche hacks (5 successes, 0 failures = 100%) ranking above mainstream hacks (100 successes, 5 failures = 95%)
 * 2. Old high-quality hacks getting buried while new unvalidated hacks appear
 *
 * @param hack - Hack data with validation metrics
 * @returns Number score (0-1, roughly) for ranking
 */
export function calculateHackScore(hack: HackData): number {
  // Prevent division by zero
  const totalVotes = (hack.worked_votes || 0) + (hack.failed_votes || 0);
  const safeTotalVotes = Math.max(totalVotes, 1);
  const validators = hack.unique_users_who_validated || 0;

  // Signal 1: Success Rate (0-1)
  // "Did this actually work for people who tried it?"
  // This is THE most important signal - filters out bad hacks
  const successRate = (hack.worked_votes || 0) / safeTotalVotes;

  // Signal 2: Replication Density (log-scaled)
  // "How many different people have validated this?"
  // Log scale: 1 person = 0, 10 people = 2.3, 100 people = 4.6
  // Logarithmic because the 2nd validator is more valuable than the 50th
  const replicationScore = Math.log(validators + 1);

  // Signal 3: Engagement (0-1)
  // "Do people upvote this hack?"
  // Weighted lower because upvotes are easy to game compared to validation
  // Prevents zero-division by using max 1 impression
  const engagementScore = (hack.upvotes || 0) / Math.max(hack.impressions || 1, 1);

  // Signal 4: Recency Boost with Quality-Conditional Decay
  // High-quality solutions decay slower, allowing them to stay visible longer
  // Low-quality solutions decay faster, making room for improvements
  const daysOld = (Date.now() - new Date(hack.created_at).getTime()) / (1000 * 60 * 60 * 24);

  let decayRate: number;
  if (successRate >= 0.95) {
    // High-quality solutions (95%+ success) stay visible longer
    decayRate = 0.98;  // Decay slower: day 30 = 0.545, day 60 = 0.297
  } else if (successRate >= 0.80) {
    // Medium-quality solutions (80-95% success) use standard decay
    decayRate = 0.95;  // Standard: day 30 = 0.215, day 60 = 0.046
  } else {
    // Lower-quality solutions (< 80% success) fade faster
    decayRate = 0.90;  // Fast decay: day 30 = 0.041, day 60 = 0.0018
  }

  const recencyBoost = Math.pow(decayRate, daysOld);

  // Calculate base score
  let score =
    (successRate * 0.5) +           // Success rate: 50% of score
    (replicationScore * 0.3) +      // Unique validators: 30% of score
    (engagementScore * 0.1) +       // Upvotes: 10% of score
    (recencyBoost * 0.1);           // Recency: 10% of score

  // VALIDATOR THRESHOLD: Prevent low-sample solutions from ranking too high
  // Protects against: "5 successes, 0 failures = 100% success" ranking above proven solutions
  if (validators < 5) {
    // Heavily penalize very niche solutions (< 5 people tried it)
    // These aren't statistically meaningful
    score *= 0.1;
  } else if (validators < 10) {
    // Moderately penalize low-sample solutions (5-10 people)
    // These are early-stage, may not generalize
    score *= 0.5;
  }
  // 10+ validators: No penalty, these are trustworthy

  return score;
}

/**
 * Calculate scores for multiple hacks and sort
 * Useful for feed queries
 *
 * @param hacks - Array of hack data
 * @param sortBy - Optional sort method: "best" (default), "newest", "trending"
 * @returns Hacks with scores, sorted appropriately
 */
export function rankHacks(
  hacks: HackData[],
  sortBy: 'best' | 'newest' | 'trending' = 'best'
): (HackData & { hack_score: number })[] {
  const hacksWithScores = hacks.map(hack => ({
    ...hack,
    hack_score: calculateHackScore(hack),
  }));

  switch (sortBy) {
    case 'best':
      // Default: Sort by calculated score (highest first)
      return hacksWithScores.sort((a, b) => b.hack_score - a.hack_score);

    case 'newest':
      // Sort by recency, but filter out low-quality solutions
      // Only show solutions with 80%+ success rate
      return hacksWithScores
        .filter(h => {
          const total = h.worked_votes + h.failed_votes;
          return total > 0 && (h.worked_votes / total) >= 0.8;
        })
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    case 'trending':
      // Show all solutions, sorted by success rate (no validator minimum)
      // For users who want to discover niche/experimental solutions
      return hacksWithScores.sort((a, b) => {
        const aRate = a.worked_votes / Math.max(a.worked_votes + a.failed_votes, 1);
        const bRate = b.worked_votes / Math.max(b.worked_votes + b.failed_votes, 1);
        return bRate - aRate;  // Highest success rate first
      });

    default:
      return hacksWithScores.sort((a, b) => b.hack_score - a.hack_score);
  }
}


/**
 * Helper: Get a hack's success percentage (for UI display)
 *
 * @param hack - Hack data
 * @returns Percentage string like "94%"
 */
export function getSuccessPercentage(hack: HackData): string {
  const totalVotes = (hack.worked_votes || 0) + (hack.failed_votes || 0);
  if (totalVotes === 0) return 'N/A';
  const percentage = Math.round(((hack.worked_votes || 0) / totalVotes) * 100);
  return `${percentage}%`;
}

/**
 * Helper: Get a hack's validation summary (for UI display)
 *
 * @param hack - Hack data
 * @returns Human-readable summary like "94% (47 people verified)"
 */
export function getValidationSummary(hack: HackData): string {
  const successPct = getSuccessPercentage(hack);
  const validators = hack.unique_users_who_validated || 0;

  if (validators === 0) {
    return 'No validations yet';
  }

  return `${successPct} (${validators} ${validators === 1 ? 'person' : 'people'} verified)`;
}

/**
 * Algorithm Notes:
 *
 * Why not use simple upvotes?
 * - Upvotes are easy to game (bots, click farms, circle votes)
 * - Upvotes measure engagement, not truth
 * - A hack with 1000 upvotes but 10% success rate is BAD
 *
 * Why weight success rate at 50%?
 * - If it doesn't work, nothing else matters
 * - A hack that works 100% of the time is valuable even if not viral
 *
 * Why weight replication density at 30%?
 * - One person trying something is not proof it works
 * - 100 people validating is stronger signal than 1000 upvotes
 * - Logarithmic scale prevents gaming (diminishing returns on validators)
 *
 * Why keep engagement at 10%?
 * - Not zero—sometimes popularity signals quality
 * - But much lower than validation signals
 * - Acts as a weak tie-breaker between otherwise equal hacks
 *
 * Why decay by recency?
 * - Old hacks may have better solutions now
 * - Prevents stagnation—new good hacks get a chance
 * - But doesn't penalize permanently (0.95^30 ≈ 0.21, not 0)
 *
 * Testing this algorithm:
 * 1. High success + many validators = HIGH score ✓
 * 2. Low success + many upvotes = LOW score ✓
 * 3. New hack with no validations = LOW score, gains over time ✓
 * 4. Old hack with high score = Decays gradually, can still rank ✓
 */
