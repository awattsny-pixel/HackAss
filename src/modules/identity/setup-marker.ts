// The "set your password first" marker. IMPORTANT: this is a UX CONSISTENCY RULE, NOT AN AUTHORIZATION BOUNDARY. It is a signed cookie the member holds;
// it expires after 15 minutes and deleting the cookie lifts the restriction. Nothing about account access or data protection depends on it (the database
// guard does not know about it). It only nudges an invited or recovering member to choose a password before using the account.
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SETUP_MARKER_TTL_MS = 15 * 60 * 1000;
export const SETUP_MARKER_COOKIE = 'hx_setup';
export type SetupMarkerStatus = 'absent' | 'valid' | 'expired' | 'invalid' | 'mismatch';
export interface SetupBinding { readonly userId: string; readonly sessionId: string | null }

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const mac = (secret: string, body: string) => createHmac('sha256', secret).update(`setup-marker.v1\0${body}`).digest('base64url');
const needSecret = (secret: string) => { if (typeof secret !== 'string' || secret.length < 32) throw new Error('setup marker secret must be at least 32 characters'); };

export function signSetupMarker(secret: string, b: SetupBinding, nowMs: number): string {
  needSecret(secret);
  const body = b64(JSON.stringify({ u: b.userId, s: b.sessionId, e: nowMs + SETUP_MARKER_TTL_MS }));
  return `v1.${body}.${mac(secret, body)}`;
}

export function verifySetupMarker(secret: string, value: string | undefined | null, b: SetupBinding, nowMs: number): SetupMarkerStatus {
  needSecret(secret);
  if (!value) return 'absent';
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return 'invalid';
  const expected = Buffer.from(mac(secret, parts[1])); const got = Buffer.from(parts[2]);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return 'invalid';
  let p: { u?: unknown; s?: unknown; e?: unknown };
  try { p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return 'invalid'; }
  if (typeof p.e !== 'number' || typeof p.u !== 'string') return 'invalid';
  if (p.e <= nowMs) return 'expired';
  if (p.u !== b.userId || (p.s ?? null) !== (b.sessionId ?? null)) return 'mismatch';
  return 'valid';
}

/** Only a valid marker for THIS member and session asks them to set a password first. Absent, expired, invalid and mismatched markers never block anything. */
export const setupIsPending = (status: SetupMarkerStatus): boolean => status === 'valid';
