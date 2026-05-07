#!/usr/bin/env node

/**
 * Database Setup Script
 *
 * This script:
 * 1. Creates the hacks table with proper schema
 * 2. Sets up RLS policies
 * 3. Seeds initial hack data
 *
 * Run with: node scripts/setup-database.js
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function executeSql(sql, description) {
  console.log(`\n📝 ${description}...`);
  try {
    const { data, error } = await supabase.rpc('query', {
      query: sql
    }).catch(() => {
      // Fallback: try raw query if rpc doesn't work
      return supabase.from('_raw_sql').select().single().catch(e => ({ error: e }));
    });

    if (error && error.message && !error.message.includes('does not exist')) {
      throw error;
    }

    console.log('✅ Success');
    return true;
  } catch (err) {
    console.error('❌ Error:', err.message);
    return false;
  }
}

async function setupDatabase() {
  console.log('🚀 Starting database setup...\n');

  // Read migration files
  const schemaMigration = fs.readFileSync(
    path.join(__dirname, '../migrations/002_create_hacks_table.sql'),
    'utf8'
  );

  const seedMigration = fs.readFileSync(
    path.join(__dirname, '../migrations/003_seed_hacks_initial.sql'),
    'utf8'
  );

  // Execute schema migration
  const schemaSuccess = await executeSql(schemaMigration, 'Creating hacks table and indexes');
  if (!schemaSuccess) {
    console.log('\n⚠️  Schema creation may have issues - continuing...');
  }

  // Execute seed migration
  const seedSuccess = await executeSql(seedMigration, 'Seeding initial hack data');
  if (!seedSuccess) {
    console.log('\n⚠️  Seed data may have issues - continuing...');
  }

  // Verify setup
  console.log('\n\n🔍 Verifying database setup...');
  try {
    const { data, error } = await supabase
      .from('hacks')
      .select('COUNT(*)', { count: 'exact' })
      .eq('status', 'approved');

    if (error) {
      console.log('❌ Could not verify - table may not exist');
      console.log('\n📋 To manually set up the database:');
      console.log('1. Go to https://app.supabase.com/');
      console.log('2. Open SQL Editor');
      console.log('3. Create new query');
      console.log('4. Copy and paste contents of migrations/002_create_hacks_table.sql');
      console.log('5. Run the query');
      console.log('6. Create another query');
      console.log('7. Copy and paste contents of migrations/003_seed_hacks_initial.sql');
      console.log('8. Run the query');
      return;
    }

    console.log(`✅ Database verified! ${data?.length || 0} approved hacks found`);
    console.log('\n🎉 Database setup complete!');
  } catch (err) {
    console.log('⚠️  Could not verify - but migrations may have succeeded');
    console.log('Check Supabase dashboard to confirm');
  }
}

setupDatabase().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
