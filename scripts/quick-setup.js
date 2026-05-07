#!/usr/bin/env node

/**
 * Quick Database Setup via SQL Editor
 *
 * Since we can't execute migrations programmatically due to permissions,
 * this script provides instructions for manual setup.
 */

const fs = require('fs');
const path = require('path');

console.log(`
╔════════════════════════════════════════════════════════════════╗
║         🚀 HackAss Database Setup Instructions               ║
╚════════════════════════════════════════════════════════════════╝

Your Supabase project is ready! Follow these steps:

📋 STEP 1: Create the Hacks Table
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Go to: https://app.supabase.com/
2. Select your project (xquderctyjhpgvpnklww)
3. Go to SQL Editor (left sidebar)
4. Click "New Query"
5. Open this file and copy all content:
   migrations/002_create_hacks_table.sql
6. Paste into SQL Editor
7. Click RUN button
8. Wait for ✓ Success message


📋 STEP 2: Seed Sample Data
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Click "New Query" again
2. Open this file and copy all content:
   migrations/003_seed_hacks_initial.sql
3. Paste into SQL Editor
4. Click RUN button
5. Wait for ✓ Success message


✅ STEP 3: Verify Setup
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Go to Table Editor (left sidebar)
2. Select "hacks" table
3. You should see 15 rows of sample data

Then test your app:
  • http://localhost:3000/browse  → Should show 15 hacks
  • http://localhost:3000/submit  → Can submit new hacks
  • Click any hack → Vote system works!


🔗 Quick Links
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 Supabase Dashboard: https://app.supabase.com/
🗄️  SQL Editor: https://app.supabase.com/project/xquderctyjhpgvpnklww/sql/new
💻 Local App: http://localhost:3000/


⏱️  Estimated Time: 5 minutes

Done! 🎉
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

// Print file contents for convenience
console.log('\n\n📄 Copy this for Step 1 (Create Table):\n');
console.log('═'.repeat(70));
const schema = fs.readFileSync(
  path.join(__dirname, '../migrations/002_create_hacks_table.sql'),
  'utf8'
);
console.log(schema);

console.log('\n\n📄 Copy this for Step 2 (Seed Data):\n');
console.log('═'.repeat(70));
const seeds = fs.readFileSync(
  path.join(__dirname, '../migrations/003_seed_hacks_initial.sql'),
  'utf8'
);
console.log(seeds);

console.log('\n\n✨ Done! Paste the above SQL into your Supabase Dashboard.\n');
