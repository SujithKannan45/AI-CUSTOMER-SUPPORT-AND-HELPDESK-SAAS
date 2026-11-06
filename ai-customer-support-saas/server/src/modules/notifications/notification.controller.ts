import type { Request, RequestHandler } from 'express';

import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';
import { resolveEffectiveRole } from '../rbac/require-permission.middleware.js';

import {
  getNotificationPreferencesFlow,
  listNotificationsFlow,
  markAllNotificationsReadFlow,
  markNotificationReadFlow,
  unreadNotificationCountFlow,
  updateNotificationPreferencesFlow,
  type NotificationRequestContext,
} from './notification.service.js';
import type {
  ListNotificationsQuery,
  NotificationParams,
  UpdateNotificationPreferencesInput,
} from './notification.validation.js';

/**
 * Notification controllers — HTTP shape only (parse → service → respond), the
 * same thin composition as every other module.
 *
 * Authorization already ran in middleware:
 *   requireAuth → validate(params) → requireWorkspaceContext() → [limiter]
 *
 * There is deliberately NO `requirePermission(...)` on these routes: the
 * resources are the caller's OWN inbox and preferences, and workspace
 * membership (proven by requireWorkspaceContext) is the correct gate. A
 * viewer muting their own emails is not a privileged action.
 */

interface NotificationValidatedRequest extends Request {
  readonly validated?: {
    readonly params?: NotificationParams;
  };
}

function contextOf(req: NotificationValidatedRequest): NotificationRequestContext {
  const workspace = req.workspace!;
  return {
    workspaceId: workspace.workspaceId,
    actorId: req.auth!.userId,
    role: resolveEffectiveRole(workspace),
  };
}

function notificationIdOf(req: NotificationValidatedRequest): string {
  return req.validated!.params!.notificationId;
}

/** GET …/notifications — the caller's inbox (newest first, paginated). */
export const listNotificationsController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as NotificationValidatedRequest;
  const payload = await listNotificationsFlow(contextOf(r), req.query as unknown as ListNotificationsQuery);
  sendSuccess(res, 200, payload, req);
});

/** GET …/notifications/unread-count — badge count for the authenticated user. */
export const unreadNotificationCountController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as NotificationValidatedRequest;
  const payload = await unreadNotificationCountFlow(contextOf(r));
  sendSuccess(res, 200, payload, req);
});

/** POST …/notifications/:notificationId/read — idempotent single read. */
export const markNotificationReadController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as NotificationValidatedRequest;
  const payload = await markNotificationReadFlow(contextOf(r), notificationIdOf(r));
  sendSuccess(res, 200, payload, req);
});

/** POST …/notifications/read-all — marks every unread item the caller owns. */
export const markAllNotificationsReadController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as NotificationValidatedRequest;
  const payload = await markAllNotificationsReadFlow(contextOf(r));
  sendSuccess(res, 200, payload, req);
});

/** GET …/notifications/preferences — the caller's effective preferences. */
export const getNotificationPreferencesController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as NotificationValidatedRequest;
  const payload = await getNotificationPreferencesFlow(contextOf(r));
  sendSuccess(res, 200, payload, req);
});

/** PATCH …/notifications/preferences — partial update (audited, field names only). */
export const updateNotificationPreferencesController: RequestHandler = asyncHandler(
  async (req, res) => {
    const r = req as NotificationValidatedRequest;
    const payload = await updateNotificationPreferencesFlow(
      contextOf(r),
      req.body as UpdateNotificationPreferencesInput,
      req,
    );
    sendSuccess(res, 200, payload, req);
  },
);
