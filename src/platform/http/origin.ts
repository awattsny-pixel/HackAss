import { AppError } from './errors.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated mutations: a state-changing request must carry an Origin header equal to the
 * application origin. A missing Origin is refused (browsers send it on cross-origin and on same-origin POSTs).
 */
export function assertSameOrigin(request: Request, appOrigin: string): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  const origin = request.headers.get('origin');
  if (origin !== appOrigin) throw new AppError('forbidden', 'Cross-origin requests are not allowed.');
}
