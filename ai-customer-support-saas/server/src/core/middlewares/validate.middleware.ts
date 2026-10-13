import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { flattenError, type ZodType } from 'zod';

import { AppError } from '../errors/app-error.js';

export type ValidationSource = 'body' | 'query' | 'params' | 'headers';

/**
 * Typed slot where `validate(..., 'params')` exposes pure, schema-validated
 * values without touching `req.params` (see the Express 5 note below).
 */
interface RequestWithValidated extends Request {
  validated?: { params?: unknown };
}

/**
 * Validates and parses one request slot with a Zod schema. Routes stay
 * declarative; handlers always receive typed, validated data.
 *
 * Express 5 notes (both verified against the running app):
 * - `req.query` is a configurable getter — plain assignment throws
 *   `Cannot set property query ... which has only a getter`. The parsed value
 *   is installed with `Object.defineProperty`.
 * - `req.params` is a LIVE getter backed by the matched route; defining or
 *   assigning it breaks downstream routing. For 'params', the parsed value is
 *   exposed on `req.validated.params` and `req.params` stays untouched.
 * - Zod "shape-level" failures (`.strict()` unrecognized keys, `.refine()`,
 *   non-object schemas) carry no field path and land in `formErrors` — they
 *   are merged into `details` under that key instead of being dropped, so
 *   clients always receive actionable details.
 */
export function validate(schema: ZodType, source: ValidationSource = 'body'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      const flattened = flattenError(parsed.error);
      const details: Record<string, unknown> = { ...flattened.fieldErrors };
      if (flattened.formErrors.length > 0) {
        details['formErrors'] = flattened.formErrors;
      }
      next(AppError.validation('Request validation failed', details));
      return;
    }
    if (source === 'params') {
      const validated = ((req as RequestWithValidated).validated ??= {});
      validated['params'] = parsed.data;
    } else {
      Object.defineProperty(req, source, {
        value: parsed.data,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    next();
  };
}
