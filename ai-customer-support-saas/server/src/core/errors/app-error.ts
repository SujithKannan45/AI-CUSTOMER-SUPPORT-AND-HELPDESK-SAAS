export interface AppErrorDetails {
  [key: string]: unknown;
}

export interface AppErrorOptions {
  statusCode?: number;
  code?: string;
  /** Operational errors are expected (bad input, missing data) and are logged at warn level. */
  isOperational?: boolean;
  details?: AppErrorDetails;
  cause?: unknown;
}

/**
 * Base error for all expected failures raised by application code.
 *
 * Services throw `AppError` (or a subclass); the central error middleware is
 * the only place that converts errors into HTTP responses.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly details?: AppErrorDetails;

  public constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.isOperational = options.isOperational ?? true;
    this.details = options.details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }

  public static badRequest(message = 'Bad request', details?: AppErrorDetails): AppError {
    return new AppError(message, { statusCode: 400, code: 'BAD_REQUEST', details });
  }

  public static unauthorized(message = 'Authentication required'): AppError {
    return new AppError(message, { statusCode: 401, code: 'UNAUTHORIZED' });
  }

  public static forbidden(message = 'Insufficient permissions'): AppError {
    return new AppError(message, { statusCode: 403, code: 'FORBIDDEN' });
  }

  public static notFound(message = 'Resource not found'): AppError {
    return new AppError(message, { statusCode: 404, code: 'NOT_FOUND' });
  }

  public static conflict(message = 'Resource conflict'): AppError {
    return new AppError(message, { statusCode: 409, code: 'CONFLICT' });
  }

  public static validation(message = 'Request validation failed', details?: AppErrorDetails): AppError {
    return new AppError(message, { statusCode: 422, code: 'VALIDATION_ERROR', details });
  }

  public static tooManyRequests(message = 'Too many requests'): AppError {
    return new AppError(message, { statusCode: 429, code: 'RATE_LIMITED' });
  }
}
