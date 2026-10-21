// DETERMINISTIC prompt creation. No model is called anywhere in this file: the same inputs always give the same text.
import type { ExperienceHack, Mode, OutputFormat, PromptFields } from './types.ts';
import { OUTPUT_FORMATS } from './types.ts';

/** Assembles a prompt from the guided fields (the wording of the approved prototype). */
export function composePrompt(f: Pick<PromptFields, 'goal' | 'context' | 'format'>): string {
  return `Objective: ${f.goal.trim()}\n\nContext and constraints: ${f.context.trim()}\n\nReturn: ${f.format}.\n\nAsk for essential missing information. Distinguish provided facts from assumptions. Explain tradeoffs and do not invent unsupported details.`;
}

export const isOutputFormat = (v: string): v is OutputFormat => (OUTPUT_FORMATS as readonly string[]).includes(v);

interface CatalogHackLike {
  readonly slug: string; readonly title: string; readonly summary: string; readonly category: { readonly name: string };
  readonly outcome: string | null; readonly limitations: string | null;
  readonly steps: readonly { readonly position: number; readonly body: string }[];
  readonly materials: readonly { readonly position: number; readonly name: string; readonly detail: string | null }[];
  readonly requirements: readonly { readonly kind: string; readonly name: string; readonly detail: string | null }[];
}

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');

/**
 * Builds the starter fields and starter prompt for a published catalog hack from its OWN published content (outcome, requirements,
 * materials, limitations, steps), by fixed rules. It does not ask a model, and it states where its content came from.
 */
export function hackFromCatalog(d: CatalogHackLike): ExperienceHack {
  const goal = clip((d.outcome ?? d.summary).trim() || d.title, 600);
  const contextParts: string[] = [];
  if (d.requirements.length) contextParts.push('Needs: ' + d.requirements.map((r) => `${r.name}${r.detail ? ` (${r.detail})` : ''}`).join('; ') + '.');
  if (d.materials.length) contextParts.push('Materials: ' + [...d.materials].sort((a, b) => a.position - b.position).map((m) => m.name).join(', ') + '.');
  if (d.limitations) contextParts.push('Known limits: ' + d.limitations.trim());
  const context = clip(contextParts.join(' ') || 'Describe your situation, the inputs you have and any limits.', 1200);
  const format: OutputFormat = 'Clear step-by-step plan';
  const steps = [...d.steps].sort((a, b) => a.position - b.position);
  const method = steps.length ? `\n\nMethod from the published hack:\n${steps.map((s, i) => `${i + 1}. ${clip(s.body.trim(), 400)}`).join('\n')}` : '';
  return {
    source: 'catalog', key: d.slug, title: d.title, summary: d.summary, category: d.category.name, goal, context, format,
    starterPrompt: composePrompt({ goal, context, format }) + method, href: `/spark/catalog/${d.slug}`,
  };
}

export const MODE_PANELS: Record<Mode, { heading: string; body: string }> = {
  try: { heading: 'Try It · Quick start', body: 'Create or adapt a prompt, copy it into your external AI tool, and return to report what happened.' },
  learn: { heading: 'Learn It · Understand the technique', body: 'A strong prompt defines a goal, supplies relevant context, sets an output format and asks for missing evidence. Change one element at a time to see what improves.' },
  master: { heading: 'Master It · Develop expertise', body: 'Test two prompt versions on the same problem. Compare accuracy, clarity, useful detail and unsupported claims. Record the weaknesses and justify your next revision.' },
};
export const HACK_ADVICE: Record<Mode, string> = {
  try: '“Start with the result you want. Then make it specific. I promise to keep the lectures short.”',
  learn: '“The trick isn’t longer prompts. It’s better constraints and fewer assumptions.”',
  master: '“One test proves a possibility. Repeated tests reveal what actually works.”',
};
export const MODE_LABELS: Record<Mode, string> = { try: 'Try It', learn: 'Learn It', master: 'Master It' };

export const OUTCOME_LABELS = { '': 'Choose an outcome', yes: 'Yes, it helped', partial: 'Partly — needs work', no: "No, it didn't work", notyet: "I haven't tried it" } as const;

/** The reflection text that "Copy reflection" puts on the clipboard (nothing is stored). */
export function reflectionText(title: string, outcome: keyof typeof OUTCOME_LABELS, text: string, next: string): string {
  return `Prompt: ${title}\nOutcome: ${OUTCOME_LABELS[outcome]}\nWhat happened: ${text}\nNext change: ${next}`;
}
