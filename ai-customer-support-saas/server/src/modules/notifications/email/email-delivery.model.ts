import { Schema, model } from 'mongoose';

import {
  EMAIL_DELIVERY_STATUSES,
  NOTIFICATION_TYPES,
  type EmailDeliveryDocument,
} from '../notification.types.js';

/**
 * EmailDelivery persistence — the durable email ledger.
 *
 * Index strategy:
 * - `{ workspaceId, eventKey, recipientId }` UNIQUE: one email per event per
 *   recipient. This is the duplicate-email law: a retried domain event (or a
 *   racing dispatcher) cannot enqueue a second message.
 * - `{ workspaceId, status, nextAttemptAt }`: the retry sweep
 *   (`sweepEmailDeliveries`) scans only due rows.
 * - `{ workspaceId, recipientId, createdAt: -1 }`: a recipient's delivery
 *   history for support/debugging (no admin endpoint is exposed for it).
 *
 * Content law: the ledger stores the SAME content-safe title/body as the
 * in-app notification (ticket number, status, priority — never a message
 * body, internal note, AI prompt or retrieved passage). Storing them lets a
 * RETRY re-render without re-reading the event, and supports the
 * email-only preference (in-app muted). The rendered HTML/text is never
 * persisted, and no email body is ever logged.
 */
const emailDeliverySchema = new Schema<EmailDeliveryDocument>(
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
    notificationId: {
      type: Schema.Types.ObjectId,
      ref: 'Notification',
      default: null,
    },
    to: {
      type: String,
      required: [true, 'Recipient address is required'],
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    templateKey: {
      type: String,
      enum: NOTIFICATION_TYPES,
      required: true,
    },
    title: {
      type: String,
      required: [true, 'Email title is required'],
      trim: true,
      maxlength: 200,
    },
    body: {
      type: String,
      required: [true, 'Email body is required'],
      trim: true,
      maxlength: 500,
    },
    eventKey: {
      type: String,
      required: [true, 'Event key is required'],
      trim: true,
      maxlength: 200,
    },
    status: {
      type: String,
      enum: EMAIL_DELIVERY_STATUSES,
      default: 'PENDING',
      required: true,
    },
    attempts: { type: Number, default: 0, required: true, min: 0 },
    maxAttempts: { type: Number, required: true, min: 1, max: 10 },
    lastErrorCode: { type: String, default: null, trim: true, maxlength: 64 },
    provider: { type: String, default: null, trim: true, maxlength: 32 },
    acceptedAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },
  },
  { timestamps: true },
);

emailDeliverySchema.index(
  { workspaceId: 1, eventKey: 1, recipientId: 1 },
  { unique: true, name: 'uniq_email_delivery_per_recipient_event' },
);
emailDeliverySchema.index(
  { workspaceId: 1, status: 1, nextAttemptAt: 1 },
  { name: 'idx_email_delivery_sweep' },
);
emailDeliverySchema.index(
  { workspaceId: 1, recipientId: 1, createdAt: -1 },
  { name: 'idx_email_delivery_recipient' },
);

export const EmailDeliveryModel = model<EmailDeliveryDocument>(
  'EmailDelivery',
  emailDeliverySchema,
  'email_deliveries',
);

/** MongoDB duplicate-key test for the email idempotency path. */
export function isDuplicateEmailDeliveryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}
