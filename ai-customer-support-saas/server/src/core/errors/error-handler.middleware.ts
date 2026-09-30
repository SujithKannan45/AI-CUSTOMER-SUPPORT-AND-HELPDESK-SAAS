import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { flattenError, ZodError } from 'zod';

import { isProduction } from '../../config/env.config.js';
import { logger } from '../logger/logger.js';
import { getRequestId } from '../utils/request-id.js';

import { AppError, type AppErrorDetails } from './app-error.js';

export interface ErrorResponseBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

interface NormalizedError {
  statusCode: number;
  code: string;
  message: string;
  details?: AppErrorDetails;
}

interface MongoDuplicateKeyError {
  code?: unknown;
  keyValue?: Record<string, unknown>;
}

function isMongoDuplicateKeyError(error: unknown): error is MongoDuplicateKeyError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as MongoDuplicateKeyError).code === 11000
  );
}

/**
 * Maps any thrown value onto the application's error contract. Unknown errors
 * become opaque 500s so internals never leak to clients.
 */
function normalizeError(error: unknown): NormalizedError {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message, details: error.details };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: flattenError(error).fieldErrors,
    };
  }

  if (error instanceof mongoose.Error.ValidationError) {
    return {
      statusCode: 400,
      code: 'MONGO_VALIDATION_ERROR',
      message: 'Document validation failed',
      details: Object.fromEntries(
        Object.entries(error.errors).map(([path, casterError]) => [path, casterError.message]),
      ),
    };
  }

  if (error instanceof mongoose.Error.CastError) {
    return { statusCode: 400, code: 'INVALID_ID', message: `Invalid value for '${error.path}'` };
  }

  if (isMongoDuplicateKeyError(error)) {
    const fields = Object.keys(error.keyValue ?? {}).join(', ');
    return {
      statusCode: 409,
      code: 'DUPLICATE_KEY',
      message: fields.length > 0 ? `A record with this ${fields} already exists` : 'Record already exists',
    };
  }

  if (error instanceof Error && !isProduction) {
    return { statusCode: 500, code: 'INTERNAL_ERROR', message: error.message };
  }

  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
}

/**
 * Express 5 recognizes an error handler by arity; `_next` is required by the
 * framework even though it is never invoked here.
 */
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const normalized = normalizeError(error);
  const requestId = getRequestId(req);

  if (normalized.statusCode >= 500) {
    logger.error({ err: error, requestId }, `Unhandled error: ${normalized.message}`);
  } else {
    logger.warn({ requestId, code: normalized.code, statusCode: normalized.statusCode }, normalized.message);
  }

  const body: ErrorResponseBody = {
    success: false,
    error: {
      code: normalized.code,
      message: normalized.statusCode >= 500 && isProduction ? 'Internal server error' : normalized.message,
      ...(normalized.details !== undefined ? { details: normalized.details } : {}),
    },
    ...(requestId !== undefined ? { requestId } : {}),
  };

  res.status(normalized.statusCode).json(body);
}
