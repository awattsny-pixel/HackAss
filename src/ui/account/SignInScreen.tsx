'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { HackGuide } from '../experience/HackGuide.tsx';
import { StateBox } from '../experience/StateBox.tsx';
import { useSession } from './SessionProvider.tsx';

type Problem = null | { kind: 'invalid' | 'rate' | 'unavailable' | 'request'; retryAfter?: number };
const SEND_TIMEOUT_MS = 8000;

/** Sign in with email and password. Nothing on this screen reads or changes the member's unsaved prompt: it lives in the page shell, which stays mounted. */
export function SignInScreen({ next }: { next: string }) {
  const router = useRouter();
  const { session, beginAuthAction, markSignedIn, signOut } = useSession();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [problem, setProblem] = useState<Problem>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (problem) alertRef.current?.focus(); }, [problem]);

  async function submit(e: FormEvent) {
    e.preventDefault(); if (busy) return;
    if (!email.trim() || !password) { setProblem({ kind: 'request' }); return; }
    setBusy(true); setProblem(null);
    const end = await beginAuthAction();   // no session check may run, or finish, across this request
    try {
      const res = await fetch('/auth/sign-in', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.trim(), password }), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      if (res.ok) { setPassword(''); markSignedIn(); router.push(next); return; }  // client navigation: the draft stays
      if (res.status === 401) setProblem({ kind: 'invalid' });
      else if (res.status === 429) setProblem({ kind: 'rate', retryAfter: Number(res.headers.get('retry-after')) || undefined });
      else if (res.status === 503) setProblem({ kind: 'unavailable' });
      else setProblem({ kind: 'request' });
    } catch { setProblem({ kind: 'unavailable' }); }
    finally { end(); setBusy(false); }
  }

  if (session.status === 'member' || session.status === 'degraded') {
    return (
      <div className="auth-card">
        <StateBox kind="info" title="You’re already signed in" actions={<><Link className="btn primary" href={next}>Continue</Link><button type="button" className="btn" onClick={() => { void signOut(); }}>Sign out</button></>}>
          Sign out first if you want to use a different account. Your unsaved work on this page stays where it is.
        </StateBox>
      </div>
    );
  }
  return (
    <div className="auth-card">
      <div className="sectiontop"><div><span className="eyebrow">ACCOUNT</span><h1>Sign in</h1><p className="lead">Sign in to the private preview. Your unsaved work on this page is not affected.</p></div></div>
      {problem ? (
        <div ref={alertRef} tabIndex={-1} style={{ outline: 'none' }}>
          {problem.kind === 'invalid' ? <StateBox kind="error" title="That didn’t work">The email or password is not correct.</StateBox> : null}
          {problem.kind === 'rate' ? <StateBox kind="error" title="Please wait a moment">Too many attempts. {problem.retryAfter ? `Try again in about ${Math.ceil(problem.retryAfter / 60)} minute${Math.ceil(problem.retryAfter / 60) === 1 ? '' : 's'}.` : 'Please wait a few minutes and try again.'}</StateBox> : null}
          {problem.kind === 'unavailable' ? <StateBox kind="error" title="Sign-in is temporarily unavailable">We couldn’t reach the sign-in service. Nothing here has been lost; your unsaved work is untouched. Please try again in a moment.</StateBox> : null}
          {problem.kind === 'request' ? <StateBox kind="error" title="Check your details">Enter your email address and password.</StateBox> : null}
        </div>
      ) : null}
      <form className="panel" onSubmit={submit} noValidate>
        <div className="field"><label htmlFor="signin-email">Email</label><input id="signin-email" name="email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="signin-password">Password</label><input id="signin-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <div className="actions"><button id="signin-submit" type="submit" className="btn primary" disabled={busy} aria-busy={busy}>{busy ? 'Signing in…' : 'Sign in'}</button><Link id="signin-forgot" className="btn subtle" href="/account/recover">Forgot your password?</Link></div>
      </form>
      <div className="banner" role="note">Registration is closed for now. If you were invited, use the link in your invitation email. Otherwise, ask the owner for an invitation.</div>
      <HackGuide>“No account yet? The door’s by invitation only. Ask nicely.”</HackGuide>
    </div>
  );
}
