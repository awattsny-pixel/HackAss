// Module boundary: other code may import only this file (see docs/adr/0001-foundation.md).
// PX-3b: a member's PRIVATE saved prompts and results ("My prompts", "My results"). A thin, validating wrapper around the eleven member functions of
// PX-3a (schema `api`). It holds no database client, no cookie and no environment access: the composition root (app/work/**) supplies a handle that
// can only call those eleven functions, after it has verified the member at T2. The owner is NEVER a parameter: the database derives it from the session
// (guard `app_guard.require_member()`), so there is nothing here a caller could set to reach another member's rows.
//  * Request bodies are parsed with strict schemas (unknown keys, including any owner field, are refused) and reported by field NAME only, never value.
//  * Responses are parsed against allowlists; a malformed answer is `invalid_response`, never passed through.
//  * `replay` and `superseded` are part of the receipt contract. A retried create answers with the ORIGINAL operation's receipt; `superseded: true` means the
//    stored item has moved on since (another tab edited it), so the caller must reconcile instead of treating the receipt's version as current.
//  * Failure kinds carry no database text, no value from the request and no id.
import { z } from 'zod';

export const MODULE_NAME = 'mywork' as const;

// ---- limits (the database enforces the same structural lengths; these give early, field-named answers) ------------------------------------------------
/** The output formats the Lab offers. The database keeps only a length limit on the field, so this list is the allowlist (PX-3 decision). */
export const OUTPUT_FORMATS = ['Clear step-by-step plan', 'Comparison table', 'Creative draft', 'Concise summary'] as const;
export const OUTCOMES = ['yes', 'partial', 'no', 'notyet'] as const;
export const LIMITS = Object.freeze({ title: 120, goal: 2000, context: 4000, prompt: 20000, originTitle: 200, slug: 80, reflection: 4000, nextChange: 500, pageMax: 100, exportPageMax: 50 });
/** Largest request bodies the handlers accept (bytes). The prompt document cap in the database is 128 KiB; a result document is 16 KiB. */
export const BODY_LIMITS = Object.freeze({ prompt: 136 * 1024, result: 24 * 1024, both: 160 * 1024 });

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(LIMITS.slug);
const requestId = z.uuid();
const version = z.number().int().min(1).max(2_147_483_647);
const text = (min: number, max: number) => z.string().min(min).max(max);

const promptDocSchema = z.strictObject({
  title: text(1, LIMITS.title).refine((s) => s.trim().length > 0),
  goal: z.string().max(LIMITS.goal).default(''),
  context: z.string().max(LIMITS.context).default(''),
  output_format: z.enum(OUTPUT_FORMATS),
  full_prompt: text(1, LIMITS.prompt),
  starting_prompt: z.string().max(LIMITS.prompt).default(''),
  origin_kind: z.enum(['scratch', 'catalog', 'demo']),
  origin_slug: slug.optional(),
  origin_title: text(1, LIMITS.originTitle).optional(),
}).refine((d) => (d.origin_kind === 'catalog') === (d.origin_slug !== undefined), { path: ['origin_slug'] });
const resultDocSchema = z.strictObject({
  outcome: z.enum(OUTCOMES),
  reflection: z.string().max(LIMITS.reflection).default(''),
  next_change: z.string().max(LIMITS.nextChange).default(''),
});
export type PromptDoc = z.infer<typeof promptDocSchema>;
export type ResultDoc = z.infer<typeof resultDocSchema>;

// ---- request parsing -----------------------------------------------------------------------------------------------------------------------------
export interface FieldProblem { readonly path: string; readonly code: string }
export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fields: readonly FieldProblem[] };
const SAFE_SEGMENT = /[^A-Za-z0-9_-]/g;
function parse<S extends z.ZodType>(schema: S, input: unknown): Parsed<z.output<S>> {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, fields: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.map((p) => String(p).replace(SAFE_SEGMENT, '_').slice(0, 40)).join('.') || '(root)', code: i.code })) };
}
const idSchema = z.uuid();
/** True for a well-formed id. A malformed id is treated EXACTLY like an id that does not exist (not_found), so probing reveals nothing. */
export const isId = (v: unknown): v is string => idSchema.safeParse(v).success;

export interface CreatePromptRequest { readonly requestId: string; readonly doc: PromptDoc }
export interface UpdatePromptRequest extends CreatePromptRequest { readonly expectedVersion: number }
export interface SaveResultRequest { readonly requestId: string; readonly expectedPromptVersion: number; readonly doc: ResultDoc }
export interface SaveBothRequest { readonly requestId: string; readonly prompt: PromptDoc; readonly result: ResultDoc; readonly promptId?: string; readonly expectedPromptVersion?: number }
export interface UpdateResultRequest { readonly expectedVersion: number; readonly doc: ResultDoc }

export const parseCreatePrompt = (b: unknown) => parse(z.strictObject({ request_id: requestId, prompt: promptDocSchema }).transform((v) => ({ requestId: v.request_id, doc: v.prompt })), b);
export const parseUpdatePrompt = (b: unknown) => parse(z.strictObject({ request_id: requestId, expected_version: version, prompt: promptDocSchema }).transform((v) => ({ requestId: v.request_id, expectedVersion: v.expected_version, doc: v.prompt })), b);
export const parseSaveResult = (b: unknown) => parse(z.strictObject({ request_id: requestId, expected_prompt_version: version, result: resultDocSchema }).transform((v) => ({ requestId: v.request_id, expectedPromptVersion: v.expected_prompt_version, doc: v.result })), b);
export const parseSaveBoth = (b: unknown) => parse(z.strictObject({ request_id: requestId, prompt: promptDocSchema, result: resultDocSchema, prompt_id: idSchema.optional(), expected_prompt_version: version.optional() })
  .refine((v) => (v.prompt_id === undefined) === (v.expected_prompt_version === undefined), { path: ['expected_prompt_version'] })
  .transform((v): SaveBothRequest => ({ requestId: v.request_id, prompt: v.prompt, result: v.result, ...(v.prompt_id !== undefined ? { promptId: v.prompt_id, expectedPromptVersion: v.expected_prompt_version } : {}) })), b);
export const parseUpdateResult = (b: unknown) => parse(z.strictObject({ expected_version: version, result: resultDocSchema }).transform((v) => ({ expectedVersion: v.expected_version, doc: v.result })), b);
/** `?expected_version=` of a DELETE (no body). */
export const parseExpectedVersion = (raw: string | null): Parsed<number> => parse(z.coerce.number().pipe(version), raw === null || !/^\d{1,10}$/.test(raw) ? undefined : raw);

export interface PromptCursor { readonly updated_at: string; readonly id: string }
export interface ResultCursor { readonly created_at: string; readonly id: string }
const ts = z.iso.datetime({ offset: true });
const intParam = (raw: string | null, dflt: number) => (raw === null ? dflt : /^\d{1,4}$/.test(raw) ? Number(raw) : NaN);
export const parseListPrompts = (q: URLSearchParams) => parse(z.object({ limit: z.number().int().min(1).max(LIMITS.pageMax), after: z.object({ updated_at: ts, id: idSchema }).nullable() }), {
  limit: intParam(q.get('limit'), 25), after: q.get('after_id') || q.get('after_updated_at') ? { updated_at: q.get('after_updated_at'), id: q.get('after_id') } : null });
export const parseListResults = (q: URLSearchParams) => parse(z.object({ limit: z.number().int().min(1).max(LIMITS.pageMax), outcome: z.enum(OUTCOMES).nullable(), after: z.object({ created_at: ts, id: idSchema }).nullable() }), {
  limit: intParam(q.get('limit'), 25), outcome: q.get('outcome'), after: q.get('after_id') || q.get('after_created_at') ? { created_at: q.get('after_created_at'), id: q.get('after_id') } : null });
export const parseExport = (q: URLSearchParams) => parse(z.object({ kind: z.enum(['summary', 'prompts', 'results']), limit: z.number().int().min(1).max(LIMITS.exportPageMax), after: idSchema.nullable() }), {
  kind: q.get('kind'), limit: intParam(q.get('limit'), 25), after: q.get('after_id') });

// ---- responses (allowlists) ----------------------------------------------------------------------------------------------------------------------
const flags = { replay: z.boolean().optional(), superseded: z.boolean().optional() };
const origin = { origin_kind: z.enum(['scratch', 'catalog', 'demo']), origin_slug: z.string().max(LIMITS.slug).nullable(), origin_title: z.string().max(LIMITS.originTitle).nullable() };
const promptReceipt = z.object({ id: z.uuid(), version, updated_at: ts, ...flags });
const resultReceipt = z.object({ id: z.uuid(), version, created_at: ts, prompt_version: version, ...flags });
const resultUpdateReceipt = z.object({ id: z.uuid(), version, updated_at: ts });
const bothReceipt = z.object({ prompt: z.object({ id: z.uuid(), version, updated_at: ts }), result: z.object({ id: z.uuid(), version, created_at: ts }), ...flags });
const promptDetail = z.object({ id: z.uuid(), version, title: z.string(), goal: z.string(), context: z.string(), output_format: z.string(), full_prompt: z.string(), starting_prompt: z.string(), ...origin,
  created_at: ts, updated_at: ts, result_count: z.number().int().min(0) });
const promptItem = z.object({ id: z.uuid(), version, title: z.string(), snippet: z.string(), ...origin, updated_at: ts });
const resultItem = z.object({ id: z.uuid(), version, prompt_id: z.uuid().nullable().optional(), title: z.string(), outcome: z.enum(OUTCOMES), snippet: z.string(), ...origin, created_at: ts });
const resultDetail = z.object({ id: z.uuid(), version, outcome: z.enum(OUTCOMES), reflection: z.string(), next_change: z.string(), attempted_prompt: z.string(), starting_prompt: z.string(), title: z.string(),
  prompt_version: version, prompt_id: z.uuid().nullable().optional(), ...origin, created_at: ts, updated_at: ts });
const page = <T extends z.ZodType, C extends z.ZodType>(item: T, cursor: C) => z.object({ items: z.array(item).max(LIMITS.pageMax), page_size: z.number().int().min(1).max(LIMITS.pageMax), next_cursor: cursor.nullable() });
const promptPage = page(promptItem, z.object({ updated_at: ts, id: z.uuid() }));
const resultPage = page(resultItem, z.object({ created_at: ts, id: z.uuid() }));
const exportSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('summary'), exported_at: ts, prompts: z.number().int().min(0), results: z.number().int().min(0) }),
  z.object({ kind: z.literal('prompts'), items: z.array(promptDetail.omit({ result_count: true })).max(LIMITS.exportPageMax), page_size: z.number().int(), next_after_id: z.uuid().nullable() }),
  z.object({ kind: z.literal('results'), items: z.array(resultDetail.omit({ title: true }).extend({ prompt_title: z.string() })).max(LIMITS.exportPageMax), page_size: z.number().int(), next_after_id: z.uuid().nullable() }),
]);

export type PromptReceipt = z.infer<typeof promptReceipt>;
export type ResultReceipt = z.infer<typeof resultReceipt>;
export type BothReceipt = z.infer<typeof bothReceipt>;
export type PromptDetail = z.infer<typeof promptDetail>;
export type ResultDetail = z.infer<typeof resultDetail>;
export type PromptPage = z.infer<typeof promptPage>;
export type ResultPage = z.infer<typeof resultPage>;
export type ExportPage = z.infer<typeof exportSchema>;

// ---- failures --------------------------------------------------------------------------------------------------------------------------------------
/**
 *  unauthenticated  the database guard refused the session (revoked or expired)       denied          the account may not use this
 *  not_found        no such item FOR THIS MEMBER (indistinguishable from another member's) version_conflict  the item changed since the version the caller holds
 *  request_reuse    the request id was already used for DIFFERENT content, parent or version
 *  invalid_content  a field was refused (`field` names it, never its value)           quota_exceeded  a per-member or per-prompt limit
 *  unavailable      the database could not be reached or errored                        invalid_response  the database answered with something unexpected
 */
export type WorkFailureKind = 'unauthenticated' | 'denied' | 'not_found' | 'version_conflict' | 'request_reuse' | 'invalid_content' | 'quota_exceeded' | 'unavailable' | 'invalid_response';
export interface WorkFailure { readonly ok: false; readonly kind: WorkFailureKind; /** only for invalid_content, only a field NAME */ readonly field?: string }
export type WorkResult<T> = { readonly ok: true; readonly data: T } | WorkFailure;

/** The only database capability the module receives: call one named function of the `api` schema. */
export type WorkFunction = 'save_prompt' | 'get_my_prompt' | 'list_my_prompts' | 'delete_my_prompt' | 'save_reflection' | 'save_prompt_and_result' | 'update_my_reflection' | 'delete_my_reflection' | 'list_my_results' | 'get_my_result' | 'export_my_data';
export interface WorkRpc {
  rpc(fn: WorkFunction, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null; status?: number }>;
}
type RpcError = { code?: string; message?: string; details?: string } | null;
const FIELD_NAME = /^(\(root\)\.)?[a-z_]{1,40}(\.[a-z_]{1,40})?$/;

/** Maps a database/HTTP error to a kind WITHOUT carrying any database text into the result (the field name is copied only if it is a plain identifier). */
export function classifyWorkFailure(error: RpcError, status?: number): WorkFailure {
  const code = error?.code ?? '', msg = error?.message ?? '';
  // Availability comes FIRST: a transport failure (status 0 / none) or an HTTP 5xx/408 is a retryable outage whatever code or text rode along with it.
  // A database verdict (not found, conflict, denied, unauthenticated, quota, invalid) is only believed on an answer the database itself gave (a 4xx).
  if (status !== undefined && (status === 0 || status === 408 || status >= 500)) return { ok: false, kind: 'unavailable' };
  if (code === 'PT404') return { ok: false, kind: 'not_found' };
  if (code === 'PT409') return { ok: false, kind: msg === 'request_reuse' ? 'request_reuse' : 'version_conflict' };
  if (code === 'PT429') return { ok: false, kind: 'quota_exceeded' };
  if (code === 'PT422') { const d = error?.details; return { ok: false, kind: 'invalid_content', ...(typeof d === 'string' && FIELD_NAME.test(d) ? { field: d } : {}) }; }
  if (code === '28000' || status === 401 || code === 'PGRST301' || code === 'PGRST302') return { ok: false, kind: 'unauthenticated' };
  if (code === '42501' || status === 403) return { ok: false, kind: 'denied' };
  return { ok: false, kind: 'unavailable' };
}

async function run<S extends z.ZodType>(db: WorkRpc, fn: WorkFunction, args: Record<string, unknown>, schema: S): Promise<WorkResult<z.output<S>>> {
  let res: Awaited<ReturnType<WorkRpc['rpc']>>;
  try { res = await db.rpc(fn, args); } catch { return { ok: false, kind: 'unavailable' }; }
  if (res.error) return classifyWorkFailure(res.error, res.status);
  const parsed = schema.safeParse(res.data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, kind: 'invalid_response' };
}
const NOT_FOUND: WorkFailure = { ok: false, kind: 'not_found' };
const deleted = z.object({ deleted: z.literal(true), results_deleted: z.number().int().min(0).optional() });
const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ---- prompts ---------------------------------------------------------------------------------------------------------------------------------------
export const createPrompt = (db: WorkRpc, r: CreatePromptRequest) => run(db, 'save_prompt', { p_request_id: r.requestId, p_doc: clean(r.doc) }, promptReceipt);
export const updatePrompt = (db: WorkRpc, id: string, r: UpdatePromptRequest) => isId(id) ? run(db, 'save_prompt', { p_request_id: r.requestId, p_doc: clean(r.doc), p_id: id, p_expected_version: r.expectedVersion }, promptReceipt) : Promise.resolve(NOT_FOUND);
export const getPrompt = (db: WorkRpc, id: string) => isId(id) ? run(db, 'get_my_prompt', { p_id: id }, promptDetail) : Promise.resolve(NOT_FOUND);
export const listPrompts = (db: WorkRpc, a: { limit: number; after: { updated_at: string; id: string } | null }) =>
  run(db, 'list_my_prompts', { p_limit: a.limit, p_after_updated_at: a.after?.updated_at ?? null, p_after_id: a.after?.id ?? null }, promptPage);
export const deletePrompt = (db: WorkRpc, id: string, expectedVersion: number) => isId(id) ? run(db, 'delete_my_prompt', { p_id: id, p_expected_version: expectedVersion }, deleted) : Promise.resolve(NOT_FOUND);

// ---- results ---------------------------------------------------------------------------------------------------------------------------------------
export const saveResult = (db: WorkRpc, promptId: string, r: SaveResultRequest) => isId(promptId)
  ? run(db, 'save_reflection', { p_request_id: r.requestId, p_prompt_id: promptId, p_expected_prompt_version: r.expectedPromptVersion, p_doc: clean(r.doc) }, resultReceipt) : Promise.resolve(NOT_FOUND);
export const savePromptAndResult = (db: WorkRpc, r: SaveBothRequest) =>
  run(db, 'save_prompt_and_result', { p_request_id: r.requestId, p_prompt_doc: clean(r.prompt), p_result_doc: clean(r.result), p_id: r.promptId ?? null, p_expected_version: r.expectedPromptVersion ?? null }, bothReceipt);
export const updateResult = (db: WorkRpc, id: string, r: UpdateResultRequest) => isId(id) ? run(db, 'update_my_reflection', { p_id: id, p_expected_version: r.expectedVersion, p_doc: clean(r.doc) }, resultUpdateReceipt) : Promise.resolve(NOT_FOUND);
export const getResult = (db: WorkRpc, id: string) => isId(id) ? run(db, 'get_my_result', { p_id: id }, resultDetail) : Promise.resolve(NOT_FOUND);
export const listResults = (db: WorkRpc, a: { limit: number; outcome: (typeof OUTCOMES)[number] | null; after: { created_at: string; id: string } | null }) =>
  run(db, 'list_my_results', { p_limit: a.limit, p_outcome: a.outcome, p_after_created_at: a.after?.created_at ?? null, p_after_id: a.after?.id ?? null }, resultPage);
export const deleteResult = (db: WorkRpc, id: string, expectedVersion: number) => isId(id) ? run(db, 'delete_my_reflection', { p_id: id, p_expected_version: expectedVersion }, deleted) : Promise.resolve(NOT_FOUND);

// ---- export ----------------------------------------------------------------------------------------------------------------------------------------
/** The returned kind must equal the requested kind: a valid page of another kind would make an incomplete or wrong download, so it is `invalid_response`. */
export const exportMyData = async (db: WorkRpc, a: { kind: 'summary' | 'prompts' | 'results'; after: string | null; limit: number }): Promise<WorkResult<ExportPage>> => {
  const r = await run(db, 'export_my_data', { p_kind: a.kind, p_after_id: a.after, p_limit: a.limit }, exportSchema);
  return r.ok && r.data.kind !== a.kind ? { ok: false, kind: 'invalid_response' } : r;
};

// ---- HTTP contract (shared by the handlers and their tests) ------------------------------------------------------------------------------------------
export interface FailureResponse { readonly status: number; readonly code: string; readonly message: string }
const RESPONSES: Record<WorkFailureKind, FailureResponse> = {
  unauthenticated: { status: 401, code: 'unauthenticated', message: 'Please sign in again.' },
  denied: { status: 403, code: 'forbidden', message: 'This account cannot use saved work.' },
  not_found: { status: 404, code: 'not_found', message: 'That item was not found.' },
  version_conflict: { status: 409, code: 'version_conflict', message: 'This changed since you opened it. Reload it before saving again.' },
  request_reuse: { status: 409, code: 'request_reuse', message: 'That save was already used for different content. Start a new save.' },
  invalid_content: { status: 422, code: 'invalid_content', message: 'Some of that could not be saved.' },
  quota_exceeded: { status: 429, code: 'quota_exceeded', message: 'You have reached a saved-work limit. Delete something to make room.' },
  unavailable: { status: 503, code: 'unavailable', message: 'Saving is unavailable right now. Your text is still here; try again shortly.' },
  invalid_response: { status: 502, code: 'bad_response', message: 'Saving is unavailable right now. Your text is still here; try again shortly.' },
};
export const failureResponse = (kind: WorkFailureKind): FailureResponse => RESPONSES[kind];
