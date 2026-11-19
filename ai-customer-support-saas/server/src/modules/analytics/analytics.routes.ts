import { Router } from 'express';

import { createRateLimiter } from '../../core/middlewares/rate-limiter.middleware.js';
import { validate } from '../../core/middlewares/validate.middleware.js';
import { requireAuth } from '../auth/require-auth.middleware.js';
import { WORKSPACE_PERMISSIONS } from '../rbac/rbac.permissions.js';
import { requirePermission } from '../rbac/require-permission.middleware.js';
import { requireWorkspaceContext } from '../workspaces/require-workspace.middleware.js';

import {
  exportTicketsController,
  getAiAnalyticsController,
  getOverviewController,
  getPerformanceController,
  getTicketAnalyticsController,
} from './analytics.controller.js';
import {
  analyticsParamsSchema,
  analyticsRangeQuerySchema,
  analyticsTimeSeriesQuerySchema,
  ticketReportQuerySchema,
} from './analytics.validation.js';

/**
 * Analytics routes (Prompt 18) — mounted at
 * `/api/v1/workspaces/:workspaceId/analytics`.
 *
 * Gate order (identical to every module):
 *
 *   1. requireAuth                         → 401
 *   2. analytics limiter (60/min/IP)       → 429
 *   3. validate(params)                    → 422
 *   4. requireWorkspaceContext()           → 404 (foreign/inactive concealed)
 *   5. requirePermission('analytics.view') → 403 + audit
 *   6. validate(query)                     → 422
 *   7. controller → service → aggregations
 *
 * `analytics.view` already exists in the registry (Prompt 6) and is granted to
 * owner/admin only — no new permission is introduced. Agents and viewers are
 * denied because aggregate business trends exceed what "read a ticket" means,
 * matching the registry's existing rationale.
 *
 * Endpoints are consolidated by concern (overview / tickets / performance /
 * AI / report) rather than one per entity: customer, conversation, escalation
 * and KB counts are part of the overview snapshot, which keeps the number of
 * expensive aggregations a client can trigger per page load bounded.
 */
const analyticsLimiter = createRateLimiter({ windowMs: 60_000, limit: 60 });
const requireWorkspace = requireWorkspaceContext();
const requireViewAnalytics = requirePermission(WORKSPACE_PERMISSIONS.viewAnalytics);
const validateWorkspaceParams = validate(analyticsParamsSchema, 'params');

export const analyticsRouter = Router({ mergeParams: true });

analyticsRouter.use(requireAuth, analyticsLimiter);

analyticsRouter.get(
  '/overview',
  validateWorkspaceParams,
  requireWorkspace,
  requireViewAnalytics,
  validate(analyticsRangeQuerySchema, 'query'),
  getOverviewController,
);

analyticsRouter.get(
  '/tickets',
  validateWorkspaceParams,
  requireWorkspace,
  requireViewAnalytics,
  validate(analyticsTimeSeriesQuerySchema, 'query'),
  getTicketAnalyticsController,
);

analyticsRouter.get(
  '/performance',
  validateWorkspaceParams,
  requireWorkspace,
  requireViewAnalytics,
  validate(analyticsRangeQuerySchema, 'query'),
  getPerformanceController,
);

analyticsRouter.get(
  '/ai',
  validateWorkspaceParams,
  requireWorkspace,
  requireViewAnalytics,
  validate(analyticsTimeSeriesQuerySchema, 'query'),
  getAiAnalyticsController,
);

// Static report path is declared before any `/:id`-shaped route (there is none
// today) so it can never be swallowed; `.csv` is part of the literal path.
analyticsRouter.get(
  '/reports/tickets.csv',
  validateWorkspaceParams,
  requireWorkspace,
  requireViewAnalytics,
  validate(ticketReportQuerySchema, 'query'),
  exportTicketsController,
);
