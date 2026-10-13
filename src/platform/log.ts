// Structured logging with redaction. Callers pass plain fields; secrets must not depend on the caller remembering to
// strip them: sensitive keys are masked, and values that look like credentials are masked wherever they appear.
import type { RequestId } from './actor.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;
export interface LogSink { write(line: string): void }

const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|apikey|service|private|jwt|session|credential|dsn|connection|signature|email|phone)/i;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const DB_URL_CREDS = /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s/@:]+(?::[^\s/@]*)?@/gi;
const SUPABASE_KEY = /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const REDACTED = '[redacted]';
const MAX_DEPTH = 5, MAX_STRING = 500, MAX_ITEMS = 20;

export function redactString(s: string): string {
  return s.replace(JWT, REDACTED).replace(BEARER, `Bearer ${REDACTED}`).replace(DB_URL_CREDS, (_m, scheme: string) => `${scheme}://${REDACTED}@`)
    .replace(SUPABASE_KEY, REDACTED).replace(EMAIL, '[email]').slice(0, MAX_STRING);
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return '[unserializable]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value instanceof Error) return { name: value.name, ...('code' in value && typeof (value as { code?: unknown }).code === 'string' ? { code: (value as { code: string }).code } : {}), message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS)) out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  return out;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(base: LogFields): Logger;
}

export function createLogger(sink: LogSink, base: LogFields = {}, now: () => Date = () => new Date()): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}) => {
    const line = { ts: now().toISOString(), level, event: redactString(event), ...(redact({ ...base, ...fields }) as Record<string, unknown>) };
    sink.write(JSON.stringify(line));
  };
  return {
    debug: (e, f) => emit('debug', e, f), info: (e, f) => emit('info', e, f), warn: (e, f) => emit('warn', e, f), error: (e, f) => emit('error', e, f),
    child: (more) => createLogger(sink, { ...base, ...more }, now),
  };
}
export const consoleSink: LogSink = { write: (line) => { console.log(line); } };
export const withRequestId = (logger: Logger, requestId: RequestId): Logger => logger.child({ requestId });
