import { rateLimit ,type  Options,type  RateLimitRequestHandler } from 'express-rate-limit';

import { AppError } from '../errors/app-error.js';
import { logger } from '../logger/logger.js';

const handleLimitExceeded: Options['handler'] = (_req, _res, next, options) => {
  logger.warn({ windowMs: options.windowMs, limit: options.limit }, 'Rate limit exceeded');
  next(AppError.tooManyRequests(`Rate limit exceeded. Retry in ${Math.ceil(options.windowMs / 1000)}s`));
};

/**
 * Global API limiter — a backstop against abuse, not a product rule. Feature
 * modules should create their own stricter limiters for sensitive endpoints
 * (auth, AI calls) using `createRateLimiter`.
 */
export function createRateLimiter(options: Partial<Options> = {}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: handleLimitExceeded,
    skip: (req) => req.path.startsWith('/health'),
    ...options,
  });
}

export const globalLimiter: RateLimitRequestHandler = createRateLimiter();

/** Strict limiter for sensitive future endpoints (login, AI generation). */
export const sensitiveRouteLimiter: RateLimitRequestHandler = createRateLimiter({
  windowMs: 15 * 60_000,
  limit: 20,
});
