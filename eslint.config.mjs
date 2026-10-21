import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    '.next-gate/**', // alternative build directories used by the local verification (NEXT_DIST_DIR); never linted
    '.next-lock/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Not part of the root application. frontend/ is a second app with its own lint script (it is not
    // archived until deployment configuration is confirmed); pages.bak/ is an unrouted legacy copy;
    // the root *.jsx files are standalone UI prototypes that nothing imports.
    'frontend/**',
    'pages.bak/**',
    'hack-*.jsx',
  ]),
  {
    // CommonJS files where require() is the module system: the legacy one-off setup scripts, and the smoke
    // harness's network-guard preload (loaded with `node --require`, which needs CommonJS). Scoped to these only.
    files: ['scripts/**/*.js', 'tests/smoke/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // ---- Foundation boundaries (docs/adr/0001-foundation.md). These are lint hygiene that keeps code honest; the
  // security boundary itself is the database role and its grants, not an import rule.
  {
    // Node runs src/ and tests/ TypeScript directly (type stripping), so type-only imports must say so.
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'separate-type-imports' }] },
  },
  {
    // Only src/platform/env.ts reads process.env, so configuration is validated in exactly one place.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/platform/env.ts'],
    rules: { 'no-restricted-syntax': ['error', { selector: "MemberExpression[object.name='process'][property.name='env']", message: 'Read configuration through src/platform/env.ts (getEnv/loadEnv), not process.env.' }] },
  },
  {
    // The browser never holds a Supabase client in the server-centric session design.
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    rules: { 'no-restricted-imports': ['error', { paths: [{ name: '@supabase/ssr', importNames: ['createBrowserClient'], message: 'No browser-side Supabase client: all Auth and data calls run on the server.' }] }] },
  },
  {
    // Routes and pages reach data through platform/modules, never through a database package directly.
    files: ['app/**/*.{ts,tsx}'],
    ignores: ['app/lib/supabase-server.ts'], // legacy (M01-A/B) read path, retired in F5; the test suite pins this exception
    rules: { 'no-restricted-imports': ['error', {
      paths: [{ name: '@supabase/ssr', importNames: ['createBrowserClient'], message: 'No browser-side Supabase client.' }],
      patterns: [{ group: ['@supabase/*', 'pg', 'pg/*'], message: 'Do not import database packages in app/; use src/platform/db from a route handler or a module.' }],
    }] },
  },
  {
    // UI components never touch the database or configuration.
    files: ['src/ui/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', {
      paths: [{ name: '@supabase/ssr', importNames: ['createBrowserClient'], message: 'No browser-side Supabase client.' }],
      patterns: [{ group: ['@supabase/*', 'pg', 'pg/*', '**/platform/db', '**/platform/db/*', '**/platform/env*', '**/platform/server', '**/platform/server.ts', '**/platform/http/handler*', '**/platform/http/validate*', '**/platform/http/origin*'], message: 'UI code cannot import database clients, environment configuration or the server-only platform surface; use @/src/platform (client-safe).' }],
    }] },
  },
  {
    // Modules are isolated: no sibling-module internals, no relative escapes, no clients, no app/ imports.
    files: ['src/modules/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', {
      paths: [{ name: '@supabase/ssr', importNames: ['createBrowserClient'], message: 'No browser-side Supabase client.' }],
      patterns: [
        { group: ['@supabase/*', 'pg', 'pg/*'], message: 'Modules receive a ready database handle in their context; they never build clients.' },
        { group: ['**/platform/db', '**/platform/db/*', '**/platform/env*', '**/platform/server', '**/platform/server.ts', '**/platform/http/handler*', '**/platform/http/validate*', '**/platform/http/origin*'], message: 'Database clients, environment and request handling are server-only (composition root); modules use the client-safe @/src/platform.' },
        { group: ['@/src/modules/*/*', '@/src/modules/*/**'], message: 'Import another module only through its index (e.g. @/src/modules/catalog).' },
        { group: ['../*', '../**'], message: 'Use the public index of another module; keep imports inside a module relative to ./' },
        { group: ['@/app/*', '@/app/**'], message: 'Modules do not depend on routes or pages.' },
      ],
    }] },
  },
  {
    // Platform is the lowest layer: it depends on no module and no route.
    files: ['src/platform/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', {
      paths: [{ name: '@supabase/ssr', importNames: ['createBrowserClient'], message: 'No browser-side Supabase client.' }],
      patterns: [{ group: ['@/src/modules/*', '@/src/modules/**', '**/modules/*', '@/app/*', '@/app/**'], message: 'src/platform must not depend on modules or app/.' }],
    }] },
  },
]);
