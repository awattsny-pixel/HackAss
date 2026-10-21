// Client-safe types for the UX-08 v2 experience. Nothing here touches the environment or a database.
export type HackSource = 'catalog' | 'demo';
export const OUTPUT_FORMATS = ['Clear step-by-step plan', 'Comparison table', 'Creative draft', 'Concise summary'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export type Mode = 'try' | 'learn' | 'master';
export type Outcome = '' | 'yes' | 'partial' | 'no' | 'notyet';

/** One hack as the Lab and Reveal see it, whichever source it came from. `source` is carried everywhere so demo content can never be mistaken for catalog content. */
export interface ExperienceHack {
  readonly source: HackSource;
  readonly key: string;                 // catalog slug or demo id
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly goal: string;
  readonly context: string;
  readonly format: OutputFormat;
  readonly starterPrompt: string;
  readonly href: string;                // the detail page of this hack
}

export interface PromptFields { title: string; goal: string; context: string; format: OutputFormat }
export interface Reflection { outcome: Outcome; text: string; next: string }
