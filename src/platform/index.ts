// CLIENT-SAFE platform surface: the only platform entry point that UI code and modules may import. Everything here is
// pure (types, actor helpers, the public error type, redaction); it reads no environment and holds no database client.
// Server-only pieces (environment, database clients, request handling) live in ./server.ts. A test walks this file's
// import graph and fails if anything reachable from here touches the environment, a database package or ./server.ts.
export { ANONYMOUS, isMember, isStaff, parseUserId, satisfiesTier } from './actor.ts';
export type { Actor, ActorResolver, Aal, AnonymousActor, MemberActor, ModuleContext, RequestId, StaffActor, StaffRole, Tier, UserId, Verification, WorkerActor, WorkerCapability } from './actor.ts';
export { AppError, isAppError } from './http/errors.ts';
export type { ErrorBody, ErrorCode, FieldIssue } from './http/errors.ts';
export { createLogger, redact, redactString, REDACTED } from './log.ts';
export type { LogFields, Logger, LogSink } from './log.ts';
