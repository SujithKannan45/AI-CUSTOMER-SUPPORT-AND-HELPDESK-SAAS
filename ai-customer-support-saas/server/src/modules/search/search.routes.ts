import { Router } from 'express';

import { createRateLimiter } from '../../core/middlewares/rate-limiter.middleware.js';
import { validate } from '../../core/middlewares/validate.middleware.js';
import { requireAuth } from '../auth/require-auth.middleware.js';
import { requireWorkspaceContext } from '../workspaces/require-workspace.middleware.js';

import { searchWorkspaceController } from './search.controller.js';
import {
  searchWorkspaceParamsSchema,
  workspaceSearchQuerySchema,
} from './search.validation.js';

/**
 * Unified search routes (Prompt 17) — mounted at
 * `/api/v1/workspaces/:workspaceId/search`.
 *
 * Gate order (identical to every module):
 *
 *   1. requireAuth                         → 401
 *   2. limiter (60/min/IP)                 → 429
 *   3. validate(params)                    → 422
 *   4. requireWorkspaceContext()           → 404 (foreign/inactive concealed)
 *   5. validate(query)                     → 422
 *   6. controller → per-entity RBAC fan-out
 *
 * There is deliberately NO single `requirePermission` here: the endpoint
 * spans modules with different grants, so authorization happens per entity
 * type inside the service (a type the role cannot read is skipped, not
 * errored). Membership is still mandatory — a stranger never reaches the
 * service at all.
 */
const searchLimiter = createRateLimiter({ windowMs: 60_000, limit: 60 });
const requireWorkspace = requireWorkspaceContext();

export const searchRouter = Router({ mergeParams: true });

searchRouter.use(requireAuth, searchLimiter);

searchRouter.get(
  '/',
  validate(searchWorkspaceParamsSchema, 'params'),
  requireWorkspace,
  validate(workspaceSearchQuerySchema, 'query'),
  searchWorkspaceController,
);
