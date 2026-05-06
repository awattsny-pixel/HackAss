/**
 * Database Seed Script
 *
 * Populates the database with 100 core problems and 350+ curated solutions
 * Prevents the empty-feed problem on launch
 * Creates validation signals that demonstrate the ranking algorithm
 *
 * Usage:
 * - Development: npx ts-node scripts/seed-database.ts
 * - Production: Use before final deployment only once
 * - Idempotent: Safe to re-run (checks for existing data)
 *
 * Environment:
 * - Requires SUPABASE_URL and SUPABASE_SERVICE_KEY (server-side key with admin access)
 * - NOT the public anon key
 * - Put in .env.local or pass as environment variables
 */
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing environment variables:');
  console.error('   SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  console.error('');
  console.error('Get them from: https://app.supabase.com → Settings → API');
  console.error('SUPABASE_SERVICE_KEY is labeled "Service role secret" (not the anon key)');
  process.exit(1);
}

// Create admin client with service key (full database access)
const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface Problem {
  problem_id: string;
  title: string;
  category: string;
  search_volume: number;
  difficulty: string;
  subcategory: string;
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
  seed_signals: {
    worked_votes: number;
    failed_votes: number;
    unique_validators: number;
    upvotes: number;
    impressions: number;
  };
}

async function loadJSON<T>(filename: string): Promise<T> {
  const filepath = path.join(__dirname, '..', 'data', filename);
  const content = fs.readFileSync(filepath, 'utf-8');
  return JSON.parse(content) as T;
}

async function seedHacks(): Promise<void> {
  console.log('🌱 Starting database seed...\n');

  try {
    // Load seed data
    console.log('📂 Loading seed data files...');
    const problemsData = await loadJSON<{ problems: Problem[] }>('seed-problems.json');
    const solutionsData = await loadJSON<{ solutions: Solution[] }>('seed-solutions.json');

    const problems = problemsData.problems;
    const solutions = solutionsData.solutions;

    console.log(`   ✓ Loaded ${problems.length} core problems`);
    console.log(`   ✓ Loaded ${solutions.length} curated solutions\n`);

    // Check if already seeded
    console.log('🔍 Checking if database is already seeded...');
    const { data: existingHacks, error: checkError } = await supabase
      .from('hacks')
      .select('id')
      .limit(1);

    if (checkError) {
      console.error('❌ Error checking database:', checkError.message);
      process.exit(1);
    }

    if (existingHacks && existingHacks.length > 0) {
      console.warn('⚠️  Database already contains hacks.');
      console.warn('   Skipping seed to prevent duplicates.');
      console.warn('   If you want to re-seed, delete existing hacks first.\n');
      process.exit(0);
    }

    console.log('   ✓ Database is empty, proceeding with seed\n');

    // Create a seed user for attribution
    console.log('👤 Creating seed data attribution user...');
    const { data: userData, error: userError } = await supabase
      .from('users')
      .insert({
        email: 'seed-data@hackass.app',
        username: 'seed-curator',
        // Password not needed for seed data (not a real user)
      })
      .select()
      .single();

    if (userError && !userError.message.includes('duplicate')) {
      console.error('❌ Error creating seed user:', userError.message);
      // Continue anyway—we'll use null for user_id if this fails
    }

    const seedUserId = userData?.id || null;
    console.log(`   ✓ Seed user created (ID: ${seedUserId || 'none'})\n`);

    // Insert problems first
    console.log('💾 Inserting seed problems into database...');
    const problemsToInsert = problems.map(p => ({
      problem_id: p.problem_id,
      title: p.title,
      category: p.category,
      subcategory: p.subcategory,
      search_volume: p.search_volume,
      difficulty: p.difficulty,
    }));

    const { data: insertedProblems, error: problemError } = await supabase
      .from('problems')
      .insert(problemsToInsert)
      .select('id, problem_id');

    if (problemError) {
      console.error('❌ Error inserting problems:', problemError.message);
      process.exit(1);
    }

    // Map problem_id strings to database UUIDs
    const problemIdMap = new Map(
      (insertedProblems || []).map(p => [p.problem_id, p.id])
    );
    console.log(`   ✓ Inserted ${insertedProblems?.length || 0} problems\n`);

    // Insert hacks
    console.log('💾 Inserting seed solutions into database...');

    const hacksToInsert = solutions
      .filter(s => s.solution_id && s.solution_id.trim() !== '')
      .map(solution => ({
      solution_id: solution.solution_id,
      problem_id: problemIdMap.get(solution.problem_id),
      title: solution.title,
      description: solution.description,
      steps: solution.steps,
      category: solution.category,
      difficulty: solution.difficulty,
      why_it_works: solution.why_it_works,
      source: solution.source_attribution,
      user_id: seedUserId,
      status: 'approved', // Seed data is pre-approved
      // Seed validation signals (will be used by ranking algorithm)
      worked_votes: solution.seed_signals.worked_votes,
      failed_votes: solution.seed_signals.failed_votes,
      unique_users_who_validated: solution.seed_signals.unique_validators,
      upvotes: solution.seed_signals.upvotes,
      impressions: solution.seed_signals.impressions,
      // Metadata for tracking
      is_seed_data: true,
      seed_problem_id: solution.problem_id,
    }));

    const { data: insertedHacks, error: insertError } = await supabase
      .from('hacks')
      .insert(hacksToInsert);

    if (insertError) {
      console.error('❌ Error inserting hacks:', insertError.message);
      process.exit(1);
    }

    console.log(`   ✓ Inserted ${hacksToInsert.length} seed solutions\n`);

    // Summary
    console.log('✅ Seed complete!\n');
    console.log('📊 Summary:');
    console.log(`   • Problems: ${problems.length}`);
    console.log(`   • Solutions: ${solutions.length}`);
    console.log(`   • Seed users: 1`);
    console.log(`   • Total validation signals: ${solutions.reduce((sum, s) => sum + s.seed_signals.worked_votes + s.seed_signals.failed_votes, 0)}`);
    console.log('');
    console.log('🚀 Your database is ready to launch with a complete, ranked feed!');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Verify solutions appear in your app feed');
    console.log('  2. Check that ranking algorithm sorts by success rate');
    console.log('  3. Test validation UI ("Did it work?" prompts)');
    console.log('  4. Monitor metrics (validation rate, retention)');

  } catch (error) {
    console.error('❌ Unexpected error:', error);
    process.exit(1);
  }
}

// Run the seed
seedHacks().then(() => {
  console.log('\n✨ Done!');
  process.exit(0);
});
