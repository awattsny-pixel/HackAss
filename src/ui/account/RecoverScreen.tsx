'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { StateBox } from '../experience/StateBox.tsx';

type Phase = { kind: 'form' } | { kind: 'sent' } | { kind: 'problem'; why: 'rate' | 'unavailable' | 'request' | 'email'; retryAfter?: number };
const SEND_TIMEOUT_MS = 8000;

/** Ask for a password-reset link. The answer is the same sentence whether or not the address belongs to a member; nothing here can tell the difference. */
export function RecoverScreen() {
  const [email, setEmail] = useState(''); const [busy, setBusy] = useState(false); const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const alertRef = useRef<HTMLDivElement>(null); const sentRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (phase.kind === 'problem') alertRef.current?.focus(); if (phase.kind === 'sent') sentRef.current?.focus(); }, [phase]);

  async function submit(e: FormEvent) {
    e.preventDefault(); if (busy) return;
    const v = email.trim(); if (!v.includes('@')) { setPhase({ kind: 'problem', why: 'email' }); return; }
    setBusy(true); setPhase({ kind: 'form' });
    try {
      const res = await fetch('/auth/recovery/request', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: v }), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      if (res.status === 202) setPhase({ kind: 'sent' });
      else if (res.status === 429) setPhase({ kind: 'problem', why: 'rate', retryAfter: Number(res.headers.get('retry-after')) || undefined });
      else if (res.status === 503) setPhase({ kind: 'problem', why: 'unavailable' });
      else setPhase({ kind: 'problem', why: 'request' });
    } catch { setPhase({ kind: 'problem', why: 'unavailable' }); }
    finally { setBusy(false); }
  }

  if (phase.kind === 'sent') {
    return (
      <div className="auth-card">
        <div ref={sentRef} tabIndex={-1} style={{ outline: 'none' }}>
          <StateBox kind="info" title="Check your email" actions={<Link className="btn primary" href="/account/sign-in">Back to sign in</Link>}>
            If that email belongs to an invited member, we have sent a link to it. The link works once and expires, so use the newest email. If it doesn’t arrive, check your spam folder or ask the owner.
          </StateBox>
        </div>
        <p className="muted small">Open the link on the same device if you can. Unsaved work in a tab on another device or browser can’t be carried over; copy anything you want to keep first.</p>
      </div>
    );
  }
  return (
    <div className="auth-card">
      <div className="sectiontop"><div><span className="eyebrow">ACCOUNT</span><h1>Reset your password</h1><p className="lead">Enter the email your invitation was sent to. Your unsaved work on this page is not affected.</p></div></div>
      {phase.kind === 'problem' ? (
        <div ref={alertRef} tabIndex={-1} style={{ outline: 'none' }}>
          {phase.why === 'rate' ? <StateBox kind="error" title="Please wait a moment">Too many attempts. {phase.retryAfter ? `Try again in about ${Math.max(1, Math.ceil(phase.retryAfter / 60))} minute(s).` : 'Please try again later.'}</StateBox> : null}
          {phase.why === 'unavailable' ? <StateBox kind="error" title="Temporarily unavailable">We couldn’t send that request right now. Please try again in a moment.</StateBox> : null}
          {phase.why === 'request' ? <StateBox kind="error" title="That request wasn’t understood">Check the email address and try again.</StateBox> : null}
          {phase.why === 'email' ? <StateBox kind="error" title="Enter an email address">Type the email address your invitation was sent to.</StateBox> : null}
        </div>
      ) : null}
      <form className="panel" onSubmit={submit} noValidate>
        <div className="field"><label htmlFor="recover-email">Email</label><input id="recover-email" name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="actions"><button type="submit" className="btn primary" disabled={busy} aria-busy={busy}>{busy ? 'Sending…' : 'Send me a link'}</button><Link className="btn subtle" href="/account/sign-in">Back to sign in</Link></div>
      </form>
    </div>
  );
}
