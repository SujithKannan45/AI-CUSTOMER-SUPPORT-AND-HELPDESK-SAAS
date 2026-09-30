import cors, {type  CorsOptions } from 'cors';
import { type Request ,type  Handler } from 'express';
import helmet from 'helmet';

import { env, isProduction } from '../../config/env.config.js';

/** Reflects the request origin back only when it is explicitly allow-listed. */
function corsOptionsDelegate(
  req: Request,
  callback: (err: Error | null, options?: CorsOptions) => void,
): void {
  const origin = req.headers.origin;
  const allowed = env.CORS_ALLOWED_ORIGINS.includes(origin ?? '');

  callback(null, {
    origin: allowed ? origin : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    maxAge: 600,
  });
}

export const corsMiddleware: Handler = cors(corsOptionsDelegate);

/** Conservative Helmet defaults; relaxed only if the product later needs it. */
export const securityHeaders: Handler = helmet({
  contentSecurityPolicy: isProduction ? undefined : false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});
