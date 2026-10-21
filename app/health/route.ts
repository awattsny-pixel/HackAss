// GET /health: for the host's health check and the "one instance" check. It touches nothing private and no database. It reports whether this process is ready: its environment
// is valid (the same validation every route uses) AND, if the environment asks for the private-preview gate, the build was made with the gate (and, in staging/production, with the origin lock). Plus the built gate mode, the
// built lock state and a random id for this process. No variable names or values, no user data.
import { randomUUID } from 'node:crypto';
import { builtEdgeLock, builtGateMode, edgeLockRequired, getEnv, runtimeGateMode } from '@/src/platform/server';

export const dynamic = 'force-dynamic';
const g = globalThis as unknown as { __hxBoot?: string };
const bootId = (): string => (g.__hxBoot ??= randomUUID());
const NO_STORE = { 'cache-control': 'no-store' };

export function GET(): Response {
  const built = builtGateMode();
  let ready = true;
  try { getEnv('web'); } catch { ready = false; }
  if (runtimeGateMode() === 'preview' && built !== 'preview') ready = false;   // a preview environment must never serve a build without the gate
  const lock = builtEdgeLock();
  if (edgeLockRequired() && lock !== 'on') ready = false;                      // staging/production must never serve a build without the origin lock
  return Response.json({ status: ready ? 'ok' : 'unavailable', ready, gate: built, lock, boot: bootId() }, { status: ready ? 200 : 503, headers: NO_STORE });
}
