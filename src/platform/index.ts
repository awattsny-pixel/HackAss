// The platform surface that modules and routes may import. Database client factories live in ./db and are only
// importable from the composition root (route handlers) and this directory; modules receive a ready handle instead.
export { loadEnv, getEnv, EnvError, LEGACY_SERVICE_ENV_TOLERATED } from './env.ts';
export type { AppEnvName, EnvScope, LoadedEnv, PublicEnv, ServerEnv } from './env.ts';
export { ANONYMOUS, isMember, isStaff, parseUserId, satisfiesTier } from './actor.ts';
export type { Actor, ActorResolver, Aal, AnonymousActor, MemberActor, ModuleContext, RequestId, StaffActor, StaffRole, Tier, UserId, Verification, WorkerActor, WorkerCapability } from './actor.ts';
export { AppError, isAppError, toErrorResponse } from './http/errors.ts';
export type { ErrorBody, ErrorCode, FieldIssue } from './http/errors.ts';
export { withRequestContext } from './http/handler.ts';
export type { HandlerOptions, RequestContext } from './http/handler.ts';
export { assertSameOrigin } from './http/origin.ts';
export { REQUEST_ID_HEADER, resolveRequestId } from './http/request-id.ts';
export { DEFAULT_MAX_BODY_BYTES, parseJsonBody, parseWith } from './http/validate.ts';
export { createLogger, consoleSink, redact, redactString, REDACTED } from './log.ts';
export type { LogFields, Logger, LogSink } from './log.ts';
