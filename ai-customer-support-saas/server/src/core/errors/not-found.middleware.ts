import type { Request, Response } from 'express';

import type { ErrorResponseBody } from './error-handler.middleware.js';

/** Final middleware for requests that no route matched. */
export function notFoundHandler(req: Request, res: Response): void {
  const body: ErrorResponseBody = {
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} does not exist`,
    },
  };
  res.status(404).json(body);
}
