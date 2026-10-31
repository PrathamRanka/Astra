/**
 * Consistent application errors for Astra
 */

export interface AstraErrorOptions {
  cause?: unknown;
  details?: unknown;
}

/**
 * Base application error
 */
export class AstraError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode = 500,
    code = "INTERNAL_ERROR",
    options?: AstraErrorOptions,
  ) {
    super(message, options ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = options?.details;
  }
}

/**
 * 400 - Validation or bad request error
 */
export class ValidationError extends AstraError {
  constructor(message: string, details?: unknown, options?: { cause?: unknown }) {
    super(message, 400, "VALIDATION_ERROR", { cause: options?.cause, details });
  }
}

/**
 * 401 - Authentication failure (missing or invalid API key / token)
 */
export class AuthenticationError extends AstraError {
  constructor(message = "Unauthorized", options?: AstraErrorOptions) {
    super(message, 401, "UNAUTHORIZED", options);
  }
}

/**
 * 403 - Authorization failure (insufficient scopes or access denied)
 */
export class AuthorizationError extends AstraError {
  constructor(message = "Forbidden", options?: AstraErrorOptions) {
    super(message, 403, "FORBIDDEN", options);
  }
}

/**
 * 404 - Resource not found
 */
export class NotFoundError extends AstraError {
  constructor(message = "Resource not found", options?: AstraErrorOptions) {
    super(message, 404, "NOT_FOUND", options);
  }
}

/**
 * 409 - Resource conflict (e.g. duplicate key, concurrent modification)
 */
export class ConflictError extends AstraError {
  constructor(message = "Resource conflict", options?: AstraErrorOptions) {
    super(message, 409, "CONFLICT", options);
  }
}

/**
 * 429 - Rate limit or quota exceeded
 */
export class RateLimitError extends AstraError {
  public readonly retryAfterMs: number;

  constructor(
    message = "Too many requests",
    retryAfterMs = 1000,
    options?: AstraErrorOptions,
  ) {
    super(message, 429, "RATE_LIMITED", options);
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * 503 - Service unavailable (upstream dependency down or overloaded)
 */
export class ServiceUnavailableError extends AstraError {
  constructor(message = "Service unavailable", options?: AstraErrorOptions) {
    super(message, 503, "SERVICE_UNAVAILABLE", options);
  }
}

