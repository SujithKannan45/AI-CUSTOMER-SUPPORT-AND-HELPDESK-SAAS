import { Schema, model } from 'mongoose';

import { NOTIFICATION_ENTITY_TYPES, NOTIFICATION_TYPES, type NotificationDocument } from './notification.types.js';

/**
 * Notification persistence (Prompt 16).
 *
 * Index strategy — every index leads with `workspaceId` (tenancy convention)
 * and earns its keep:
 * - `{ workspaceId, recipientId, createdAt: -1, _id: -1 }`: the inbox feed,
 *   newest-first, keyset-friendly (`_id` breaks createdAt ties).
 * - `{ workspaceId, recipientId, readAt }`: unread count and "unread only"
 *   filter; `readAt` is null for unread, so the count is an index count.
 * - `{ workspaceId, recipientId, eventKey }` UNIQUE: duplicate-prevention law.
 *   A duplicated/retried domain event cannot create a second inbox entry for
 *   the same recipient.
 *
 * No soft delete: notifications are low-value, bounded rows. Archiving is
 * expressed by marking read; retention is a deploy-time TTL decision
 * (documented in docs/data-model.md), not invented here.
 */
const notificationSchema = new Schema<NotificationDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    recipientId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Recipient is required'],
    },
    type: {
      type: String,
      enum: NOTIFICATION_TYPES,
      required: true,
    },
    title: {
      type: String,
      required: [true, 'Notification title is required'],
      trim: true,
      maxlength: 200,
    },
    body: {
      type: String,
      required: [true, 'Notification body is required'],
      trim: true,
      maxlength: 500,
    },
    entityType: {
      type: String,
      enum: NOTIFICATION_ENTITY_TYPES,
      required: true,
    },
    entityId: {
      type: Schema.Types.ObjectId,
      required: [true, 'Entity reference is required'],
    },
    eventKey: {
      type: String,
      required: [true, 'Event key is required'],
      trim: true,
      maxlength: 200,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

notificationSchema.index(
  { workspaceId: 1, recipientId: 1, createdAt: -1, _id: -1 },
  { name: 'idx_notifications_inbox' },
);
notificationSchema.index(
  { workspaceId: 1, recipientId: 1, readAt: 1 },
  { name: 'idx_notifications_unread' },
);
notificationSchema.index(
  { workspaceId: 1, recipientId: 1, eventKey: 1 },
  { unique: true, name: 'uniq_notification_event_per_recipient' },
);

export const NotificationModel = model<NotificationDocument>(
  'Notification',
  notificationSchema,
  'notifications',
);

/** MongoDB duplicate-key test for the idempotency path (no driver import needed). */
export function isDuplicateNotificationError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}
