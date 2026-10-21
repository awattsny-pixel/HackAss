// PX-2a: redirect validation. `next` is attacker-controlled; only a relative path inside an allowed area of this application may come out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeReturnPath } from '../src/modules/identity/index.ts';

test('good paths are kept', () => {
  for (const [input, out] of [['/spark', '/spark'], ['/spark/catalog/herbs-1', '/spark/catalog/herbs-1'], ['/lab', '/lab'], ['/spark?category=home-diy', '/spark?category=home-diy'], ['/account/settings', '/account/settings'], ['/reveal#frag', '/reveal']])
    assert.equal(safeReturnPath(input), out, String(input));
});
test('open-redirect and injection corpus all fall back', () => {
  const bad: unknown[] = [
    'https://evil.example', 'http://evil.example/spark', '//evil.example', '///evil.example', '/\\evil.example', '\\\\evil.example', '/\\/evil.example', 'javascript:alert(1)', 'data:text/html,x', 'evil.example/spark', 'spark',
    '/%2F%2Fevil.example', '/%2f/evil.example', '%2F%2Fevil.example', '/%5Cevil.example', '/%252F%252Fevil.example', '/spark/%2e%2e/%2e%2e/admin', '/spark/../admin', '/spark/./x', '/spark//x',
    '/spark\n', '/spark\r\nSet-Cookie: x=1', '/spark\u0000', '/spark\t', '/spark x', '/spark%0d%0a', '/spark%00', '/spark@evil.example', 'https:/\\evil.example', '/spark:80', '/‮evil',
    '/admin', '/api/auth/login', '/auth/login', '/sparkle', '/spark-other', '/', '', ' /spark', '/%', '/%zz', '/spark%', null, undefined, 42, {}, ['/spark'],
    '/' + 'a'.repeat(600), '/spark?' + 'a'.repeat(300).replace(/./g, 'x') + '\\',
  ];
  for (const b of bad) assert.equal(safeReturnPath(b), '/spark', JSON.stringify(b));
});
test('a bad query is dropped but a good path is kept; control characters in the query drop it too', () => {
  assert.equal(safeReturnPath('/spark?next=https://evil.example'), '/spark');
  assert.equal(safeReturnPath('/spark?a=%0d%0a'), '/spark');
  assert.equal(safeReturnPath('/spark?a=<script>'), '/spark');
  assert.equal(safeReturnPath('/spark?' + 'x'.repeat(201)), '/spark');
});
test('the fallback and allowed areas are configurable but still validated', () => {
  assert.equal(safeReturnPath('https://x', { fallback: '/lab' }), '/lab');
  assert.equal(safeReturnPath('/other/x', { allowedPrefixes: ['/other'] }), '/other/x');
  assert.equal(safeReturnPath('/spark', { allowedPrefixes: ['/other'] }), '/spark', 'falls back to the default fallback, which is itself a fixed path');
});
test('the result is always a path that starts with a single slash and contains no scheme, host or backslash', () => {
  const samples = ['/spark', 'x', '//a', '/spark?x=1', 'https://a', '/\\a', '/spark/%2e%2e'];
  for (const s of samples) { const r = safeReturnPath(s); assert.match(r, /^\/[^/\\]/); assert.doesNotMatch(r, /[:\\\s]/); }
});
