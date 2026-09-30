import { Router ,type  Request,type  Response } from 'express';

import { getRequestId } from '../../core/utils/request-id.js';
import { isDatabaseConnected } from '../../database/database.js';

/**
 * Public health surface for load balancers, ECS/Fargate health checks and
 * CloudWatch probes. Infrastructure must never depend on endpoints that
 * require authentication.
 */
export const healthRouter = Router();

/** Liveness: process is up. No dependency checks — cheap and always answers. */
healthRouter.get('/health', (_req: Request, res: Response): void => {
  res.status(200).json({ status: 'ok' });
});

/** Readiness: process is up AND can reach critical dependencies. */
healthRouter.get('/health/ready', (req: Request, res: Response): void => {
  const databaseReady = isDatabaseConnected();
  res.status(databaseReady ? 200 : 503).json({
    status: databaseReady ? 'ok' : 'degraded',
    checks: {
      database: databaseReady ? 'ok' : 'unavailable',
    },
    requestId: getRequestId(req),
  });
});
