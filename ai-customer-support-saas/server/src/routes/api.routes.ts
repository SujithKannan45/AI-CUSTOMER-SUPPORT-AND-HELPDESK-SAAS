import { Router } from 'express';

import { env } from '../config/env.config.js';

/**
 * Versioned API root. Feature-module routers are mounted here as they are
 * implemented, e.g.:
 *
 *   apiRouter.use('/auth', authRouter);
 *   apiRouter.use('/workspaces', workspaceRouter);
 *
 * Keeping one assembly point prevents route sprawl and gives every endpoint a
 * consistent `/api/v1/...` prefix.
 */
export const apiRouter = Router();

apiRouter.get('/', (_req, res) => {
  res.json({
    name: 'AI Customer Support SaaS API',
    version: '1.0.0',
    environment: env.NODE_ENV,
  });
});
