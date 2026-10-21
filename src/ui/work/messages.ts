// The wording of the saved-work journey (pure, so it can be tested). Plain language; nothing here claims more privacy than the application provides: operators with
// database access and backups are outside the application's restrictions, so the note says "private to your account; not shared with other members", never
// "only you can see it" or "no human access". PROVISIONAL until the owner and legal finalise the privacy text before external testers.
import type { Problem } from '../experience/state.ts';
import type { PromptSaveView, ResultSaveView } from '../experience/state.ts';

export const PRIVACY_NOTE = "Private to your account; not shared with other members. Please don't store passwords or other secrets in prompts.";
export const SAVE_UNAVAILABLE_HINT = 'Your text is still here.';

const FIELD_LABEL: Record<string, string> = { title: 'the title', full_prompt: 'the prompt', prompt: 'the prompt (it is too long overall)', goal: 'the goal', context: 'the context', output_format: 'the preferred output', outcome: 'the outcome', reflection: 'your reflection', next_change: 'the improvement', starting_prompt: 'the starting version' };
export const fieldLabel = (f: string | undefined): string => (f && FIELD_LABEL[f.replace(/^\(root\)\./, '').split('.').pop() ?? ''] ) || 'one of the fields';

export const timeLabel = (ms: number): string => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function promptStatusText(view: PromptSaveView, savedAt: number | null): string {
  switch (view) {
    case 'not_saved': return 'Not saved';
    case 'saving': return 'Saving…';
    case 'saved': return savedAt ? `Saved · ${timeLabel(savedAt)}` : 'Saved';
    case 'changed': return 'Changed since last save';
    case 'failed': return 'Couldn’t save — your draft is still here';
    case 'conflict': return 'Saved elsewhere — choose';
    case 'signin': return 'Sign in to save';
  }
}
export function resultStatusText(view: ResultSaveView, savedAt: number | null): string {
  switch (view) {
    case 'not_saved': return 'Result not saved';
    case 'saving': return 'Saving…';
    case 'saved': return savedAt ? `Result saved · ${timeLabel(savedAt)}` : 'Result saved';
    case 'changed': return 'Changed since last save';
    case 'failed': return 'Couldn’t save — your reflection is still here';
    case 'conflict': return 'Saved elsewhere — choose';
    case 'signin': return 'Sign in to save';
  }
}

/** What to tell the member about a failed save. Always says the draft is still there; never includes provider or database text. */
export function problemText(p: Problem): string {
  const kept = 'Your draft is still here.';
  switch (p.kind) {
    case 'incomplete': return p.field === 'title' ? 'Give your prompt a name before saving.' : 'Write the prompt before saving.';
    case 'outcome': return 'Choose whether it worked before saving the result.';
    case 'signin': return `Your sign-in has ended. Sign in again, then press Save. ${kept}`;
    case 'setup': return `Choose your password first (the button in the top bar), then press Save. ${kept}`;
    case 'forbidden': return `This account can’t save work right now. ${kept}`;
    case 'quota': return 'You’ve reached a saved-work limit (100 prompts, 50 results per prompt, 500 results in all). Delete something in My prompts to make room. ' + kept;
    case 'rate_limited': return `Too many saves in a short time. Try again in ${p.retryAfterSec && p.retryAfterSec > 90 ? `about ${Math.ceil(p.retryAfterSec / 60)} minutes` : `${p.retryAfterSec ?? 30} seconds`}. ${kept}`;
    case 'invalid': return `Some of that couldn’t be saved: check ${fieldLabel(p.field)}. ${kept}`;
    case 'too_large': return `That’s too large to save. Shorten the prompt and try again. ${kept}`;
    case 'unavailable': return `Couldn’t save right now. ${kept} Try again in a moment.`;
    case 'gone': return `The saved copy of this prompt no longer exists (it may have been deleted elsewhere). Save again to create a new one. ${kept}`;
    case 'result_gone': return `The saved result no longer exists (it may have been deleted elsewhere). Use “Save as a new result”. ${kept}`;
  }
}
/** Failures that are worth retrying with the same button. */
export const isRetryable = (p: Problem): boolean => p.kind === 'unavailable' || p.kind === 'rate_limited';

export function failureText(kind: string): string {
  switch (kind) {
    case 'unauthenticated': return 'Sign in to see your saved work.';
    case 'setup_required': return 'Choose your password first (the button in the top bar), then come back.';
    case 'forbidden': return 'This account can’t use saved work right now.';
    case 'not_found': return 'That item was not found. It may have been deleted.';
    case 'version_conflict': return 'This changed since you opened it. Reload it before saving again.';
    case 'rate_limited': return 'Too many requests in a short time. Please wait a moment and try again.';
    default: return 'Saved work can’t be reached right now. Nothing has been lost. Try again in a moment.';
  }
}
