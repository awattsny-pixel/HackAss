// The browser's ONLY way to reach saved work: this application's own /work/** endpoints (same origin, session cookie). No database client, no token and no
// Auth call here. Every answer is interpreted into a small closed set of outcomes; provider or database text is never shown. A request that cannot be
// completed (network error, timeout) is `network`: for a write the outcome is UNKNOWN, which is why saves retry under the same request id.
import type { ExportPage, PromptDetail, PromptPage, ResultDetail, ResultPage } from '../../modules/mywork/index.ts';

export type ApiFailureKind = 'unauthenticated' | 'setup_required' | 'forbidden' | 'not_found' | 'version_conflict' | 'request_reuse' | 'invalid' | 'quota' | 'rate_limited' | 'too_large' | 'unavailable' | 'network';
export interface ApiFailure { readonly ok: false; readonly kind: ApiFailureKind; readonly status: number; readonly field?: string; readonly retryAfterSec?: number }
export type ApiResult<T> = { readonly ok: true; readonly data: T; readonly status: number } | ApiFailure;

export interface PromptReceipt { readonly id: string; readonly version: number; readonly updated_at: string; readonly replay?: boolean; readonly superseded?: boolean }
export interface ResultReceipt { readonly id: string; readonly version: number; readonly created_at: string; readonly prompt_version: number; readonly replay?: boolean; readonly superseded?: boolean }
export interface ResultUpdateReceipt { readonly id: string; readonly version: number; readonly updated_at: string }
export interface BothReceipt { readonly prompt: { readonly id: string; readonly version: number; readonly updated_at: string }; readonly result: { readonly id: string; readonly version: number; readonly created_at: string }; readonly replay?: boolean; readonly superseded?: boolean }
export interface PromptDocBody { title: string; goal: string; context: string; output_format: string; full_prompt: string; starting_prompt: string; origin_kind: 'scratch' | 'catalog' | 'demo'; origin_slug?: string; origin_title?: string }
export interface ResultDocBody { outcome: string; reflection: string; next_change: string }
export type Cursor = { readonly updated_at?: string; readonly created_at?: string; readonly id: string } | null;

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const ver = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const isPromptReceipt = (d: unknown): d is PromptReceipt => obj(d) && str(d.id) && ver(d.version) && str(d.updated_at);
const isResultReceipt = (d: unknown): d is ResultReceipt => obj(d) && str(d.id) && ver(d.version) && ver(d.prompt_version);
const isResultUpdate = (d: unknown): d is ResultUpdateReceipt => obj(d) && str(d.id) && ver(d.version);
const isBoth = (d: unknown): d is BothReceipt => obj(d) && obj(d.prompt) && str(d.prompt.id) && ver(d.prompt.version) && obj(d.result) && str(d.result.id) && ver(d.result.version);
const isPromptDetail = (d: unknown): d is PromptDetail => obj(d) && str(d.id) && ver(d.version) && typeof d.title === 'string' && typeof d.full_prompt === 'string' && typeof d.result_count === 'number';
const isResultDetail = (d: unknown): d is ResultDetail => obj(d) && str(d.id) && ver(d.version) && typeof d.outcome === 'string' && typeof d.attempted_prompt === 'string';
const isPage = (d: unknown): boolean => obj(d) && Array.isArray(d.items);
const isDeleted = (d: unknown): d is { deleted: true; results_deleted?: number } => obj(d) && d.deleted === true;
const isExport = (d: unknown): d is ExportPage => obj(d) && (d.kind === 'summary' || d.kind === 'prompts' || d.kind === 'results');

/** Pure: turns an HTTP answer into an outcome. Anything unexpected is `unavailable` (retryable), never a guess about the member's input. */
export function interpretWorkResponse(status: number, body: unknown, retryAfterHeader: string | null = null): ApiResult<unknown> {
  if ((status === 200 || status === 201) && obj(body)) return { ok: true, data: body, status };
  const e = obj(body) && obj(body.error) ? body.error : null;
  const code = e && typeof e.code === 'string' ? e.code : '';
  const fail = (kind: ApiFailureKind, more: Partial<ApiFailure> = {}): ApiFailure => ({ ok: false, kind, status, ...more });
  if (status >= 500 || status === 0) return fail('unavailable');
  if (status === 401) return fail('unauthenticated');
  if (status === 403) return fail(code === 'setup_required' ? 'setup_required' : 'forbidden');
  if (status === 404) return fail('not_found');
  if (status === 409) return fail(code === 'request_reuse' ? 'request_reuse' : 'version_conflict');
  if (status === 413) return fail('too_large');
  if (status === 422) return fail('invalid', typeof e?.field === 'string' ? { field: e.field } : {});
  if (status === 400) { const f = obj(body) && e && Array.isArray(e.fields) && obj(e.fields[0]) && typeof e.fields[0].path === 'string' ? e.fields[0].path : undefined; return fail('invalid', f ? { field: f } : {}); }
  if (status === 429) { const n = Number(retryAfterHeader) || (obj(body) && typeof body.retryAfterSec === 'number' ? body.retryAfterSec : undefined); return code === 'quota_exceeded' ? fail('quota') : fail('rate_limited', n ? { retryAfterSec: n } : {}); }
  return fail('unavailable');
}

export const REQUEST_TIMEOUT_MS = 20_000;
async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<ApiResult<unknown>> {
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { return { ok: false, kind: 'network', status: 0 }; }
  let json: unknown = null; try { json = await res.json(); } catch { json = null; }
  return interpretWorkResponse(res.status, json, res.headers.get('retry-after'));
}
function shaped<T>(r: ApiResult<unknown>, ok: (d: unknown) => boolean): ApiResult<T> {
  if (!r.ok) return r;
  return ok(r.data) ? (r as ApiResult<T>) : { ok: false, kind: 'unavailable', status: r.status };
}
const enc = encodeURIComponent;
const q = (pairs: Record<string, string | number | null | undefined>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(pairs)) if (v !== null && v !== undefined) p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ''; };

/** The operations the screens use. A fake with the same shape stands in for it in tests. */
export interface WorkApi {
  createPrompt(req: { request_id: string; prompt: PromptDocBody }): Promise<ApiResult<PromptReceipt>>;
  updatePrompt(id: string, req: { request_id: string; expected_version: number; prompt: PromptDocBody }): Promise<ApiResult<PromptReceipt>>;
  getPrompt(id: string, signal?: AbortSignal): Promise<ApiResult<PromptDetail>>;
  listPrompts(a: { limit?: number; after?: Cursor }, signal?: AbortSignal): Promise<ApiResult<PromptPage>>;
  deletePrompt(id: string, expectedVersion: number): Promise<ApiResult<{ deleted: true; results_deleted?: number }>>;
  saveResult(promptId: string, req: { request_id: string; expected_prompt_version: number; result: ResultDocBody }): Promise<ApiResult<ResultReceipt>>;
  saveBoth(req: { request_id: string; prompt: PromptDocBody; result: ResultDocBody; prompt_id?: string; expected_prompt_version?: number }): Promise<ApiResult<BothReceipt>>;
  updateResult(id: string, req: { expected_version: number; result: ResultDocBody }): Promise<ApiResult<ResultUpdateReceipt>>;
  getResult(id: string, signal?: AbortSignal): Promise<ApiResult<ResultDetail>>;
  listResults(a: { limit?: number; outcome?: string | null; after?: Cursor }, signal?: AbortSignal): Promise<ApiResult<ResultPage>>;
  deleteResult(id: string, expectedVersion: number): Promise<ApiResult<{ deleted: true }>>;
  exportPage(a: { kind: 'summary' | 'prompts' | 'results'; after?: string | null; limit?: number }, signal?: AbortSignal): Promise<ApiResult<ExportPage>>;
}

export const workApi: WorkApi = {
  createPrompt: async (req) => shaped(await call('POST', '/work/prompts', req), isPromptReceipt),
  updatePrompt: async (id, req) => shaped(await call('PUT', `/work/prompts/${enc(id)}`, req), isPromptReceipt),
  getPrompt: async (id, signal) => shaped(await call('GET', `/work/prompts/${enc(id)}`, undefined, signal), isPromptDetail),
  listPrompts: async (a, signal) => shaped(await call('GET', `/work/prompts${q({ limit: a.limit, after_updated_at: a.after?.updated_at, after_id: a.after?.id })}`, undefined, signal), isPage),
  deletePrompt: async (id, v) => shaped(await call('DELETE', `/work/prompts/${enc(id)}${q({ expected_version: v })}`), isDeleted),
  saveResult: async (pid, req) => shaped(await call('POST', `/work/prompts/${enc(pid)}/results`, req), isResultReceipt),
  saveBoth: async (req) => shaped(await call('POST', '/work/saves', req), isBoth),
  updateResult: async (id, req) => shaped(await call('PUT', `/work/results/${enc(id)}`, req), isResultUpdate),
  getResult: async (id, signal) => shaped(await call('GET', `/work/results/${enc(id)}`, undefined, signal), isResultDetail),
  listResults: async (a, signal) => shaped(await call('GET', `/work/results${q({ limit: a.limit, outcome: a.outcome, after_created_at: a.after?.created_at, after_id: a.after?.id })}`, undefined, signal), isPage),
  deleteResult: async (id, v) => shaped(await call('DELETE', `/work/results/${enc(id)}${q({ expected_version: v })}`), isDeleted),
  exportPage: async (a, signal) => shaped(await call('GET', `/work/export${q({ kind: a.kind, after_id: a.after, limit: a.limit })}`, undefined, signal), isExport),
};
