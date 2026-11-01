import { type NextFunction, type Request, type Response, Router } from 'express';
import { flattenError } from 'zod';

import { AppError } from '../../core/errors/app-error.js';
import { createRateLimiter } from '../../core/middlewares/rate-limiter.middleware.js';
import { validate } from '../../core/middlewares/validate.middleware.js';
import { requireAuth } from '../auth/require-auth.middleware.js';
import { WORKSPACE_PERMISSIONS } from '../rbac/rbac.permissions.js';
import { requirePermission } from '../rbac/require-permission.middleware.js';
import { requireWorkspaceContext } from '../workspaces/require-workspace.middleware.js';

import {
  acceptEscalationController,
  assignEscalationController,
  cancelEscalationController,
  createEscalationController,
  getEscalationController,
  getEscalationHistoryController,
  listEscalationsController,
  resolveEscalationController,
} from './escalation.controller.js';
import {
  acceptEscalationSchema,
  assignEscalationSchema,
  cancelEscalationSchema,
  createEscalationSchema,
  escalationParamsSchema,
  escalationWorkspaceParamsSchema,
  listEscalationsQuerySchema,
  resolveEscalationSchema,
} from './escalation.validation.js';

/**
 * Escalation routes (Prompt 15) — mounted at
 * `/api/v1/workspaces/:workspaceId/escalations`.
 *
 * Gate order per route (identical to every other module):
 *
 *   1. requireAuth                      → 401
 *   2. validate(schema, source)         → 422
 *   3. requireWorkspaceContext()        → 404 (foreign/inactive concealed)
 *   4. requirePermission(...)           → 403 (registry decision + audit)
 *
 * Permissions:
 * - `escalation.view`   → reads (queue, detail, history).
 * - `escalation.manage` → all lifecycle mutations (create/assign/accept/
 *   resolve/cancel). Granted owner/admin/agent; viewer is read-only.
 *
 * Service-level ownership caps ADD to these gates (never replace them):
 * reassignment requires the `ticket.assign` permission (owner/admin, the
 * same grant as tickets), acceptance of an ASSIGNED record only by its
 * assignee, resolution by the acceptee or an administrator, and cancellation
 * only by involved staff. Inference-free mutations keep the 60/min limiter
 * (same as RAG indexing tier; no paid provider call sits behind these).
 *
 * Express 5 note: `req.params` is a LIVE getter; plain assignment (e.g. in
 * routers that rewrite params) cannot replace it, so the small route-specific
 * validators below raise the SAME 422 the shared validate middleware
 * produces and install validated values on `req.validated.params` (the
 * pattern the agent routes use), while requireWorkspaceContext consumes the
 * raw workspaceId to establish tenant context exactly as every module does.
 */

/** Contracts 60 lifecycle mutations/min/IP — comfortable for desks, bounded for abuse. */
const escalationLimiter = createRateLimiter({ windowMs: 60_000, limit: 60 });
const requireViewEscalations = requirePermission(WORKSPACE_PERMISSIONS.viewEscalations);
const requireManageEscalations = requirePermission(WORKSPACE_PERMISSIONS.manageEscalations);
const requireWorkspace = requireWorkspaceContext();

function paramValidator(schema: typeof escalationWorkspaceParamsSchema | typeof escalationParamsSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      const flattened = flattenError(parsed.error);
      const details: Record<string, unknown> = { ...flattened.fieldErrors };
      if (flattened.formErrors.length > 0) details['formErrors'] = flattened.formErrors;
      next(AppError.validation('Request validation failed', details));
      return;
    }
    const request = req as unknown as { validated?: { params?: unknown } };
    request.validated ??= {};
    request.validated['params'] = parsed.data;
    next();
  };
}

const validateWorkspaceParams = paramValidator(escalationWorkspaceParamsSchema);
const validateEscalationParams = paramValidator(escalationParamsSchema);

export const escalationRouter = Router({ mergeParams: true });

escalationRouter.use(requireAuth, escalationLimiter);

// Escalation collection under the workspace tenant context — reads and
// lifecycle mutations with uniform gates:
escalationRouter.post(
  '/',
  validateWorkspaceParams,
  requireWorkspace,
  requireManageEscalations,
  validate(createEscalationSchema),
  createEscalationController,
);
escalationRouter.get(
  '/',
  validateWorkspaceParams,
  requireWorkspace,
  requireViewEscalations,
  validate(listEscalationsQuerySchema, 'query'),
  listEscalationsController,
);
escalationRouter.get(
  '/:escalationId',
  validateEscalationParams,
  requireWorkspace,
  requireViewEscalations,
  getEscalationController,
);
escalationRouter.get(
  '/:escalationId/history',
  validateEscalationParams,
  requireWorkspace,
  requireViewEscalations,
  getEscalationHistoryController,
);

escalationRouter.post(
  '/:escalationId/assign',
  validateEscalationParams,
  requireWorkspace,
  requireManageEscalations,
  validate(assignEscalationSchema),
  assignEscalationController,
);
escalationRouter.post(
  '/:escalationId/accept',
  validateEscalationParams,
  requireWorkspace,
  requireManageEscalations,
  validate(acceptEscalationSchema),
  acceptEscalationController,
);
escalationRouter.post(
  '/:escalationId/resolve',
  validateEscalationParams,
  requireWorkspace,
  requireManageEscalations,
  validate(resolveEscalationSchema),
  resolveEscalationController,
);
escalationRouter.post(
  '/:escalationId/cancel',
  validateEscalationParams,
  requireWorkspace,
  requireManageEscalations,
  validate(cancelEscalationSchema),
  cancelEscalationController,
);
