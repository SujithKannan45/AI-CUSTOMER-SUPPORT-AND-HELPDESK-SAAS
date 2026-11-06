import type { Request } from 'express';
import { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import type { WorkspaceRole } from '../workspaces/workspace.types.js';

import {
  NOTIFICATION_AUDIT_ACTIONS,
  recordNotificationAudit,
} from './notification-audit.js';
import {
  findNotificationPreferences,
  updateNotificationPreferences,
} from './notification-preference.repository.js';
import {
  toNotificationDto,
  type NotificationListPayload,
  type NotificationPreferencesDto,
  type NotificationPreferencesPayload,
  type NotificationReadAllPayload,
  type NotificationReadPayload,
  type NotificationUnreadCountPayload,
} from './notification.dto.js';
import { resolvePreferenceValues } from './notification.preferences.js';
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './notification.repository.js';
import type { NotificationPreferenceDocument } from './notification.types.js';
import type {
  ListNotificationsQuery,
  UpdateNotificationPreferencesInput,
} from './notification.validation.js';

/**
 * Notification business flows (Prompt 16) — controllers stay thin; the
 * workspace and the ACTOR both come from validated middleware context.
 *
 * Self-service law: every operation is scoped to
 * `{ workspaceId (validated param), recipientId = actorId (authenticated) }`.
 * There is no path that takes a user id from the client, so "read someone
 * else's notification" is not a rejected request — it is unrepresentable.
 * A foreign/unknown notification id returns 404 (no existence oracle).
 */

export interface NotificationRequestContext {
  /** Validated workspace context id (middleware), hex string. */
  readonly workspaceId: string;
  /** Authenticated user (never a client field). */
  readonly actorId: string;
  /** Effective role from the validated membership (unused for filtering). */
  readonly role: WorkspaceRole;
}

const NOTIFICATION_NOT_FOUND = 'Notification not found';

export async function listNotificationsFlow(
  context: NotificationRequestContext,
  query: ListNotificationsQuery,
): Promise<NotificationListPayload> {
  const result = await listNotifications({
    workspaceId: new Types.ObjectId(context.workspaceId),
    recipientId: new Types.ObjectId(context.actorId),
    page: query.page,
    limit: query.limit,
    unreadOnly: query.unread,
    ...(query.type !== undefined ? { type: query.type } : {}),
    ...(query.entityType !== undefined ? { entityType: query.entityType } : {}),
    ...(query.entityId !== undefined ? { entityId: query.entityId } : {}),
  });

  return {
    items: result.items.map((document) => toNotificationDto(document)),
    page: query.page,
    limit: query.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
}

export async function unreadNotificationCountFlow(
  context: NotificationRequestContext,
): Promise<NotificationUnreadCountPayload> {
  const unreadCount = await countUnreadNotifications(
    new Types.ObjectId(context.workspaceId),
    new Types.ObjectId(context.actorId),
  );
  return { unreadCount };
}

export async function markNotificationReadFlow(
  context: NotificationRequestContext,
  notificationId: string,
): Promise<NotificationReadPayload> {
  const document = await markNotificationRead(
    new Types.ObjectId(context.workspaceId),
    new Types.ObjectId(context.actorId),
    new Types.ObjectId(notificationId),
  );
  if (document === null) throw AppError.notFound(NOTIFICATION_NOT_FOUND);
  return { notification: toNotificationDto(document) };
}

export async function markAllNotificationsReadFlow(
  context: NotificationRequestContext,
): Promise<NotificationReadAllPayload> {
  const markedRead = await markAllNotificationsRead(
    new Types.ObjectId(context.workspaceId),
    new Types.ObjectId(context.actorId),
  );
  return { markedRead };
}

// ── Preferences ──────────────────────────────────────────────────────────────

function toPreferencesDto(
  context: NotificationRequestContext,
  document: NotificationPreferenceDocument | null,
): NotificationPreferencesDto {
  const values = resolvePreferenceValues(document);
  return {
    ...values,
    workspaceId: context.workspaceId,
    userId: context.actorId,
    updatedAt: document === null ? null : document.updatedAt.toISOString(),
  };
}

/**
 * Reads the caller's preferences. A user who never changed anything gets the
 * documented DEFAULTS with `updatedAt: null` — reading is side-effect free (no
 * row is created just by opening the settings page).
 */
export async function getNotificationPreferencesFlow(
  context: NotificationRequestContext,
): Promise<NotificationPreferencesPayload> {
  const document = await findNotificationPreferences(
    new Types.ObjectId(context.workspaceId),
    new Types.ObjectId(context.actorId),
  );
  return { preferences: toPreferencesDto(context, document) };
}

export async function updateNotificationPreferencesFlow(
  context: NotificationRequestContext,
  input: UpdateNotificationPreferencesInput,
  request?: Request,
): Promise<NotificationPreferencesPayload> {
  // `undefined` keys are dropped so a partial patch never resets other fields.
  const updates = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as UpdateNotificationPreferencesInput;

  const document = await updateNotificationPreferences(
    new Types.ObjectId(context.workspaceId),
    new Types.ObjectId(context.actorId),
    updates,
  );

  recordNotificationAudit({
    action: NOTIFICATION_AUDIT_ACTIONS.preferencesUpdated,
    workspaceId: new Types.ObjectId(context.workspaceId),
    actorId: new Types.ObjectId(context.actorId),
    // Field NAMES only — never values, never anything addressable.
    metadata: { fields: Object.keys(updates) },
    ...(request !== undefined ? { request } : {}),
  });

  return { preferences: toPreferencesDto(context, document) };
}
