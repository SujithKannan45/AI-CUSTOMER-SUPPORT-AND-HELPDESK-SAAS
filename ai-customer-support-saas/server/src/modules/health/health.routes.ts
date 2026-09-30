import { Router ,type  Request,type  Response } from 'express';

import { env } from '../../config/env.config.js';
import { getRequestId } from '../../core/utils/request-id.js';
import { isDatabaseConnected } from '../../database/database.js';

/**
 * Public health surface for load balancers, ECS/Fargate health checks and
 * CloudWatch probes. Infrastructure must never depend on endpoints that
 * require authentication.
 *
 * Liveness (`/health`) answers "is the process up" cheaply. Readiness
 * (`/health/ready`) adds dependency status without exposing infrastructure
 * internals (no hosts, no versions, no connection strings).
 */
export const healthRouter = Router();

/** Liveness: process is up. No dependency checks — cheap and always answers. */
healthRouter.get('/health', (_req: Request, res: Response): void => {
  res.status(200).json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      api: 'up',
    },
  });
});

/** Readiness: process is up AND can reach critical dependencies. */
healthRouter.get('/health/ready', (req: Request, res: Response): void => {
  const databaseReady = isDatabaseConnected();
  res.status(databaseReady ? 200 : 503).json({
    success: true,
    status: databaseReady ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      api: 'up',
      database: databaseReady ? 'up' : 'down',
    },
    environment: env.NODE_ENV,
    requestId: getRequestId(req),
  });
});
