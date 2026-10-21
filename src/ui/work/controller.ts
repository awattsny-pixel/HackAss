// The save controller: every rule of the Save / Save this result journey, with the network injected so delayed, lost and out-of-order responses can be tested.
//  * Explicit save only. One save in flight at a time. A save submits a captured revision and content, from a captured draft GENERATION (epoch); the reducer applies
//    its answer only to that generation and marks only that revision saved. Replacing, resetting or detaching the draft starts a new generation, so an answer for
//    the old text can never mark the new draft saved.
//  * A failed save never touches the draft. A retry of unchanged content reuses its request id (so an identical retry is accepted, never duplicated);
//    changed content gets a new one; a conflict choice ("save as a copy", "overwrite") always starts a FRESH intent.
//  * A receipt flagged `superseded`, or a version conflict after a lost response, is RECONCILED, not trusted: the saved copy is fetched and the save counts as
//    done only if it equals what was submitted. A combined save is reconciled on BOTH halves (the prompt and the result).
//  * The conflict choices act on the conflicting item itself: "Overwrite" updates that item at the version that is saved now (even when this draft had no link
//    to it yet, as after a superseded first create); it never issues another create.
import type { Action, Conflict, ExperienceState, Problem, ProblemKind, SaveOp } from '../experience/state.ts';
import type { ApiFailure, PromptDocBody, ResultDocBody, WorkApi } from './api.ts';
import { buildPromptDoc, buildResultDoc, promptMatches, resultMatches } from './doc.ts';

export interface ControllerDeps { readonly api: WorkApi; readonly getState: () => ExperienceState; readonly dispatch: (a: Action) => void; readonly newId: () => string; readonly now: () => number }
export type Outcome = 'started' | 'busy' | 'refused';
export interface SaveOptions { /** Start a new intent (new request id) even if the content is unchanged: used by "Save as a copy" / "Save as a new result". */ readonly fresh?: boolean }

const KIND: Partial<Record<ApiFailure['kind'], ProblemKind>> = {
  unauthenticated: 'signin', setup_required: 'setup', forbidden: 'forbidden', quota: 'quota', rate_limited: 'rate_limited', invalid: 'invalid', too_large: 'too_large',
  unavailable: 'unavailable', network: 'unavailable', request_reuse: 'unavailable', version_conflict: 'unavailable', not_found: 'gone',
};
const problemOf = (f: ApiFailure, notFound: ProblemKind = 'gone'): Omit<Problem, 'during'> => ({ kind: f.kind === 'not_found' ? notFound : KIND[f.kind] ?? 'unavailable', ...(f.field ? { field: f.field } : {}), ...(f.retryAfterSec ? { retryAfterSec: f.retryAfterSec } : {}) });

interface Save { readonly requestId: string; readonly epoch: number }

export function createWorkController(d: ControllerDeps) {
  const reuseOrNew = (s: ExperienceState, key: string, fresh?: boolean) => (!fresh && s.work.intent?.key === key ? s.work.intent.requestId : d.newId());
  const begin = (s: ExperienceState, op: SaveOp, key: string, fresh?: boolean): Save => {
    const requestId = reuseOrNew(s, key, fresh);
    d.dispatch({ type: 'saveBegin', op, requestId, key, revision: s.work.revision, reflectionRevision: s.work.reflectionRevision, epoch: s.work.epoch });
    return { requestId, epoch: s.work.epoch };
  };
  const done = (c: Save, p: { prompt?: { id: string; version: number; at: number }; result?: { id: string; version: number; at: number }; conflict?: Conflict }) => d.dispatch({ type: 'saveDone', requestId: c.requestId, epoch: c.epoch, ...p });
  const fail = (c: Save, problem: Omit<Problem, 'during'>) => d.dispatch({ type: 'saveFail', requestId: c.requestId, epoch: c.epoch, problem });
  const conflict = (c: Save, cf: Conflict) => d.dispatch({ type: 'conflictFound', requestId: c.requestId, epoch: c.epoch, conflict: cf });
  const stamp = (iso: string) => Date.parse(iso) || d.now();
  /** Is `c` still THE save in flight for the draft it was submitted from? A read that finishes after the draft was reset, replaced or detached (or after another save began) belongs to nobody: it must neither change links nor start another save. */
  const current = (c: Save): boolean => { const w = d.getState().work; return w.epoch === c.epoch && w.inFlight !== null && w.inFlight.requestId === c.requestId && w.inFlight.epoch === c.epoch; };

  /** The saved prompt is fetched and compared with what was submitted. Equal: done (at the version that is saved NOW). Different: the member chooses. */
  async function reconcilePrompt(c: Save, doc: PromptDocBody, promptId: string): Promise<void> {
    const g = await d.api.getPrompt(promptId);
    if (!current(c)) return;
    if (!g.ok) { fail(c, problemOf(g)); return; }
    if (promptMatches(doc, g.data)) done(c, { prompt: { id: g.data.id, version: g.data.version, at: stamp(g.data.updated_at) } });
    else conflict(c, { target: 'prompt', server: g.data });
  }
  async function reconcileResult(c: Save, doc: ResultDocBody, resultId: string): Promise<void> {
    const g = await d.api.getResult(resultId);
    if (!current(c)) return;
    if (!g.ok) { fail(c, problemOf(g, 'result_gone')); return; }
    if (resultMatches(doc, g.data)) done(c, { result: { id: g.data.id, version: g.data.version, at: stamp(g.data.updated_at) } });
    else conflict(c, { target: 'result', server: g.data });
  }
  /** A combined save answered by a superseded receipt: BOTH halves are checked. Both equal: done. The prompt differs: prompt conflict (nothing is marked saved).
   *  The prompt equals but the result differs: the prompt half is saved and the result half is a conflict on that result. */
  async function reconcileBoth(c: Save, pdoc: PromptDocBody, rdoc: ResultDocBody, promptId: string, resultId: string): Promise<void> {
    const [gp, gr] = await Promise.all([d.api.getPrompt(promptId), d.api.getResult(resultId)]);
    if (!current(c)) return;
    if (!gp.ok) { fail(c, problemOf(gp)); return; }
    if (!gr.ok) { fail(c, problemOf(gr, 'result_gone')); return; }
    const promptSame = promptMatches(pdoc, gp.data), resultSame = resultMatches(rdoc, gr.data);
    const prompt = { id: gp.data.id, version: gp.data.version, at: stamp(gp.data.updated_at) }, result = { id: gr.data.id, version: gr.data.version, at: stamp(gr.data.updated_at) };
    if (promptSame && resultSame) done(c, { prompt, result });
    else if (!promptSame) conflict(c, { target: 'prompt', server: gp.data });
    else done(c, { prompt, conflict: { target: 'result', server: gr.data } });
  }

  /** Lab: Save (create the first time, update afterwards) or Save as new copy. */
  async function savePrompt(mode: 'save' | 'copy' = 'save', opts: SaveOptions = {}): Promise<Outcome> {
    const s = d.getState();
    if (s.work.inFlight) return 'busy';
    const built = buildPromptDoc(s);
    if (!built.ok) { d.dispatch({ type: 'problem', problem: { kind: 'incomplete', field: built.field, during: 'prompt_create' } }); return 'refused'; }
    const update = mode === 'save' && s.work.saved !== null;
    const op = update ? 'prompt_update' : 'prompt_create';
    const saved = s.work.saved;
    const c = begin(s, op, `${op}|${s.work.revision}|${update ? `${saved!.id}|${saved!.version}` : ''}`, opts.fresh);
    const r = update
      ? await d.api.updatePrompt(saved!.id, { request_id: c.requestId, expected_version: saved!.version, prompt: built.doc })
      : await d.api.createPrompt({ request_id: c.requestId, prompt: built.doc });
    if (r.ok) {
      if (r.data.replay === true && r.data.superseded === true) { await reconcilePrompt(c, built.doc, r.data.id); return 'started'; } // an older acknowledgment: never present it as current
      done(c, { prompt: { id: r.data.id, version: r.data.version, at: d.now() } });
      return 'started';
    }
    if (r.kind === 'version_conflict' && update) { await reconcilePrompt(c, built.doc, saved!.id); return 'started'; } // maybe our own lost response; maybe another tab
    if (r.kind === 'not_found' && update) { fail(c, { kind: 'gone' }); return 'started'; }
    fail(c, problemOf(r));
    return 'started';
  }

  /** Reveal: Save this result / Save prompt and result / Update saved result / Save as a new result. */
  async function saveResult(mode: 'save' | 'update' | 'new' = 'save', opts: SaveOptions = {}): Promise<Outcome> {
    const s = d.getState();
    if (s.work.inFlight) return 'busy';
    const rdoc = buildResultDoc(s.reflection);
    if (!rdoc.ok) { d.dispatch({ type: 'problem', problem: { kind: 'outcome', during: 'result_new' } }); return 'refused'; }
    const w = s.work;
    // Update the words of the result that is already saved
    if (mode === 'update' && w.savedResult) {
      const c = begin(s, 'result_update', `result_update|${w.reflectionRevision}|${w.savedResult.id}|${w.savedResult.version}`, opts.fresh);
      const r = await d.api.updateResult(w.savedResult.id, { expected_version: w.savedResult.version, result: rdoc.doc });
      if (r.ok) { done(c, { result: { id: r.data.id, version: r.data.version, at: d.now() } }); return 'started'; }
      if (r.kind === 'version_conflict') { await reconcileResult(c, rdoc.doc, w.savedResult.id); return 'started'; }
      fail(c, problemOf(r, 'result_gone'));
      return 'started';
    }
    // A new result. If the prompt is saved and unchanged, attach to it at the version tried; otherwise one atomic operation saves the prompt AND the result.
    const promptDoc = buildPromptDoc(s);
    const promptCurrent = w.saved !== null && w.revision === w.savedRevision;
    if (promptCurrent) {
      const c = begin(s, 'result_new', `result_new|${w.reflectionRevision}|${w.saved!.id}|${w.saved!.version}${mode === 'new' ? '|new' : ''}`, opts.fresh);
      const r = await d.api.saveResult(w.saved!.id, { request_id: c.requestId, expected_prompt_version: w.saved!.version, result: rdoc.doc });
      if (r.ok) {
        if (r.data.replay === true && r.data.superseded === true) { await reconcileResult(c, rdoc.doc, r.data.id); return 'started'; }
        done(c, { result: { id: r.data.id, version: r.data.version, at: d.now() } });
        return 'started';
      }
      if (r.kind === 'version_conflict' && promptDoc.ok) { await reconcileForResult(c, promptDoc.doc, w.saved!.id, mode); return 'started'; } // the prompt was changed in another tab since this version
      fail(c, problemOf(r));
      return 'started';
    }
    if (!promptDoc.ok) { d.dispatch({ type: 'problem', problem: { kind: 'incomplete', field: promptDoc.field, during: 'both' } }); return 'refused'; }
    const c = begin(s, 'both', `both|${w.revision}|${w.reflectionRevision}|${w.saved ? `${w.saved.id}|${w.saved.version}` : ''}${mode === 'new' ? '|new' : ''}`, opts.fresh);
    const r = await d.api.saveBoth({ request_id: c.requestId, prompt: promptDoc.doc, result: rdoc.doc, ...(w.saved ? { prompt_id: w.saved.id, expected_prompt_version: w.saved.version } : {}) });
    if (r.ok) {
      if (r.data.replay === true && r.data.superseded === true) { await reconcileBoth(c, promptDoc.doc, rdoc.doc, r.data.prompt.id, r.data.result.id); return 'started'; }
      done(c, { prompt: { id: r.data.prompt.id, version: r.data.prompt.version, at: d.now() }, result: { id: r.data.result.id, version: r.data.result.version, at: d.now() } });
      return 'started';
    }
    if (r.kind === 'version_conflict' && w.saved) { await reconcilePrompt(c, promptDoc.doc, w.saved.id); return 'started'; }
    fail(c, problemOf(r));
    return 'started';
  }
  /** The saved prompt moved on while a result was being saved. Same content: adopt its version and try once more; different: the member chooses. */
  async function reconcileForResult(c: Save, doc: PromptDocBody, promptId: string, mode: 'save' | 'update' | 'new') {
    const g = await d.api.getPrompt(promptId);
    if (!current(c)) return;                       // the draft was reset / replaced meanwhile: nothing below may run
    if (!g.ok) { fail(c, problemOf(g)); return; }
    conflict(c, { target: 'prompt', server: g.data });
    if (promptMatches(doc, g.data)) { d.dispatch({ type: 'adoptVersion', target: 'prompt', id: g.data.id, version: g.data.version, inSync: true, epoch: c.epoch }); await saveResult(mode); } // only the version moved
  }

  /** Conflict choices: they act on the conflicting item itself --------------------------------------------------------------------------------------- */
  /** "Overwrite": the caller has already confirmed. Links the draft to the conflicting item at the version saved now, then updates THAT item. Never a create. */
  async function overwrite(): Promise<Outcome> {
    const c = d.getState().work.conflict; if (!c) return 'refused';
    d.dispatch({ type: 'adoptVersion', target: c.target, id: c.server.id, version: c.server.version, epoch: d.getState().work.epoch });
    return c.target === 'prompt' ? savePrompt('save') : saveResult('update');
  }
  /** "Save mine as a copy" / "as a new result": always a fresh intent, so a replay of the original receipt can never bring the same conflict back. */
  async function saveCopy(): Promise<Outcome> {
    const c = d.getState().work.conflict; if (!c) return 'refused';
    d.dispatch({ type: 'dismissProblem' });
    return c.target === 'prompt' ? savePrompt('copy', { fresh: true }) : saveResult('new', { fresh: true });
  }
  return { savePrompt, saveResult, overwrite, saveCopy };
}
export type WorkController = ReturnType<typeof createWorkController>;
