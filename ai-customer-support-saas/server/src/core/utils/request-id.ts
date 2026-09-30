import type { Request } from 'express';

/**
 * Returns the correlation id assigned by the request logger (pino-http), or
 * `undefined` outside the HTTP pipeline (e.g. in jobs/sockets).
 */
export function getRequestId(req: Request): string | undefined {
  const id: unknown = (req as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}
