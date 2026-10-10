/**
 * Kernel error types.
 *
 * Every one of these is thrown, never returned as a boolean. A permission check
 * that returns false can be ignored by a caller who forgot to check it; a thrown
 * error cannot be silently dropped, and the API layer has a single place that
 * knows how to turn them into responses.
 */

export type KernelErrorCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_INACTIVE'
  | 'MFA_REQUIRED'
  | 'MFA_INVALID'
  | 'SESSION_EXPIRED'
  | 'SESSION_IDLE_TIMEOUT'
  | 'SESSION_ABSOLUTE_TIMEOUT'
  | 'SESSION_REVOKED'
  | 'STEP_UP_REQUIRED'
  | 'FORBIDDEN'
  | 'SCOPE_VIOLATION'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'OFFLINE_ACTION_FORBIDDEN'
  | 'CHAIN_BROKEN'
  | 'INTERNAL_ERROR';

export class KernelError extends Error {
  readonly code: KernelErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  /** When true the API may retry the same idempotency key safely. */
  readonly retryable: boolean;

  constructor(
    code: KernelErrorCode,
    message: string,
    options: {
      status?: number;
      details?: Record<string, unknown>;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'KernelError';
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

function defaultStatus(code: KernelErrorCode): number {
  switch (code) {
    case 'UNAUTHENTICATED':
    case 'MFA_REQUIRED':
      return 401;
    case 'INVALID_CREDENTIALS':
    case 'MFA_INVALID':
      return 401;
    case 'ACCOUNT_LOCKED':
    case 'RATE_LIMITED':
      return 429;
    case 'SESSION_EXPIRED':
    case 'SESSION_IDLE_TIMEOUT':
    case 'SESSION_ABSOLUTE_TIMEOUT':
    case 'SESSION_REVOKED':
      return 401;
    case 'FORBIDDEN':
    case 'SCOPE_VIOLATION':
    case 'SELF_APPROVAL_FORBIDDEN':
    case 'STEP_UP_REQUIRED':
      return 403;
    case 'VALIDATION_ERROR':
      return 422;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
      return 409;
    case 'OFFLINE_ACTION_FORBIDDEN':
      return 409;
    case 'ACCOUNT_INACTIVE':
      return 403;
    case 'CHAIN_BROKEN':
      return 500;
    default:
      return 500;
  }
}

/**
 * Typed errors.
 *
 * These are classes rather than factory functions so that they can be used with
 * `new` at the call site and so `instanceof` keeps working. Each one is thrown,
 * never returned as a boolean: a permission check that returns a value can be
 * ignored by a caller who forgot to check it, and a thrown error cannot be
 * dropped on the floor without someone noticing.
 */

export class AuthenticationError extends KernelError {
  constructor(
    message: string,
    code: KernelErrorCode = 'UNAUTHENTICATED',
    details?: Record<string, unknown>,
  ) {
    super(code, message, { details });
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends KernelError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    code: KernelErrorCode = 'FORBIDDEN',
  ) {
    super(code, message, { details });
    this.name = 'AuthorizationError';
  }
}

export class StepUpAuthRequired extends KernelError {
  constructor(
    message = 'This action requires re-authentication. Supply your password to continue.',
  ) {
    super('STEP_UP_REQUIRED', message, { status: 403 });
    this.name = 'StepUpAuthRequired';
  }
}

export class ValidationError extends KernelError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, { details });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends KernelError {
  constructor(entity: string, id?: string) {
    super('NOT_FOUND', `${entity}${id ? ` ${id}` : ''} was not found`, { details: { entity, id } });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends KernelError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFLICT', message, { details });
    this.name = 'ConflictError';
  }
}

export class RateLimitedError extends KernelError {
  constructor(message: string, retryAfterSeconds: number) {
    super('RATE_LIMITED', message, { details: { retryAfterSeconds }, retryable: true });
    this.name = 'RateLimitedError';
  }
}

export class ForbiddenError extends KernelError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('FORBIDDEN', message, { details });
    this.name = 'ForbiddenError';
  }
}
