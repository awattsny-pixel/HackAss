// PX-3c: the saved-work UI's pure parts (response interpretation, messages, export) and its source-level guarantees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpretWorkResponse } from '../src/ui/work/api.ts';
import type { ApiResult, WorkApi } from '../src/ui/work/api.ts';
import { collectExport, EXPORT_PAGE, exportFileName } from '../src/ui/work/export.ts';
import { failureText, fieldLabel, isRetryable, PRIVACY_NOTE, problemText, promptStatusText, resultStatusText } from '../src/ui/work/messages.ts';
import type { ProblemKind } from '../src/ui/experience/state.ts';
import { deleteWarning } from '../src/ui/work/delete-warning.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const walk = (d: string): string[] => readdirSync(join(root, d)).flatMap((n) => { const p = join(d, n); return statSync(join(root, p)).isDirectory() ? walk(p) : [p]; });
const src = (f: string) => readFileSync(join(root, f), 'utf8');
const code = (f: string) => src(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const workFiles = walk('src/ui/work');
const uiFiles = walk('src/ui').filter((f) => /\.(ts|tsx)$/.test(f));

test('responses are interpreted into a closed set of outcomes; unexpected answers are retryable "unavailable", never a guess', () => {
  const e = (status: number, code: string, more: object = {}, retry: string | null = null) => interpretWorkResponse(status, { error: { code, message: 'x', ...more } }, retry) as { ok: false; kind: string; field?: string; retryAfterSec?: number };
  assert.equal(interpretWorkResponse(200, { id: 'x' }).ok, true); assert.equal(interpretWorkResponse(201, { id: 'x' }).ok, true);
  assert.equal(e(401, 'unauthenticated').kind, 'unauthenticated'); assert.equal(e(403, 'forbidden').kind, 'forbidden'); assert.equal(e(403, 'setup_required').kind, 'setup_required');
  assert.equal(e(404, 'not_found').kind, 'not_found'); assert.equal(e(409, 'version_conflict').kind, 'version_conflict'); assert.equal(e(409, 'request_reuse').kind, 'request_reuse');
  assert.deepEqual([e(422, 'invalid_content', { field: 'prompt' }).kind, e(422, 'invalid_content', { field: 'prompt' }).field], ['invalid', 'prompt']);
  assert.equal(e(400, 'validation_failed', { fields: [{ path: 'prompt.title', code: 'too_big' }] }).field, 'prompt.title');
  assert.equal(e(429, 'quota_exceeded').kind, 'quota'); const rl = e(429, 'rate_limited', {}, '40'); assert.deepEqual([rl.kind, rl.retryAfterSec], ['rate_limited', 40]);
  assert.equal(e(413, 'payload_too_large').kind, 'too_large');
  for (const s of [500, 502, 503, 504, 0]) assert.equal((e(s, 'unauthenticated')).kind, 'unavailable', `HTTP ${s} is an outage even if it says unauthenticated`);
  assert.equal((interpretWorkResponse(418, null) as { kind: string }).kind, 'unavailable'); assert.equal((interpretWorkResponse(200, null) as { kind: string }).kind, 'unavailable'); assert.equal((interpretWorkResponse(200, 'text') as { kind: string }).kind, 'unavailable');
});

test('messages: every failure says the draft is still there; the privacy note never overclaims', () => {
  const kinds: ProblemKind[] = ['signin', 'setup', 'forbidden', 'quota', 'rate_limited', 'invalid', 'too_large', 'unavailable', 'gone', 'result_gone'];
  for (const k of kinds) assert.match(problemText({ kind: k, during: 'prompt_create', field: 'title', retryAfterSec: 30 }), /still here/, k);
  assert.match(problemText({ kind: 'incomplete', field: 'title', during: 'prompt_create' }), /name/); assert.match(problemText({ kind: 'incomplete', field: 'full_prompt', during: 'prompt_create' }), /Write the prompt/); assert.match(problemText({ kind: 'outcome', during: 'result_new' }), /worked/);
  assert.match(problemText({ kind: 'rate_limited', retryAfterSec: 296, during: 'both' }), /5 minutes/); assert.match(problemText({ kind: 'invalid', field: 'full_prompt', during: 'both' }), /the prompt/);
  assert.equal(isRetryable({ kind: 'unavailable', during: 'both' }), true); assert.equal(isRetryable({ kind: 'quota', during: 'both' }), false);
  assert.equal(PRIVACY_NOTE, "Private to your account; not shared with other members. Please don't store passwords or other secrets in prompts.");
  for (const f of uiFiles) assert.doesNotMatch(code(f), /only you can see|no human access|nobody (else )?can (see|read)|end-to-end encrypt|completely private|100% private/i, `${f} overclaims privacy`);
  assert.equal(promptStatusText('not_saved', null), 'Not saved'); assert.equal(promptStatusText('changed', 1), 'Changed since last save'); assert.match(promptStatusText('saved', Date.now()), /^Saved · /);
  assert.equal(promptStatusText('failed', null), 'Couldn’t save — your draft is still here'); assert.equal(promptStatusText('conflict', null), 'Saved elsewhere — choose'); assert.equal(promptStatusText('signin', null), 'Sign in to save'); assert.equal(promptStatusText('saving', null), 'Saving…');
  assert.match(resultStatusText('saved', 5), /^Result saved/); assert.equal(fieldLabel('(root).prompt'), 'the prompt (it is too long overall)'); assert.equal(fieldLabel('zzz'), 'one of the fields');
  for (const k of ['unauthenticated', 'not_found', 'unavailable', 'network']) assert.ok(failureText(k).length > 10);
  for (const m of [...kinds.map((k) => problemText({ kind: k, during: 'both' })), failureText('unavailable')]) assert.doesNotMatch(m, /PT\d|postgres|sql|saved_prompts|api\.|supabase/i, m);
});
test('the delete confirmation states the cascade with the real count', () => {
  assert.equal(deleteWarning(3), 'Deleting this prompt also permanently deletes its 3 saved results. This can’t be undone.');
  assert.match(deleteWarning(1), /its 1 saved result\./); assert.match(deleteWarning(0), /permanently removes it/);
});

// ---- export ---------------------------------------------------------------------------------------------------------------------------------------
function pagedApi(counts: { prompts: number; results: number }, over: { wrongKind?: boolean; failAt?: number; endless?: boolean } = {}): { api: Pick<WorkApi, 'exportPage'>; calls: { kind: string; after: string | null | undefined; limit: number | undefined }[] } {
  const calls: { kind: string; after: string | null | undefined; limit: number | undefined }[] = []; let n = 0;
  const api: Pick<WorkApi, 'exportPage'> = {
    async exportPage(a) {
      calls.push({ kind: a.kind, after: a.after, limit: a.limit }); n++;
      if (over.failAt === n) return { ok: false, kind: 'unavailable', status: 503 };
      if (a.kind === 'summary') return { ok: true, status: 200, data: { kind: 'summary', exported_at: 'x', ...counts } as never };
      const total = counts[a.kind], start = a.after ? Number(a.after) : 0, end = over.endless ? start + EXPORT_PAGE : Math.min(total, start + (a.limit ?? 25));
      const items = Array.from({ length: end - start }, (_, i) => ({ id: String(start + i + 1) }));
      const kind = over.wrongKind ? (a.kind === 'prompts' ? 'results' : 'prompts') : a.kind;
      return { ok: true, status: 200, data: { kind, items, page_size: a.limit ?? 25, next_after_id: end < total || over.endless ? String(end) : null } as never } as ApiResult<never>;
    },
  };
  return { api, calls };
}
test('export: bounded pages (≤50), complete, with progress; a wrong-kind page, a failure and a never-ending server all fail instead of producing a wrong file', async () => {
  const { api, calls } = pagedApi({ prompts: 120, results: 51 }); const seen: string[] = [];
  const r = await collectExport(api, { onProgress: (p) => seen.push(`${p.phase}:${p.done}/${p.total}`) });
  assert.ok(r.ok && r.bundle.prompts.length === 120 && r.bundle.results.length === 51 && r.bundle.counts.prompts === 120);
  assert.ok(calls.every((c) => c.kind === 'summary' || (c.limit ?? 0) <= 50)); assert.equal(calls.filter((c) => c.kind === 'prompts').length, 3); assert.equal(calls.filter((c) => c.kind === 'results').length, 2); assert.equal(seen.at(-1), 'results:51/51');
  const empty = await collectExport(pagedApi({ prompts: 0, results: 0 }).api); assert.ok(empty.ok && empty.bundle.prompts.length === 0);
  assert.deepEqual(await collectExport(pagedApi({ prompts: 5, results: 5 }, { wrongKind: true }).api), { ok: false, kind: 'unavailable' });
  assert.deepEqual(await collectExport(pagedApi({ prompts: 120, results: 0 }, { failAt: 3 }).api), { ok: false, kind: 'unavailable' });
  const endless = await collectExport(pagedApi({ prompts: 10, results: 0 }, { endless: true }).api); assert.deepEqual(endless, { ok: false, kind: 'unavailable' }, 'the page cap derived from the counts stops it');
  const c = new AbortController(); c.abort(); assert.deepEqual(await collectExport(pagedApi({ prompts: 5, results: 5 }).api, { signal: c.signal }), { ok: false, kind: 'cancelled' });
  assert.equal(exportFileName(new Date('2026-10-20T12:00:00Z')), 'hackass-my-data-2026-10-20.json');
});

// ---- source guarantees ------------------------------------------------------------------------------------------------------------------------------
test('the saved-work UI reaches only this application\'s /work endpoints, through one module, with same-origin credentials and no caching', () => {
  for (const f of workFiles) { if (f.endsWith('api.ts')) continue; assert.doesNotMatch(code(f), /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/, `${f} must not call the network directly`); }
  const api = code('src/ui/work/api.ts');
  assert.match(api, /credentials: 'same-origin', cache: 'no-store'/); assert.equal((api.match(/\bfetch\(/g) ?? []).length, 1, 'one fetch call');
  for (const m of api.matchAll(/call\('(?:GET|POST|PUT|DELETE)', [`'](\/[^`'$]*)/g)) assert.match(m[1], /^\/work\//, m[1]);
  assert.doesNotMatch(api, /\/auth\/|supabase|https?:\/\//i);
});
test('no browser storage, cookies, raw HTML, database/Auth client, environment or token handling in the saved-work UI', () => {
  for (const f of workFiles) {
    const c = code(f);
    assert.doesNotMatch(c, /localStorage|sessionStorage|indexedDB|document\.cookie|dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function/, f);
    assert.doesNotMatch(c, /@supabase|platform\/db|platform\/env|platform\/server|process\.env|access_token|refresh_token|service_role|createClient|console\./, f);
  }
  assert.doesNotMatch(code('src/ui/experience/store.ts'), /localStorage|sessionStorage|indexedDB|document\.cookie/);
});
test('private content is rendered as text only and never placed in URLs or the page title', () => {
  for (const f of workFiles.filter((x) => x.endsWith('.tsx'))) {
    const c = code(f);
    assert.doesNotMatch(c, /document\.title|history\.(push|replace)State|location\.(href|search|hash)\s*=/, f);
    for (const m of c.matchAll(/href=\{`([^`]*)`\}/g)) assert.match(m[1], /^\/account\/(prompts|results)\/\$\{(i\.id|d\.prompt_id)\}$|^\/account\/sign-in\?next=\$\{encodeURIComponent\(next\)\}$|^\/account\/(prompts|results)\/\$\{id\}$/, `${f}: a link may carry only an item id (${m[1]})`);
  }
  const ex = code('src/ui/work/ExportPanel.tsx'); assert.match(ex, /new Blob\(/); assert.match(ex, /URL\.revokeObjectURL/);
});
test('the pages: list/detail reads never edit the draft, and sign-in links keep the return path', () => {
  const dirs = readdirSync(join(root, 'app/(experience)/account')).sort(); assert.deepEqual(dirs, ['prompts', 'recover', 'results', 'sign-in']);
  for (const f of ['MyPromptsScreen', 'MyResultsScreen', 'PromptDetailScreen', 'ResultDetailScreen']) assert.doesNotMatch(code(`src/ui/work/${f}.tsx`), /dispatch\(\{ type: '(editPrompt|editField|startBlank|startFromHack|resetDraft|reflect|regenerate)/, `${f} never edits the draft`);
  assert.match(code('src/ui/work/WorkChrome.tsx'), /account\/sign-in\?next=\$\{encodeURIComponent\(next\)\}/); assert.match(code('src/ui/work/SavePanel.tsx'), /sign-in\?next=%2Flab/); assert.match(code('src/ui/work/ResultSavePanel.tsx'), /sign-in\?next=%2Freveal/);
  assert.match(code('src/ui/account/AccountChip.tsx'), /'\/account\/prompts', '\/account\/results'/);
});
test('destructive actions are confirmed with Cancel as the default, delete states the cascade, and overwrite/load need explicit confirmation', () => {
  assert.match(code('src/ui/experience/ConfirmDialog.tsx'), /autoFocus onClick=\{onCancel\}/);
  const pd = code('src/ui/work/PromptDetailScreen.tsx'); assert.match(pd, /message: deleteWarning\(d\.result_count\)/); assert.match(pd, /danger: true/);
  const cp = code('src/ui/work/ConflictPanel.tsx'); assert.equal((cp.match(/confirm\(\{/g) ?? []).length, 2, 'load-saved and overwrite are both confirmed'); assert.match(cp, /work\.saveCopy\(\)/);
  assert.match(code('src/ui/work/ResultDetailScreen.tsx'), /Overwrite the saved result\?/);
});
test('Save is explicit: no autosave timers, and every save call sits in a click handler', () => {
  for (const f of uiFiles) assert.doesNotMatch(code(f), /setInterval\(/, f);
  for (const f of ['SavePanel', 'ResultSavePanel']) { const c = code(`src/ui/work/${f}.tsx`); for (const m of c.matchAll(/work\.(savePrompt|saveResult)\(/g)) assert.ok(c.slice(Math.max(0, m.index! - 160), m.index!).includes('onClick'), `${f}: a save call outside a click handler`); assert.doesNotMatch(c, /useEffect/, `${f}: no effects`); }
});
