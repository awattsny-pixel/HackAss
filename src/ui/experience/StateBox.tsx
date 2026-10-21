import type { ReactNode } from 'react';

export type StateKind = 'loading' | 'empty' | 'error' | 'denied' | 'ai' | 'info';
const TITLES: Record<StateKind, string> = { loading: 'Loading…', empty: 'Nothing here yet', error: 'Something went wrong', denied: 'You cannot access this', ai: 'AI assistance unavailable', info: '' };

/** The shared treatment for loading, empty, error, access-denied and unavailable states. Errors and denials use role=alert; the rest are polite status messages. */
export function StateBox({ kind, title, children, actions }: { kind: StateKind; title?: string; children?: ReactNode; actions?: ReactNode }) {
  const alert = kind === 'error' || kind === 'denied';
  return (
    <div className={`state-box ${kind === 'error' ? 'error' : kind === 'denied' ? 'denied' : ''}`} role={alert ? 'alert' : 'status'} aria-live={alert ? 'assertive' : 'polite'} aria-busy={kind === 'loading'}>
      <strong>{title ?? TITLES[kind]}</strong>
      {children ? <p className="muted small">{children}</p> : null}
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}
