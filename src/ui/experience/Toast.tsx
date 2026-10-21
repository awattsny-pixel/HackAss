'use client';
// A polite live region: copy confirmations and short notices. Always mounted (so screen readers announce changes); visible only with text.
export function Toast({ message }: { message: string }) {
  return <div className="toaster" role="status" aria-live="polite" hidden={message === ''}>{message}</div>;
}
