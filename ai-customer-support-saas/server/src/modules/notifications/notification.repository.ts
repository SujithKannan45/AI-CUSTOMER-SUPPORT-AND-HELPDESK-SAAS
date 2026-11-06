import { type FilterQuery, Types } from 'mongoose';

import { assertTenantScope, tenantFilter } from '../../database/tenant.js';

import {
  isDuplicateNotificationError,
  NotificationModel,
} from './notification.model.js';
import type {
  NotificationDocument,
  NotificationEntityType,
  NotificationIntent,
  NotificationType,
} from './notification.types.js';

/**
 * Notification persistence — the ONLY module touching the `notifications`
 * collection.
 *
 * Isolation law: every filter is built through `tenantFilter()` and asserted
 * with `assertTenantScope()`, and EVERY read/mutation ALSO filters on
 * `recipientId`. A caller can therefore never enumerate another user's inbox,
 * and a foreign/unknown id reads as "not found" (no existence oracle).
 *
 * Idempotency law: creation is an idempotent insert over the unique
 * `{ workspaceId, recipientId, eventKey }` index. A duplicated event loses
 * safely and returns `null` — the dispatcher treats that as "already
 * notified" and never sends a second email for it.
 */

export interface CreateNotificationOutcome {
  readonly notification: NotificationDocument;
  readonly created: boolean;
}

/**
 * Idempotent creation. Returns `created: false` when the event key already
 * exists for this recipient (retry/duplicate), without throwing: a repeated
 * domain event is normal operation, not an error.
 */
export async function createNotificationIfAbsent(
  intent: NotificationIntent,
  workspaceId: Types.ObjectId,
): Promise<CreateNotificationOutcome | null> {
  const filter: FilterQuery<NotificationDocument> = {
    ...tenantFilter(workspaceId),
    recipientId: intent.recipientId,
    eventKey: intent.eventKey,
  };
  assertTenantScope(filter, 'createNotificationIfAbsent');

  const existing = await NotificationModel.findOne(filter);
  if (existing !== null) return { notification: existing, created: false };

  try {
    const notification = await NotificationModel.create({
      ...tenantFilter(workspaceId),
      recipientId: intent.recipientId,
      type: intent.type,
      title: intent.title,
      body: intent.body,
      entityType: intent.entityType,
      entityId: intent.entityId,
      eventKey: intent.eventKey,
      readAt: null,
    });
    return { notification, created: true };
  } catch (error: unknown) {
    // Lost a creation race: the winner's row is the authoritative one.
    if (!isDuplicateNotificationError(error)) throw error;
    const winner = await NotificationModel.findOne(filter);
    return winner === null ? null : { notification: winner, created: false };
  }
}

export interface ListNotificationsSpec {
  readonly workspaceId: Types.ObjectId;
  readonly recipientId: Types.ObjectId;
  readonly page: number;
  readonly limit: number;
  readonly unreadOnly: boolean;
  readonly type?: NotificationType;
  readonly entityType?: NotificationEntityType;
  readonly entityId?: string;
}

export interface ListNotificationsResult {
  readonly items: NotificationDocument[];
  readonly total: number;
  readonly hasMore: boolean;
}

export async function listNotifications(
  spec: ListNotificationsSpec,
): Promise<ListNotificationsResult> {
  const filter: FilterQuery<NotificationDocument> = {
    ...tenantFilter(spec.workspaceId),
    recipientId: spec.recipientId,
    ...(spec.unreadOnly ? { readAt: null } : {}),
    ...(spec.type !== undefined ? { type: spec.type } : {}),
    ...(spec.entityType !== undefined ? { entityType: spec.entityType } : {}),
    ...(spec.entityId !== undefined ? { entityId: new Types.ObjectId(spec.entityId) } : {}),
  };
  assertTenantScope(filter, 'listNotifications');

  const skip = (spec.page - 1) * spec.limit;
  const [items, total] = await Promise.all([
    NotificationModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(spec.limit),
    NotificationModel.countDocuments(filter),
  ]);

  return { items, total, hasMore: skip + items.length < total };
}

/** Unread count for ONE recipient — the frontend badge. */
export async function countUnreadNotifications(
  workspaceId: Types.ObjectId,
  recipientId: Types.ObjectId,
): Promise<number> {
  const filter: FilterQuery<NotificationDocument> = {
    ...tenantFilter(workspaceId),
    recipientId,
    readAt: null,
  };
  assertTenantScope(filter, 'countUnreadNotifications');
  return NotificationModel.countDocuments(filter);
}

/**
 * Marks ONE notification read. Idempotent: an already-read notification keeps
 * its ORIGINAL read timestamp (a second call is not a second read event), and
 * a notification that belongs to someone else — or another workspace — reads
 * as null so the service can answer 404.
 */
export async function markNotificationRead(
  workspaceId: Types.ObjectId,
  recipientId: Types.ObjectId,
  notificationId: Types.ObjectId,
): Promise<NotificationDocument | null> {
  const filter: FilterQuery<NotificationDocument> = {
    ...tenantFilter(workspaceId),
    recipientId,
    _id: notificationId,
    readAt: null,
  };
  assertTenantScope(filter, 'markNotificationRead');

  const updated = await NotificationModel.findOneAndUpdate(
    filter,
    { $set: { readAt: new Date() } },
    { new: true },
  );
  if (updated !== null) return updated;

  // Either already read (idempotent success) or not ours/missing (null).
  const existingFilter: FilterQuery<NotificationDocument> = {
    ...tenantFilter(workspaceId),
    recipientId,
    _id: notificationId,
  };
  assertTenantScope(existingFilter, 'markNotificationRead/existing');
  return NotificationModel.findOne(existingFilter);
}

/** Marks ALL of this recipient's unread notifications read; returns the count. */
export async function markAllNotificationsRead(
  workspaceId: Types.ObjectId,
  recipientId: Types.ObjectId,
): Promise<number> {
  const filter: FilterQuery<NotificationDocument> = {
    ...tenantFilter(workspaceId),
    recipientId,
    readAt: null,
  };
  assertTenantScope(filter, 'markAllNotificationsRead');
  const result = await NotificationModel.updateMany(filter, { $set: { readAt: new Date() } });
  return result.modifiedCount;
}
