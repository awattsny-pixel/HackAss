// Pilot password rule: length only, no composition rules, no silent truncation. 12 code points minimum; at most 72 UTF-8 bytes because the Auth
// provider hashes with bcrypt, which cannot use more (limit to be confirmed against the provider before PX-2b). A leaked-password check is
// provider-side and not assumed.
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_BYTES = 72;
export type PasswordIssue = 'not_text' | 'too_short' | 'too_long' | 'control_characters' | 'same_as_email';
export type PasswordResult = { readonly ok: true } | { readonly ok: false; readonly issues: readonly PasswordIssue[] };

const CONTROL = /[\u0000-\u001f\u007f]/;
export function validatePassword(password: unknown, ctx: { email?: string } = {}): PasswordResult {
  if (typeof password !== 'string') return { ok: false, issues: ['not_text'] };
  const issues: PasswordIssue[] = [];
  if ([...password].length < MIN_PASSWORD_LENGTH) issues.push('too_short');
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) issues.push('too_long');
  if (CONTROL.test(password)) issues.push('control_characters');
  if (ctx.email && password.normalize('NFKC').toLowerCase() === ctx.email.normalize('NFKC').trim().toLowerCase()) issues.push('same_as_email');
  return issues.length ? { ok: false, issues } : { ok: true };
}

/** Plain wording for the member; never mentions rules we do not enforce. */
export function passwordIssuesMessage(issues: readonly PasswordIssue[]): string {
  if (issues.includes('too_short')) return `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (issues.includes('too_long')) return `That password is too long. Use at most ${MAX_PASSWORD_BYTES} bytes (about ${MAX_PASSWORD_BYTES} letters).`;
  if (issues.includes('same_as_email')) return 'Your password cannot be your email address.';
  return 'That password cannot be used. Please choose another.';
}
