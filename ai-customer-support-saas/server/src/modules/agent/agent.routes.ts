import { Router ,type  NextFunction,type  Request,type  Response } from 'express';
import { flattenError } from 'zod';

import { AppError } from '../../core/errors/app-error.js';
import { createRateLimiter } from '../../core/middlewares/rate-limiter.middleware.js';
import { validate } from '../../core/middlewares/validate.middleware.js';
import { requireAuth } from '../auth/require-auth.middleware.js';
import { WORKSPACE_PERMISSIONS } from '../rbac/rbac.permissions.js';
import { requirePermission } from '../rbac/require-permission.middleware.js';
import { requireWorkspaceContext } from '../workspaces/require-workspace.middleware.js';

import { askAgentController } from './agent.controller.js';
import { agentQuestionBodySchema, agentQuestionParamsSchema } from './agent.validation.js';

/**
 * Agent routes (Prompt 14) — mounted at
 * `/api/v1/workspaces/:workspaceId/agent`.
 *
 * Gate order per route (identical to every other module):
 *
 *   1. requireAuth                      → 401
 *   2. validate(schema, source)         → 422
 *   3. requireWorkspaceContext()        → 404 (foreign/inactive concealed)
 *   4. requirePermission(...)           → 403 (registry decision + audit)
 *
 * Permission: `agent.ask` — granted to owner/admin/agent (staff answer
 * preview). Deliberately NOT granted to viewer: each request may invoke a
 * paid provider call, and generation is desk/staff work, not read-only
 * business record access.
 *
 * Inference calls a paid provider: a dedicated 10/min/IP limiter (tighter
 * than the 30/min indexing limiter) keeps bulk inference impossible.
 */

const askLimiter = createRateLimiter({ windowMs: 60_000, limit: 10 });
const requireAskAgent = requirePermission(WORKSPACE_PERMISSIONS.askAgent);
const requireWorkspace = requireWorkspaceContext();

/**
 * Express 5 note: `req.params` is a LIVE getter; object spread copies (e.g.
 * in routers that use `Object.assign` over `%74` params) cannot replace it,
 * so a plain schema cannot install validated values. The agent's small,
 * route-specific validator reads the raw value and raises the SAME 422 the
 * shared validate middleware produces when validation fails — the raw value
 * itself is then consumed by requireWorkspaceContext to establish the
 * tenant context exactly as every other module does.
 */
function validateAgentParams(req: Request, _res: Response, next: NextFunction): void {
  const parsed = agentQuestionParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    const flattened = flattenError(parsed.error);
    const details: Record<string, unknown> = { ...flattened.fieldErrors };
    if (flattened.formErrors.length > 0) {
      details['formErrors'] = flattened.formErrors;
    }
    next(AppError.validation('Request validation failed', details));
    return;
  }
  const request = req as unknown as { validated?: { params?: unknown } };
  request.validated ??= {};
  request.validated['params'] = parsed.data;
  next();
}

export const agentRouter = Router({ mergeParams: true });

agentRouter.post(
  '/ask',
  requireAuth,
  askLimiter,
  validateAgentParams,
  validate(agentQuestionBodySchema),
  requireWorkspace,
  requireAskAgent,
  askAgentController,
);
