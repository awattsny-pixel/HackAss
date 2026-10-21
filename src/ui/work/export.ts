// "Download my data": the member's own prompts and results, collected in bounded pages (at most 50 rows per request) into one file the BROWSER builds. Nothing is
// uploaded anywhere. The collection is cancellable, bounded (a page cap derived from the counts), and reports progress.
import type { WorkApi } from './api.ts';

export interface ExportBundle { readonly exported_at: string; readonly counts: { readonly prompts: number; readonly results: number }; readonly prompts: readonly unknown[]; readonly results: readonly unknown[] }
export type ExportOutcome = { readonly ok: true; readonly bundle: ExportBundle } | { readonly ok: false; readonly kind: string };
export interface ExportProgress { readonly phase: 'prompts' | 'results'; readonly done: number; readonly total: number }
export const EXPORT_PAGE = 50;

export async function collectExport(api: Pick<WorkApi, 'exportPage'>, opts: { signal?: AbortSignal; onProgress?: (p: ExportProgress) => void } = {}): Promise<ExportOutcome> {
  const sum = await api.exportPage({ kind: 'summary' }, opts.signal);
  if (!sum.ok) return { ok: false, kind: sum.kind };
  if (sum.data.kind !== 'summary') return { ok: false, kind: 'unavailable' };
  const total = { prompts: sum.data.prompts, results: sum.data.results };
  const out: { prompts: unknown[]; results: unknown[] } = { prompts: [], results: [] };
  for (const phase of ['prompts', 'results'] as const) {
    let after: string | null = null;
    const maxPages = Math.ceil(total[phase] / EXPORT_PAGE) + 2;   // the counts bound the work: a server that never ends its pages cannot keep this running
    for (let page = 0; page < maxPages; page++) {
      if (opts.signal?.aborted) return { ok: false, kind: 'cancelled' };
      const r = await api.exportPage({ kind: phase, after, limit: EXPORT_PAGE }, opts.signal);
      if (!r.ok) return { ok: false, kind: r.kind };
      if (r.data.kind !== phase) return { ok: false, kind: 'unavailable' };      // a page of the wrong kind would make a wrong download
      out[phase].push(...r.data.items);
      opts.onProgress?.({ phase, done: out[phase].length, total: total[phase] });
      if (!r.data.next_after_id) break;
      after = r.data.next_after_id;
      if (page === maxPages - 1) return { ok: false, kind: 'unavailable' };      // still more pages than the counts allow
    }
  }
  return { ok: true, bundle: { exported_at: new Date().toISOString(), counts: total, prompts: out.prompts, results: out.results } };
}
export const exportFileName = (d: Date): string => `hackass-my-data-${d.toISOString().slice(0, 10)}.json`;
