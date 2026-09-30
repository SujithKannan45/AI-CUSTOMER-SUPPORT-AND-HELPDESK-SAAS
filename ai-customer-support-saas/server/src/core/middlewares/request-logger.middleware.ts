import { randomUUID } from 'node:crypto';

import { pinoHttp ,type  Options } from 'pino-http';

import { logger } from '../logger/logger.js';

/**
 * HTTP request/response logging with a correlation id per request.
 *
 * The generated (or incoming `X-Request-Id`) id is stored on `req.id` — read
 * it via `getRequestId` — and echoed back on the response so clients and logs
 * can be correlated.
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers['x-request-id'];
    const requestId =
      typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    return requestId;
  },
  autoLogging: {
    ignore: (req) => req.url !== null && req.url !== undefined && req.url.startsWith('/health'),
  },
  customLogLevel: (_req, res, err) => {
    if (err !== null && err !== undefined) return 'error';
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
  customErrorMessage: (req, res, err) => `${req.method} ${req.url} -> ${res.statusCode} (${err.message})`,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie'],
    censor: '[REDACTED]',
  },
} satisfies Options);
