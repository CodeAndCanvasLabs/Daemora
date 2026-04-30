/**
 * Typed error hierarchy. Every error thrown across module boundaries
 * should be one of these (or a subclass), never a plain Error.
 *
 * Each carries an HTTP status hint and a stable error_code so the UI
 * can show actionable messages without parsing strings.
 */

export type ErrorCode =
  | "config_error"
  | "validation_error"
  | "not_found"
  | "permission_denied"
  | "blocked_action"
  | "rate_limit"
  | "provider_error"
  | "provider_unavailable"
  | "timeout"
  | "cancelled"
  | "internal_error";

export interface DaemoraErrorOptions {
  readonly code: ErrorCode;
  readonly status: number;
  readonly cause?: unknown;
  readonly context?: Record<string, unknown>;
}

export class DaemoraError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly context: Record<string, unknown>;

  constructor(message: string, opts: DaemoraErrorOptions) {
    super(message, { cause: opts.cause });
    this.name = this.constructor.name;
    this.code = opts.code;
    this.status = opts.status;
    this.context = opts.context ?? {};
  }

  toJSON(): Record<string, unknown> {
    return {
      error_code: this.code,
      message: this.message,
      status: this.status,
      ...(Object.keys(this.context).length > 0 ? { context: this.context } : {}),
    };
  }
}

export class ConfigError extends DaemoraError {
  constructor(message: string, ctx?: Record<string, unknown>) {
    super(message, { code: "config_error", status: 500, ...(ctx ? { context: ctx } : {}) });
  }
}

export class ValidationError extends DaemoraError {
  constructor(message: string, ctx?: Record<string, unknown>) {
    super(message, { code: "validation_error", status: 400, ...(ctx ? { context: ctx } : {}) });
  }
}

export class NotFoundError extends DaemoraError {
  constructor(message: string, ctx?: Record<string, unknown>) {
    super(message, { code: "not_found", status: 404, ...(ctx ? { context: ctx } : {}) });
  }
}

export class PermissionDeniedError extends DaemoraError {
  constructor(message: string, ctx?: Record<string, unknown>) {
    super(message, { code: "permission_denied", status: 403, ...(ctx ? { context: ctx } : {}) });
  }
}

export class BlockedActionError extends DaemoraError {
  constructor(message: string, ctx?: Record<string, unknown>) {
    super(message, { code: "blocked_action", status: 403, ...(ctx ? { context: ctx } : {}) });
  }
}

export class RateLimitError extends DaemoraError {
  constructor(message: string, retryAfterMs?: number) {
    super(message, {
      code: "rate_limit",
      status: 429,
      ...(retryAfterMs !== undefined ? { context: { retry_after_ms: retryAfterMs } } : {}),
    });
  }
}

export class ProviderError extends DaemoraError {
  constructor(message: string, provider: string, cause?: unknown) {
    super(message, {
      code: "provider_error",
      status: 502,
      ...(cause !== undefined ? { cause } : {}),
      context: { provider },
    });
  }
}

export class ProviderUnavailableError extends DaemoraError {
  constructor(provider: string, missingKey?: string) {
    super(
      missingKey
        ? `Provider "${provider}" not configured — set ${missingKey} in your vault or environment.`
        : `Provider "${provider}" is not available.`,
      { code: "provider_unavailable", status: 503, context: { provider, ...(missingKey ? { missing_key: missingKey } : {}) } },
    );
  }
}

export class TimeoutError extends DaemoraError {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`, {
      code: "timeout",
      status: 504,
      context: { operation, timeout_ms: timeoutMs },
    });
  }
}

export class CancelledError extends DaemoraError {
  constructor(reason?: string) {
    super(reason ?? "Operation was cancelled", { code: "cancelled", status: 499 });
  }
}

/** Coerce any caught value into a DaemoraError for uniform handling. */
export function toDaemoraError(e: unknown): DaemoraError {
  if (e instanceof DaemoraError) return e;
  if (e instanceof Error) {
    return new DaemoraError(e.message, { code: "internal_error", status: 500, cause: e });
  }
  return new DaemoraError(String(e), { code: "internal_error", status: 500 });
}
