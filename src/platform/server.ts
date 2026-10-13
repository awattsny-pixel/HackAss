// SERVER-ONLY platform surface: environment, database clients and request handling. Import this only from route
// handlers and the composition root (app/**). UI code and modules are forbidden from importing it (ESLint), and the
// client-safe barrel (./index.ts) never re-exports it.
export { loadEnv, getEnv, EnvError, LEGACY_SERVICE_ENV_TOLERATED } from './env.ts';
export type { AppEnvName, EnvScope, LoadedEnv, PublicEnv, ServerEnv } from './env.ts';
export { createPublicDb, createUserDb, createWorkerDb, WORKER_FUNCTIONS } from './db/index.ts';
export type { CookieAdapter, PublicDb, SqlRunner, UserDb, WorkerDb, WorkerFunction } from './db/index.ts';
export { toErrorResponse } from './http/errors.ts';
export { withRequestContext } from './http/handler.ts';
export type { HandlerOptions, RequestContext } from './http/handler.ts';
export { assertSameOrigin } from './http/origin.ts';
export { REQUEST_ID_HEADER, resolveRequestId } from './http/request-id.ts';
export { DEFAULT_MAX_BODY_BYTES, parseJsonBody, parseWith } from './http/validate.ts';
export { consoleSink } from './log.ts';
