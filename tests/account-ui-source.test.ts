// PX-2c source guarantees for src/ui/account and the account routes: same-origin endpoints only, no storage, no tokens, no registration, the draft is not touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = (f: string) => readFileSync(join(root, f), 'utf8');
const files = readdirSync(join(root, 'src/ui/account')).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `src/ui/account/${f}`);

test('the account UI talks only to this application\'s own auth endpoints, with same-origin credentials and no caching', () => {
  const allowed = new Set(['/auth/session', '/auth/sign-out', '/auth/sign-in', '/auth/recovery/request']);
  let seen = 0;
  for (const f of files) { const t = src(f); for (const m of t.matchAll(/fetch\(\s*(['"`])([^'"`]+)\1/g)) { seen++; assert.ok(allowed.has(m[2]), `${f} fetches ${m[2]}`); const win = t.slice(m.index, m.index + 420); assert.match(win, /credentials: 'same-origin'/, `${f}: ${m[2]}`); assert.match(win, /cache: 'no-store'/, `${f}: ${m[2]}`); assert.match(win, /AbortSignal\.timeout\(/, `${f}: ${m[2]} has a timeout`); } }
  assert.ok(seen >= 4, `saw ${seen} fetches`);
});
test('no browser storage, cookies, raw HTML, Auth client, environment or token handling in the account UI', () => {
  for (const f of files) {
    const s = src(f);
    assert.doesNotMatch(s, /localStorage|sessionStorage|indexedDB|document\.cookie/, f);
    assert.doesNotMatch(s, /dangerouslySetInnerHTML|innerHTML|eval\(|new Function/, f);
    assert.doesNotMatch(s, /supabase|process\.env|server-only|service_role|access_token|refresh_token|\bjwt\b/i, f);
  }
});
test('public registration is unavailable in the UI: no sign-up route, link or form; the sign-in screen says registration is closed', () => {
  for (const f of files.concat(['src/ui/experience/Shell.tsx'])) { const code = src(f).replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'/g, "''"); assert.doesNotMatch(code, /signUp|sign_up|href="\/account\/(sign-up|register)|href=\{?`?\/auth\/(sign-up|register)/i, f); }
  assert.match(src('src/ui/account/SignInScreen.tsx'), /Registration is closed for now/);
  assert.deepEqual(readdirSync(join(root, 'app/(experience)/account')).sort(), ['prompts', 'recover', 'results', 'sign-in']); // PX-3c adds the saved-work pages; there is still no sign-up page
});
test('the unsaved prompt is out of reach: only the session provider touches the experience context, and only for the toast', () => {
  assert.match(src('src/ui/account/SessionProvider.tsx'), /const \{ toast \} = useExperience\(\)/);
  for (const f of ['src/ui/account/SignInScreen.tsx', 'src/ui/account/RecoverScreen.tsx', 'src/ui/account/AccountChip.tsx', 'src/ui/account/session-state.ts']) assert.doesNotMatch(src(f).replace(/\/\/.*$/gm, ''), /useExperience|ExperienceProvider|fullPrompt|startingPrompt|reflection/, f);
  assert.doesNotMatch(src('src/ui/account/SessionProvider.tsx').replace(/\/\/.*$/gm, ''), /dispatch\(\{ type: '(editPrompt|editField|startBlank|startFromHack|resetDraft|reflect|regenerate)/);
});
test('REGRESSION (source): sign-in and sign-out go through the coordinator; the provider never dispatches a result of its own', () => {
  const sp = src('src/ui/account/SessionProvider.tsx'); assert.match(sp, /createSessionCoordinator\(/); assert.match(sp, /beginAction\(\)/); assert.doesNotMatch(sp, /dispatch\(\{ type: 'result'/);
  const si = src('src/ui/account/SignInScreen.tsx'); assert.ok(si.indexOf('beginAuthAction()') < si.indexOf("fetch('/auth/sign-in'"), 'the action begins before the request is sent'); assert.match(si, /finally \{ end\(\)/);
});
test('after sign-in the member moves by client navigation (router.push), never a full page load; the return path comes from the server, already validated', () => {
  const s = src('src/ui/account/SignInScreen.tsx'); assert.match(s, /router\.push\(next\)/); assert.doesNotMatch(s, /window\.location|location\.href|location\.assign|location\.replace/);
  assert.match(src('app/(experience)/account/sign-in/page.tsx'), /safeReturnPath\(/);
});
test('the email-link pages carry the approved visual tokens and 44px controls, load nothing external and keep the strict security headers', () => {
  const p = src('app/auth/_server/pages.ts');
  for (const t of ['#11151c', '#1a2029', '#f36b51', '#f4bf65', 'min-height:44px', ':focus-visible', 'hack-official.png']) assert.ok(p.includes(t), t);
  assert.doesNotMatch(p, /https?:\/\//); assert.match(p, /img-src 'self'/); assert.match(p, /'referrer-policy': 'same-origin'/);
});
