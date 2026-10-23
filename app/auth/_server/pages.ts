// Minimal, unstyled HTML for the email-link pages. This is functional scaffolding so the flows can be exercised end to end; the designed screens are PX-2c
// (held) and will replace it. Everything interpolated is escaped. Pages are never cached, never send a referrer, load nothing external and cannot be framed.
import 'server-only';
import { NextResponse } from 'next/server';
import type { CallbackType } from '@/src/modules/identity';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; img-src 'self'; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
};
// The approved HackAss One visual language, standalone (these pages are opened from an email, outside the app shell): the same light warm tokens, radii, 44px controls,
// focus ring and Hack artwork. No script, no external resource (system fonts only).
const CSS = `:root{color-scheme:light;--ground:#f6f5f2;--surface:#ffffff;--ink:#141414;--muted:#716f68;--line:#e2dfd8;--chip:#ebe9e4;--coral-deep:#c2452c;--amber:#ffc145;--amber-wash:#fff7e6;--danger:#b42318;--danger-wash:#fdecea}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--ground);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,Roboto,Arial,sans-serif;letter-spacing:-.01em;-webkit-font-smoothing:antialiased}
.wrap{max-width:34rem;margin:0 auto;padding:20px 16px 48px}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
.brand{display:inline-flex;align-items:center;gap:10px;min-height:44px;font-weight:800;font-size:20px;letter-spacing:-.03em;color:var(--ink);text-decoration:none}.tile{width:40px;height:40px;border-radius:12px;background:var(--amber);display:grid;place-items:center;overflow:hidden}.tile img{width:36px;height:36px;object-fit:contain;margin-top:5px}
main{background:var(--surface);border-radius:22px;padding:24px}h1{font-size:30px;line-height:1.08;letter-spacing:-.035em;margin:0 0 12px;font-weight:800}p{margin:0 0 14px}
.muted{color:var(--muted);font-size:14px}.alert,.notice{border-radius:14px;padding:12px 14px;margin:0 0 14px;background:var(--amber-wash);box-shadow:inset 0 0 0 1.5px var(--amber)}.alert{background:var(--danger-wash);box-shadow:inset 0 0 0 1.5px #e8b4ae}
label{display:block;font-weight:700;font-size:13px;color:var(--muted);margin-bottom:6px}input{width:100%;min-height:44px;background:var(--ground);border:0;border-radius:12px;color:var(--ink);padding:10px 14px;font:inherit;margin-bottom:16px}
.btn,button{display:inline-block;min-height:44px;padding:11px 18px;border-radius:12px;border:0;background:var(--chip);color:var(--ink);font:inherit;font-weight:600;text-decoration:none;cursor:pointer;margin:0 8px 8px 0}
.primary,button{background:var(--ink);color:#ffffff}.btn.subtle{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1.5px #cfcbc2}
a{color:var(--coral-deep)}.btn:hover,button:hover{filter:brightness(1.15)}:focus-visible{outline:2.5px solid var(--coral-deep);outline-offset:2px}`;
const HACK_ALT = 'Hack, the HackAss donkey';
export function page(status: number, title: string, bodyHtml: string, extra: Record<string, string> = {}): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><meta name="robots" content="noindex"><title>${esc(title)} · HackAss</title><style>${CSS}</style></head><body><div class="wrap"><div class="top"><a class="brand" href="/spark"><span class="tile"><img src="/hack/hack-official.png" alt="${esc(HACK_ALT)}" width="36" height="36"></span>HackAss</a></div><main id="main" tabindex="-1"><h1>${esc(title)}</h1>${bodyHtml}</main></div></body></html>`;
  return new NextResponse(html, { status, headers: { ...HEADERS, ...extra } });
}
const SIGN_IN_LINK = '<p><a class="btn" href="/account/sign-in">Go to sign in</a></p>';

const LABEL: Record<CallbackType, { title: string; cta: string }> = {
  invite: { title: 'Accept your invitation', cta: 'Continue' },
  recovery: { title: 'Reset your password', cta: 'Continue' },
  email_change: { title: 'Confirm your new email', cta: 'Confirm' },
};
const hidden = (n: string, v: string) => `<input type="hidden" name="${esc(n)}" value="${esc(v)}">`;

const SWITCH_NOTICE = 'You are signed in on this browser. Continuing will sign you out of that account first, then continue with this link, which may be for a different person.';
/** `signedIn`: a session cookie is present (checked without any network call). The member must then explicitly confirm; a link never replaces a session silently. */
export function callbackReady(type: CallbackType, tokenHash: string, next: string, signedIn = false): NextResponse {
  const l = LABEL[type];
  const notice = signedIn ? `<div class="notice" role="alert">${esc(SWITCH_NOTICE)}</div>` : '<p>Press the button to continue. Nothing happens until you do.</p>';
  return page(200, l.title, `${notice}<form method="post" action="/auth/callback/exchange">${hidden('type', type)}${hidden('token_hash', tokenHash)}${hidden('next', next)}${signedIn ? hidden('confirm_switch', '1') : ''}<button type="submit">${esc(signedIn ? 'Sign out and continue' : l.cta)}</button>${signedIn ? '<a class="btn subtle" href="/spark">Stay signed in and go back</a>' : ''}</form>`);
}
/** The exchange was asked for while a session exists and the member has not confirmed the switch: nothing was consumed and the session is unchanged. */
export function callbackSwitchNeeded(type: CallbackType, tokenHash: string, next: string): NextResponse {
  const r = callbackReady(type, tokenHash, next, true);
  return new NextResponse(r.body, { status: 409, headers: r.headers });
}
export function bodyProblemPage(status: 400 | 408 | 413 | 415): NextResponse {
  const m = status === 413 ? 'That request is too large.' : status === 408 ? 'The request took too long. Please try again.' : 'That request was not understood.';
  return page(status, status === 413 ? 'Request too large' : status === 408 ? 'Request timed out' : 'Something went wrong', `<div class="alert" role="alert">${esc(m)}</div>`, status === 408 || status === 413 ? { connection: 'close' } : {}); // close: the rest of an oversize upload is not read
}
export type CallbackProblem = 'expired' | 'invalid' | 'closed' | 'rate_limited' | 'unavailable';
export function callbackProblem(problem: CallbackProblem, type: CallbackType | null, retryAfterSec?: number): NextResponse {
  const extra: Record<string, string> = retryAfterSec ? { 'retry-after': String(retryAfterSec) } : problem === 'unavailable' ? { 'retry-after': '5' } : {};
  switch (problem) {
    case 'expired': return page(400, 'This link has expired', `<div class="alert" role="alert">This link has expired or has already been used.</div><p>${type === 'recovery' ? 'You can ask for a new password link.' : 'Please ask the owner to send you a new link.'}</p>${type === 'recovery' ? '<p><a class="btn primary" href="/account/recover">Ask for a new link</a></p>' : ''}${SIGN_IN_LINK}`);
    case 'invalid': return page(400, 'This link is not valid', `<div class="alert" role="alert">This link isn’t valid.</div><p>Please use the link from your email exactly as it was sent, or ask for a new one.</p>${SIGN_IN_LINK}`);
    case 'closed': return page(403, 'Registration is closed', `<div class="notice" role="alert">Registration is closed for now. Please ask the owner for an invitation.</div>${SIGN_IN_LINK}`);
    case 'rate_limited': return page(429, 'Please wait a moment', '<div class="alert" role="alert">Too many attempts. Please wait a few minutes and try again.</div>', extra);
    case 'unavailable': return page(503, 'Temporarily unavailable', '<div class="alert" role="alert">This is temporarily unavailable. Please try again in a moment.</div><p>We couldn’t confirm whether this completed. Try again. If the link has expired or was already used, request a new one.</p>', extra);
  }
}
export function passwordForm(next: string, message?: string): NextResponse {
  return page(message ? 400 : 200, 'Choose your password', `${message ? `<div class="alert" role="alert">${esc(message)}</div>` : ''}<form method="post" action="/auth/set-password" novalidate><label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="200" aria-describedby="pw-hint"><p id="pw-hint" class="muted">At least 12 characters. A short phrase of several words works well.</p>${hidden('next', next)}<button type="submit">Save password</button></form><p class="muted">Your unsaved work in other tabs is not affected. If you opened this email on another device or browser, sign in there; the tab where you started will not know. Copy anything you want to keep first.</p>`);
}
export function notSignedIn(): NextResponse {
  return page(401, 'Please sign in', `<div class="notice" role="alert">Your session has ended.</div><p>Please open the link from your email again, or sign in.</p>${SIGN_IN_LINK}`);
}
