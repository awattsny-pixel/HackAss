// The AI tools offered after a confirmed copy. Each entry is a fixed HTTPS home page: no path, query or hash, and nothing built from the prompt or the member.
export interface Provider { readonly id: string; readonly name: string; readonly href: string }
export const PROVIDERS: readonly Provider[] = Object.freeze([
  Object.freeze({ id: 'chatgpt', name: 'ChatGPT', href: 'https://chatgpt.com/' }),
  Object.freeze({ id: 'claude', name: 'Claude', href: 'https://claude.ai/' }),
  Object.freeze({ id: 'gemini', name: 'Gemini', href: 'https://gemini.google.com/' }),
  Object.freeze({ id: 'copilot', name: 'Copilot', href: 'https://copilot.microsoft.com/' }),
]);
