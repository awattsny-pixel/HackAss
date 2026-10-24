'use client';
// "Rebuild from the answers" for every mode: the generated block is replaced and what follows it (method steps, the member's own text) is kept.
// When no block can be identified reliably the whole prompt would be replaced, and the member is told so and asked first.
import { useExperience } from './ExperienceProvider.tsx';
import { rebuildPrompt } from './guided.ts';

export function useRebuild(): () => void {
  const { state, dispatch, confirmThen, toast } = useExperience();
  return () => {
    const r = rebuildPrompt(state.fullPrompt, state.fields);
    if (!r) { toast('The rebuilt prompt would be over the prompt length limit. Shorten an answer first.'); return; }
    confirmThen(r.keeps ? 'rebuild' : 'regenerate', () => { dispatch({ type: 'rebuild' }); toast('Prompt rebuilt from the answers · not saved'); });
  };
}
