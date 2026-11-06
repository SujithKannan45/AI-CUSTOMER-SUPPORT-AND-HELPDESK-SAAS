import { type NextFunction, type Request, type Response, Router } from 'express';
import { flattenError } from 'zod';

import { AppError } from '../../core/errors/app-error.js';
import { createRateLimiter } from '../../core/middlewares/rate-limiter.middleware.js';
import { validate } from '../../core/middlewares/validate.middleware.js';
import { requireAuth } from '../auth/require-auth.middleware.js';
import { requireWorkspaceContext } from '../workspaces/require-workspace.middleware.js';

import {
  getNotificationPreferencesController,
  listNotificationsController,
  markAllNotificationsReadController,
  markNotificationReadController,
  unreadNotificationCountController,
  updateNotificationPreferencesController,
} from './notification.controller.js';
import {
  listNotificationsQuerySchema,
  notificationParamsSchema,
  notificationWorkspaceParamsSchema,
  updateNotificationPreferencesSchema,
} from './notification.validation.js';

/**
 * Notification routes (Prompt 16) — mounted at
 * `/api/v1/workspaces/:workspaceId/notifications`.
 *
 * Gate order per route (identical to every other module):
 *
 *   1. requireAuth                  → 401
 *   2. param validation             → 422
 *   3. requireWorkspaceContext()    → 404 (foreign/inactive membership concealed)
 *   4. limiter (self-service reads/writes)
 *
 * NO permission gate: these are SELF-scoped resources (the caller's own inbox
 * and preferences). Workspace membership is the authorization boundary, and
 * the recipient is derived from `req.auth.userId` — never from the path or
 * body — so cross-user access is unrepresentable.
 *
 * `/preferences` is declared BEFORE `/:notificationId` so the static segment
 * can never be swallowed by the id route.
 */
const notificationLimiter = createRateLimiter({ windowMs: 60_000, limit: 120 });
const requireWorkspace = requireWorkspaceContext();

function paramValidator(schema: typeof notificationWorkspaceParamsSchema | typeof notificationParamsSchema) {
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

const validateWorkspaceParams = paramValidator(notificationWorkspaceParamsSchema);
const validateNotificationParams = paramValidator(notificationParamsSchema);

export const notificationRouter = Router({ mergeParams: true });

notificationRouter.use(requireAuth, notificationLimiter);

notificationRouter.get(
  '/',
  validateWorkspaceParams,
  requireWorkspace,
  validate(listNotificationsQuerySchema, 'query'),
  listNotificationsController,
);
notificationRouter.get(
  '/unread-count',
  validateWorkspaceParams,
  requireWorkspace,
  unreadNotificationCountController,
);
notificationRouter.get(
  '/preferences',
  validateWorkspaceParams,
  requireWorkspace,
  getNotificationPreferencesController,
);
notificationRouter.patch(
  '/preferences',
  validateWorkspaceParams,
  requireWorkspace,
  validate(updateNotificationPreferencesSchema),
  updateNotificationPreferencesController,
);
notificationRouter.post(
  '/read-all',
  validateWorkspaceParams,
  requireWorkspace,
  markAllNotificationsReadController,
);
notificationRouter.post(
  '/:notificationId/read',
  validateNotificationParams,
  requireWorkspace,
  markNotificationReadController,
);
