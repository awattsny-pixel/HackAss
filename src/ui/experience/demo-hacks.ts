// The three DRAFT EXAMPLES of the UX-08 prototype, kept verbatim as explicitly labelled demonstration content for design review.
// They are not catalog entries, not verified methods and not community posts. They are used ONLY in demo mode, never as a fallback.
import type { ExperienceHack } from './types.ts';

export interface DemoHack extends ExperienceHack { readonly source: 'demo'; readonly emoji: string; readonly visual: 'a' | 'b' | 'c' }

export const DEMO_HACKS: readonly DemoHack[] = [
  {
    source: 'demo', key: 'meal', category: 'Everyday', emoji: '🥗', visual: 'a', href: '/spark/demo/meal',
    title: 'Turn pantry leftovers into a realistic meal plan',
    summary: 'Plan five dinners around food you already have, preferences and a shopping limit.',
    goal: 'Create dinners that use existing ingredients first and flag missing essentials.',
    context: 'Ingredients on hand, dietary needs, time per meal, weekly budget.',
    format: 'Clear step-by-step plan',
    starterPrompt: 'Help me plan five realistic dinners using the ingredients I list. Ask for missing dietary restrictions, household size and cooking time. Prioritize ingredients already on hand; list only needed groceries and give simple recipes. Label assumptions and do not invent prices.',
  },
  {
    source: 'demo', key: 'vendor', category: 'Business', emoji: '📊', visual: 'b', href: '/spark/demo/vendor',
    title: 'Compare three vendor proposals without missing the fine print',
    summary: 'Surface scope differences, exclusions, prices, assumptions and decision risks.',
    goal: 'Compare three proposals based only on evidence in uploaded or pasted documents.',
    context: 'Evaluation priorities: total cost, scope, timeline, warranty, exclusions, missing information.',
    format: 'Comparison table',
    starterPrompt: 'Compare the three vendor proposals I provide. Use only supplied content; cite each claim to its source passage. Build a side-by-side table of pricing, scope, exclusions, timeline and warranty. Flag unknowns and contradictory terms. Do not invent figures or declare a winner without enough evidence.',
  },
  {
    source: 'demo', key: 'creative', category: 'Creative', emoji: '🎬', visual: 'c', href: '/spark/demo/creative',
    title: 'Write a 30-second mini documentary about a family story',
    summary: 'Shape personal notes into an engaging short-form documentary script.',
    goal: 'Turn my notes into a faithful, compelling 30-second mini documentary script.',
    context: 'Target audience: family and friends. Warm documentary voice. Keep all claims faithful to provided stories.',
    format: 'Creative draft',
    starterPrompt: 'Using only the family notes I supply, write a 30-second mini documentary script. Include a strong opening, narration, suggested visuals and closing line. Do not add fabricated facts or direct quotes. Ask me about missing story details before writing.',
  },
];

export const DEMO_CATEGORIES = ['Everyday', 'Business', 'Creative'] as const;
export const findDemoHack = (key: string): DemoHack | undefined => DEMO_HACKS.find((h) => h.key === key);
