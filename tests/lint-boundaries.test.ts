// The module-boundary lint rules, exercised through ESLint itself on virtual files. These rules are hygiene that keeps
// code honest; they are not the security boundary (the database role and its grants are).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function rules(file: string, code: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: join(root, file) });
  return res.messages.map((m) => m.ruleId ?? `parse:${m.message}`);
}
const RESTRICTED_IMPORT = 'no-restricted-imports';
const RESTRICTED_SYNTAX = 'no-restricted-syntax';
const TYPE_IMPORT = '@typescript-eslint/consistent-type-imports';

test('app/: database packages are forbidden (the legacy read path is the single pinned exception)', async () => {
  assert.ok((await rules('app/api/new/route.ts', "import { createClient } from '@supabase/supabase-js';\nexport const x = createClient;\n")).includes(RESTRICTED_IMPORT));
  assert.ok((await rules('app/page.tsx', "import pg from 'pg';\nexport default pg;\n")).includes(RESTRICTED_IMPORT));
  assert.ok(!(await rules('app/lib/supabase-server.ts', "import { createClient } from '@supabase/supabase-js';\nexport const x = createClient;\n")).includes(RESTRICTED_IMPORT));
  const importers: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n) && /from '@supabase\//.test(readFileSync(p, 'utf8'))) importers.push(p.slice(root.length)); } };
  walk(join(root, 'app'));
  assert.deepEqual(importers, ['app/lib/supabase-server.ts'], 'only the pinned legacy file may import database packages under app/');
});

test('no browser-side Supabase client anywhere', async () => {
  const code = "import { createBrowserClient } from '@supabase/ssr';\nexport const c = createBrowserClient;\n";
  for (const file of ['src/platform/db/x.ts', 'src/modules/catalog/x.ts', 'src/ui/x.tsx', 'tests/x.ts', 'scripts/x.mjs']) assert.ok((await rules(file, code)).includes(RESTRICTED_IMPORT), file);
  assert.ok(!(await rules('src/platform/db/x.ts', "import { createServerClient } from '@supabase/ssr';\nexport const c = createServerClient;\n")).includes(RESTRICTED_IMPORT));
});

test('src/ui: no database clients and no environment configuration', async () => {
  for (const spec of ['@/src/platform/db', '@/src/platform/db/clients', '@supabase/supabase-js', '../platform/env']) assert.ok((await rules('src/ui/Button.tsx', `import x from '${spec}';\nexport default x;\n`)).includes(RESTRICTED_IMPORT), spec);
});

test('src/modules: isolated from siblings, routes, clients and parent directories', async () => {
  const bad = ['@/src/modules/identity/repo', '@/src/modules/identity/service.ts', '../identity/index.ts', '../x', '@/src/platform/db', '@/src/platform/db/clients', '@supabase/supabase-js', 'pg', '@/app/lib/public-reads'];
  for (const spec of bad) assert.ok((await rules('src/modules/catalog/service.ts', `import x from '${spec}';\nexport default x;\n`)).includes(RESTRICTED_IMPORT), `should reject ${spec}`);
  for (const spec of ['@/src/modules/identity', './repo.ts', '@/src/platform', 'zod']) assert.ok(!(await rules('src/modules/catalog/service.ts', `import x from '${spec}';\nexport default x;\n`)).includes(RESTRICTED_IMPORT), `should allow ${spec}`);
});

test('src/platform: depends on no module and no route', async () => {
  for (const spec of ['@/src/modules/catalog', '@/src/modules/catalog/repo', '@/app/lib/public-reads']) assert.ok((await rules('src/platform/thing.ts', `import x from '${spec}';\nexport default x;\n`)).includes(RESTRICTED_IMPORT), spec);
  assert.ok(!(await rules('src/platform/thing.ts', "import x from './log.ts';\nexport default x;\n")).includes(RESTRICTED_IMPORT));
});

test('process.env is read only in src/platform/env.ts', async () => {
  const code = "export const v = process.env.FOO;\n";
  for (const file of ['src/platform/log.ts', 'src/modules/catalog/x.ts', 'src/ui/x.tsx']) assert.ok((await rules(file, code)).includes(RESTRICTED_SYNTAX), file);
  assert.ok(!(await rules('src/platform/env.ts', code)).includes(RESTRICTED_SYNTAX));
});

test('type-only imports must use `import type` in src/ and tests/ (Node strips types and cannot import a type at runtime)', async () => {
  assert.ok((await rules('src/modules/catalog/x.ts', "import { Actor } from '@/src/platform';\nexport const a: Actor | null = null;\n")).includes(TYPE_IMPORT));
  assert.ok(!(await rules('src/modules/catalog/x.ts', "import type { Actor } from '@/src/platform';\nexport const a: Actor | null = null;\n")).includes(TYPE_IMPORT));
});

test('module directories are exactly the planned set; only submissions has implementation so far (the pure HashCanon-1 module)', () => {
  const planned = ['ai', 'catalog', 'collections', 'extension-points', 'identity', 'jobs', 'moderation', 'provenance', 'submissions'];
  const dirs = readdirSync(join(root, 'src/modules')).filter((n) => statSync(join(root, 'src/modules', n)).isDirectory()).sort();
  assert.deepEqual(dirs, planned);
  for (const d of dirs) {
    const files = readdirSync(join(root, 'src/modules', d)).sort();
    assert.deepEqual(files, d === 'submissions' ? ['hashcanon.ts', 'index.ts'] : ['index.ts'], `${d} should hold only index.ts until its slice lands`);
    assert.match(readFileSync(join(root, 'src/modules', d, 'index.ts'), 'utf8'), new RegExp(`MODULE_NAME = '${d}'`));
  }
});

test('the submissions module is pure: no environment, no database, no server-only marker, no Node built-in', () => {
  const src = readFileSync(join(root, 'src/modules/submissions/hashcanon.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/process\.env|node:|server-only|@supabase|from '\.\.\//.test(src));
  assert.ok(!/^import /m.test(src), 'hashcanon.ts imports nothing');
});
