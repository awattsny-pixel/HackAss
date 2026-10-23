// UI slice S2: Home and navigation alignment. Supported destinations only, one guarded New hack action, real-category chips, contextual Hack guidance,
// and no fabricated discovery content (Trending, tried counts, recommendations, search).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { greetingFor, homeGuidance } from '../src/ui/experience/home.ts';
import { iconKeyFor } from '../src/ui/experience/format.ts';
import { accountSummary } from '../src/ui/account/account-summary.ts';
import { initialState, reduce, requiresConfirmation, type Action } from '../src/ui/experience/state.ts';
import { DEMO_HACKS } from '../src/ui/experience/demo-hacks.ts';

const src = (f: string) => readFileSync(f, 'utf8');
const run = (...as: Action[]) => as.reduce(reduce, initialState);

test('the shell has exactly two destinations (Home, My hacks) plus the guarded New hack action; the journey screens are no longer nav items', () => {
  const shell = src('src/ui/experience/Shell.tsx');
  assert.match(shell, /label: 'Home', to: '\/spark'/); assert.match(shell, /label: 'My hacks', to: '\/account\/prompts'/);
  for (const gone of ["'The Spark'", "'Hack detail'", "'The Lab'", "'The Reveal'", "'My prompts'", "'My results'"]) assert.ok(!shell.includes(gone), gone);
  assert.equal((shell.match(/className="new-hack"/g) ?? []).length, 2, 'sidebar/rail button and phone bar button');
  assert.match(shell, /aria-label="Mobile navigation"/); assert.match(shell, /aria-label="Primary"/);
});
test('My hacks stays current on both saved-work pages and their details; Prompts and Results are tabs over the existing routes', () => {
  const shell = src('src/ui/experience/Shell.tsx');
  assert.match(shell, /startsWith\('\/account\/prompts'\)\) return 'prompts'/); assert.match(shell, /startsWith\('\/account\/results'\)\) return 'results'/); assert.match(shell, /page === 'prompts' \|\| page === 'results'/);
  const tabs = src('src/ui/work/WorkChrome.tsx');
  assert.match(tabs, /aria-label="My hacks"/); assert.match(tabs, /href="\/account\/prompts"[^>]*>Prompts</); assert.match(tabs, /href="\/account\/results"[^>]*>Results</);
  assert.doesNotMatch(tabs, /Collections|Links</, 'no non-functional tabs');
});
test('New hack is ONE guarded action shared by the shell and Home: it confirms before replacing unsaved work, then starts a blank draft', () => {
  const hook = src('src/ui/experience/NewHack.ts');
  assert.match(hook, /confirmThen\('new'/); assert.match(hook, /type: 'startBlank'/); assert.match(hook, /router\.push\('\/lab'\)/);
  assert.match(src('src/ui/experience/Shell.tsx'), /useNewHack\(\)/); assert.match(src('src/ui/experience/SparkHeader.tsx'), /useNewHack\(\)/);
  const edited = run({ type: 'startFromHack', hack: DEMO_HACKS[0] }, { type: 'editPrompt', value: 'unsaved words' });
  assert.equal(requiresConfirmation(edited, 'new'), true); assert.equal(requiresConfirmation(initialState, 'new'), false);
  const after = reduce(edited, { type: 'startBlank' }); assert.equal(after.started, true); assert.equal(after.fullPrompt, '');
});
test('the greeting follows the hour, and the server render is neutral', () => {
  assert.deepEqual([0, 4, 5, 11, 12, 17, 18, 23].map(greetingFor), ['Hello', 'Hello', 'Good morning', 'Good morning', 'Good afternoon', 'Good afternoon', 'Good evening', 'Good evening']);
  assert.match(src('src/ui/experience/SparkHeader.tsx'), /\(\) => 'Hello'/);
  assert.doesNotMatch(src('src/ui/experience/SparkHeader.tsx'), /session|Alex|username|displayName/i, 'no name is invented or read');
});
test("Hack's guidance on Home is contextual: a draft in progress, an open draft, demo mode, or the plain start; a draft offers a way back", () => {
  const a = homeGuidance(true, true, 'catalog'); const b = homeGuidance(true, false, 'catalog'); const c = homeGuidance(false, false, 'demo'); const d = homeGuidance(false, false, 'catalog');
  assert.ok(a.continueDraft && b.continueDraft && !c.continueDraft && !d.continueDraft);
  assert.match(a.text, /not saved/); assert.match(c.text, /draft examples/); assert.equal(new Set([a.text, b.text, c.text, d.text]).size, 4);
  for (const g of [a, b, c, d]) assert.doesNotMatch(g.text, /\bAI (chat|conversation)|live AI|trending|recommend/i);
});
test('chips come from the categories in the loaded catalog (nothing hard-coded) and are hidden when the catalog could not be read', () => {
  const cat = src('src/ui/experience/SparkCatalog.tsx');
  assert.match(cat, /view\.categories\.map\(/); assert.match(cat, /view\.status === 'ok' \? \(\s*<nav className="chips"/);
  assert.doesNotMatch(cat, /Everyday|Money|Life|Visual/, 'no category names in the catalog view');
});
// (scoped to Home and the shell: the Lab's own, clearly disabled "Ask Hack to improve this (unavailable)" control is existing, honest behaviour)
test('no fabricated discovery content: no Trending, tried counts, recommendations, search, bell, Watch, Camera or Browse destinations', () => {
  for (const f of ['Shell', 'SparkHeader', 'SparkCatalog', 'SparkDemo'].map((n) => `src/ui/experience/${n}.tsx`)) {
    assert.doesNotMatch(src(f), /Trending|\btried\b|Hack's pick|Recommended for you|type="search"|role="search"|Search hacks|Ask Hack|aria-label="Notifications"/, f);
  }
  const shell = src('src/ui/experience/Shell.tsx'); for (const w of ['Watch', 'Camera', 'Browse', 'Collections', 'Extension']) assert.ok(!shell.includes(w), w);
});
test('the journey bar links to reachable steps only (Understand needs a viewed hack) and Home keeps the honest source labels', () => {
  const shell = src('src/ui/experience/Shell.tsx'); assert.match(shell, /hasDetail \? href : null/); assert.match(shell, /Select a hack first/);
  const header = src('src/ui/experience/SparkHeader.tsx'); assert.match(header, /Published catalog/); assert.match(header, /Demo examples/);
});
test('stylesheet: phone bar has three columns, the rail hides the New hack label visually, and Home stacks on phones', () => {
  const css = src('src/ui/experience/experience.css');
  assert.match(css, /\.mobile-nav\{display:grid[^}]*repeat\(3,1fr\)/); assert.match(css, /\.new-hack \.nav-label/); assert.match(css, /\.hero\{flex-direction:column/);
});
test('dialogs are centred (the reset removed the native auto margin; Slice 1 screenshots showed them top-left) and the phone journey bar stays one row', () => {
  const css = src('src/ui/experience/experience.css');
  assert.match(css, /dialog\.confirm\{margin:auto;/); assert.match(css, /\.stepbar\{flex-wrap:nowrap;overflow-x:auto/);
});
test('each card is ONE link (the title, stretched over the card) with a visible focus ring; no per-card button; no "Published" decoration; demo cards keep their label', () => {
  const card = src('src/ui/experience/HackCard.tsx'); const css = src('src/ui/experience/experience.css');
  assert.equal((card.match(/<Link /g) ?? []).length, 1); assert.doesNotMatch(card, /<button|Explore hack/);
  assert.match(card, /<h3><Link className="card-link"/); assert.match(card, /Demo example · draft/);
  assert.match(css, /\.card-link::after\{content:'';position:absolute;inset:0/); assert.match(css, /\.hack-card:has\(\.card-link:focus-visible\)\{outline:2\.5px solid var\(--coral-deep\)/);
  for (const f of ['SparkCatalog', 'SparkDemo']) { const t = src(`src/ui/experience/${f}.tsx`); assert.doesNotMatch(t, /Explore hack|live-pill|>Published</, f); assert.match(t, /<HackCard /, f); }
  const cat = src('src/ui/experience/SparkCatalog.tsx'); for (const b of ['DIFFICULTY_LABEL', 'timeRange', 'costRange', 'AI_LABEL']) assert.ok(cat.includes(`${b}(`) || cat.includes(`${b}[`), `${b} still shown`);
  assert.match(src('src/ui/experience/SparkDemo.tsx'), /Draft written for design review · not community verified/); assert.match(src('src/ui/experience/SparkDemo.tsx'), /\bdemo\b>/);
});
test('category icons: the six design categories (and Business as Work) get their own icon, anything else a neutral tag; chips carry icon and text', () => {
  assert.deepEqual(['Everyday', 'Work', 'Business', 'Money', 'Life', 'Creative', 'Visual', ' EVERYDAY ', 'Gardening'].map(iconKeyFor), ['everyday', 'work', 'work', 'money', 'life', 'creative', 'visual', 'everyday', 'other']);
  for (const f of ['SparkCatalog', 'SparkDemo']) assert.match(src(`src/ui/experience/${f}.tsx`), /<ChipIcon category=/);
  assert.match(src('src/ui/experience/CategoryIcon.tsx'), /aria-hidden="true"/);
});
test('breakpoints: labelled sidebar from 1200px, tablet rail 768-1199px, phone bottom bar below 768px', () => {
  const css = src('src/ui/experience/experience.css');
  assert.match(css, /@media\(min-width:768px\) and \(max-width:1199px\)\{\s*\.hx \.shell\{grid-template-columns:76px/);
  assert.match(css, /@media\(max-width:767px\)\{\s*\.hx \.shell\{grid-template-columns:1fr\}\.hx \.sidebar\{display:none\}/);
  assert.match(css, /@media\(max-width:767px\)\{[^@]*\.mobile-nav\{display:grid/);
  assert.doesNotMatch(css, /@media\(max-width:989px\)\{[^@]*\.sidebar\{display:none/, 'the sidebar is no longer hidden at tablet widths');
});
test('Home has no journey bar; Hack, Lab and Reveal keep a compact one whose steps are links (navigation and the in-memory draft are untouched)', () => {
  const shell = src('src/ui/experience/Shell.tsx');
  assert.match(shell, /STEP_OF: Record<Page, number> = \{ spark: -1,/); assert.match(shell, /detail: 1, lab: 2, reveal: 3/);
  assert.match(shell, /STEP_OF\[page\] >= 0 \? <ol className="stepbar" aria-label="Journey">/); assert.match(shell, /<Link href=\{stepLinks\[i\]\}>/);
});
test('account access and the private-preview notice are available at every width: sidebar (desktop), rail menu (tablet), header menu (phone), notice strip below 1200px', () => {
  const shell = src('src/ui/experience/Shell.tsx'); const css = src('src/ui/experience/experience.css'); const menu = src('src/ui/account/AccountMenu.tsx');
  assert.match(shell, /<div className="side-account"><AccountChip \/><\/div>/); assert.match(shell, /<AccountMenu where="rail" \/>/); assert.match(shell, /<AccountMenu where="header" \/>/);
  assert.equal((shell.match(/PRIVATE PREVIEW · SAVING IS EXPLICIT/g) ?? []).length, 2, 'sidebar notice and the strip');
  assert.match(shell, /className="preview-strip" role="note"/); assert.match(css, /@media\(max-width:1199px\)\{\.hx \.preview-strip\{display:block\}\}/);
  assert.match(css, /\.account-menu-rail\{display:block\}/); assert.match(css, /\.account-menu-header\{display:block/); assert.match(css, /\.topbar\{display:none;/);
  assert.match(menu, /<details className=/); assert.match(menu, /aria-label=\{`Account menu: \$\{label\.name\}`\}/); assert.match(menu, /e\.key === 'Escape'/); assert.match(menu, /\[pathname\]/);
  assert.match(menu, /<AccountChip \/>/, 'the menu holds the same controls as the sidebar');
});
test('account menu summaries name the state, never claim "verified"', () => {
  assert.deepEqual(['anonymous', 'member', 'degraded', 'unavailable', 'checking'].map((s) => accountSummary(s).name), ['Not signed in', 'Signed in', 'Signed in, can’t check right now', 'Can’t check sign-in right now', 'Checking sign-in']);
  assert.equal(accountSummary('anonymous').short, 'Sign in'); assert.equal(accountSummary('member').short, 'Account');
});
test('phone category chips are ONE horizontally scrollable row with room for the focus ring (no wrapping, no clipping)', () => {
  const css = src('src/ui/experience/experience.css');
  assert.match(css, /@media\(max-width:767px\)\{[^@]*\.chips\{flex-wrap:nowrap;overflow-x:auto;/); assert.match(css, /\.chips\{[^}]*padding:6px 18px;scroll-padding:0 18px/); assert.match(css, /\.chip\{flex:none\}/);
});
