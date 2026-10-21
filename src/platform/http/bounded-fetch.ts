// A fetch whose every call is bounded: aborted after the per-call timeout, or immediately once the request's total budget is spent. Used for EVERY network
// call the Auth client makes (sign-in, token exchange, refresh, signing-key retrieval, user check), so a slow or dead Auth server cannot hold a request open.
export const AUTH_CALL_TIMEOUT_MS = 3000;     // one call
export const AUTH_REQUEST_BUDGET_MS = 5000;   // all calls of one request together

export function createBoundedFetch(perCallMs = AUTH_CALL_TIMEOUT_MS, totalMs = AUTH_REQUEST_BUDGET_MS, now: () => number = Date.now, base: typeof fetch = fetch): typeof fetch {
  const deadline = now() + totalMs;
  return (input, init) => {
    const left = deadline - now();
    if (left <= 0) return Promise.reject(new DOMException('request budget spent', 'TimeoutError'));
    const timeout = AbortSignal.timeout(Math.min(perCallMs, left));
    return base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
}
