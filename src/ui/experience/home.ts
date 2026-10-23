// Pure Home helpers (kept out of the component so they can be tested without a renderer).
export function greetingFor(hour: number): string { return hour < 5 ? 'Hello' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'; }

/** What Hack says on Home: contextual, from the state the member is actually in (never a pop-up, never a claim about AI). */
export function homeGuidance(started: boolean, dirty: boolean, mode: 'catalog' | 'demo'): { text: string; continueDraft: boolean } {
  if (started && dirty) return { text: 'Your draft is still here, and it is not saved yet. Pick it up again, or start something new. I will ask before replacing anything.', continueDraft: true };
  if (started) return { text: 'Your draft is open in the Lab. Pick up where you left off, or choose another hack.', continueDraft: true };
  if (mode === 'demo') return { text: 'These are draft examples for design review. Open one to see how adapting a hack works.', continueDraft: false };
  return { text: 'Pick a hack to make your own, or start from a blank prompt. You bring the goal; I will help with the structure.', continueDraft: false };
}
