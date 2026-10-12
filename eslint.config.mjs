import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
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
    // Legacy one-off CommonJS setup scripts: require() is their module system. Scoped to these files only.
    files: ['scripts/**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
]);
