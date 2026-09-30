import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { flattenError, type ZodType } from 'zod';

import { AppError } from '../errors/app-error.js';

export type ValidationSource = 'body' | 'query' | 'params' | 'headers';

/**
 * Validates and parses one request slot with a Zod schema, replacing the raw
 * value with the parsed result. Routes stay declarative; handlers always
 * receive typed, validated data.
 */
export function validate(schema: ZodType, source: ValidationSource = 'body'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      next(
        AppError.validation('Request validation failed', flattenError(parsed.error).fieldErrors),
      );
      return;
    }
    (req as Record<ValidationSource, unknown>)[source] = parsed.data;
    next();
  };
}
