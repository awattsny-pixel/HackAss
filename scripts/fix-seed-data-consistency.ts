/**
 * Fix Seed Data Consistency
 *
 * Problem: Worked votes + failed votes should approximately equal unique_validators
 * (since each person validates once, not multiple times)
 *
 * Current (broken):
 * worked_votes: 87, failed_votes: 5, unique_validators: 34
 * Issue: 87 + 5 = 92 votes from 34 people = 2.7 votes per person (doesn't make sense)
 *
 * Solution: Make unique_validators ≈ worked_votes + failed_votes
 *
 * Usage:
 * npx ts-node scripts/fix-seed-data-consistency.ts
 *
 * This script will:
 * 1. Read seed-solutions.json
 * 2. For each solution, recalculate unique_validators to match votes
 * 3. Ensure success rate stays ~same (adjust votes proportionally if needed)
 * 4. Write corrected file to seed-solutions.json.fixed
 * 5. Show diff of changes
 */

import * as fs from 'fs';
import * as path from 'path';

interface SeedSignals {
  worked_votes: number;
  failed_votes: number;
  unique_validators: number;
  upvotes: number;
  impressions: number;
}

interface Solution {
  solution_id: string;
  problem_id: string;
  title: string;
  description: string;
  steps: string[];
  category: string;
  difficulty: string;
  why_it_works: string;
  source_attribution: string;
  seed_signals: SeedSignals;
}

interface SolutionsData {
  solutions: Solution[];
}

function fixSolution(solution: Solution): Solution {
  const { worked_votes, failed_votes, unique_validators } = solution.seed_signals;
  const totalVotes = worked_votes + failed_votes;

  // Calculate the inconsistency
  const votesPerValidator = totalVotes / unique_validators;

  // FIX: Make unique_validators match total votes
  // This means: unique_validators ≈ total votes
  // (each person validates once)

  if (Math.abs(votesPerValidator - 1.0) > 0.5) {
    // Inconsistency detected (not ~1 vote per validator)

    // Strategy: Adjust unique_validators to match total votes
    // Success rate stays the same

    const successRate = worked_votes / totalVotes;

    return {
      ...solution,
      seed_signals: {
        ...solution.seed_signals,
        unique_validators: totalVotes, // Now matches: each person validated once
        // worked_votes and failed_votes stay the same
        // This maintains success rate
      },
    };
  }

  // No fix needed (already ~1 vote per validator)
  return solution;
}

function main() {
  const filepath = path.join(__dirname, '..', 'data', 'seed-solutions.json');

  console.log('📂 Loading seed data...');
  const content = fs.readFileSync(filepath, 'utf-8');
  const data = JSON.parse(content) as SolutionsData;

  console.log(`📋 Found ${data.solutions.length} solutions\n`);

  // Track statistics
  let fixed = 0;
  let unchanged = 0;
  const diffs: Array<{
    id: string;
    before: SeedSignals;
    after: SeedSignals;
    successRateBefore: number;
    successRateAfter: number;
  }> = [];

  // Fix each solution
  const fixedSolutions = data.solutions.map(solution => {
    const before = { ...solution.seed_signals };
    const fixed_solution = fixSolution(solution);
    const after = fixed_solution.seed_signals;

    if (before.unique_validators !== after.unique_validators) {
      fixed++;
      diffs.push({
        id: solution.solution_id,
        before,
        after,
        successRateBefore: before.worked_votes / (before.worked_votes + before.failed_votes),
        successRateAfter: after.worked_votes / (after.worked_votes + after.failed_votes),
      });
    } else {
      unchanged++;
    }

    return fixed_solution;
  });

  // Show summary
  console.log(`✅ Fixed: ${fixed} solutions`);
  console.log(`✓ Unchanged: ${unchanged} solutions\n`);

  // Show first 5 diffs as examples
  console.log('📊 First 5 fixes as examples:\n');
  diffs.slice(0, 5).forEach(diff => {
    console.log(`${diff.id}:`);
    console.log(
      `  Validators: ${diff.before.unique_validators} → ${diff.after.unique_validators}`
    );
    console.log(
      `  Success %: ${(diff.successRateBefore * 100).toFixed(1)}% → ${(diff.successRateAfter * 100).toFixed(1)}%`
    );
    console.log(
      `  Votes: ${diff.before.worked_votes}w/${diff.before.failed_votes}f → ${diff.after.worked_votes}w/${diff.after.failed_votes}f\n`
    );
  });

  // Write fixed file
  const outputPath = filepath.replace('.json', '.fixed.json');
  const fixedData: SolutionsData = {
    solutions: fixedSolutions,
  };

  fs.writeFileSync(outputPath, JSON.stringify(fixedData, null, 2));

  console.log(`\n📝 Fixed data written to: ${outputPath}`);
  console.log(`\n✨ Review the changes, then run:`);
  console.log(`   mv ${outputPath} ${filepath}`);
}

main();
