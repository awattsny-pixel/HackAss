// The preview's own artwork must not go through the Next.js image optimizer: the optimizer fetches the file from inside the server, that request carries no edge header, and the
// origin lock refuses it ("The requested resource isn't a valid image ... received null"), so the picture shows as a broken image on the hosted pilot. Source-level guard; the built-server
// behaviour (direct artwork 200 image/png with the header, 404 without) is checked in scripts/px3e-local-checks.mjs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PUBLIC_ASSETS } from '../src/platform/preview-gate.ts';

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(n) ? [p] : []; });

test('every <Image> of a preview artwork file is unoptimized (the lock refuses the optimizer\'s internal fetch)', () => {
  let seen = 0;
  // the surfaces the preview serves; the legacy components under app/components are blocked by the gate and out of scope here
  for (const f of [...walk('app/(experience)'), ...walk('src/ui')]) {
    const code = readFileSync(f, 'utf8');
    for (const m of code.matchAll(/<Image\b[^>]*?\bsrc=(?:"([^"]+)"|\{'([^']+)'\})[^>]*?\/?>/gs)) {
      const src = m[1] ?? m[2];
      if (!PUBLIC_ASSETS.includes(src)) continue;
      seen++; assert.match(m[0], /\bunoptimized\b/, `${f}: <Image src="${src}"> must be unoptimized`);
    }
  }
  assert.ok(seen >= 2, `expected the two known artwork images, saw ${seen}`);
});
