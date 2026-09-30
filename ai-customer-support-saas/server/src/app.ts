import compression from 'compression';
import express, {type  Express } from 'express';

import { env } from './config/env.config.js';
import { errorHandler, notFoundHandler } from './core/errors/index.js';
import {
  corsMiddleware,
  globalLimiter,
  requestLogger,
  securityHeaders,
} from './core/middlewares/index.js';
import { healthRouter } from './modules/health/health.routes.js';
import { apiRouter } from './routes/api.routes.js';

/**
 * Express application factory.
 *
 * Middleware order matters: correlation-aware logging first (so every event
 * carries a request id), security headers, CORS, body parsing, compression,
 * rate limiting, then routes, then the error pipeline. Nothing after the
 * error handler runs.
 *
 * `registerRoutes` receives the app just before the not-found/error
 * handlers close the stack — the extension point for feature modules and
 * verification probes, guaranteeing they sit inside the full pipeline.
 */
export function createApp(registerRoutes?: (app: Express) => void): Express {
  const app = express();

  // Behind ALB/CloudFront, client IPs arrive in X-Forwarded-For; trust one hop
  // so rate limiting keys on the real client IP.
  app.set('trust proxy', 1);

  app.use(requestLogger);
  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(express.json({ limit: '1mb' }));
  app.use(compression());
  app.use(globalLimiter);

  // Infrastructure probes stay outside the versioned API and the rate limiter.
  app.use(healthRouter);
  app.use(env.API_PREFIX, apiRouter);

  registerRoutes?.(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
