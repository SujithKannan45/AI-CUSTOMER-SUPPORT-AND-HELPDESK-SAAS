import type { Types } from 'mongoose';

import type { TenantScopedDocument } from '../../database/tenant.js';
import type { TicketPriority, TicketStatus } from '../tickets/ticket.types.js';

/**
 * Notification domain vocabulary (Prompt 16).
 *
 * Content law: a notification carries a SHORT, already-composed title/body
 * (machine facts such as ticket number, status and priority) plus entity
 * references. Conversation bodies, internal notes, AI prompts, retrieved
 * passages and resolution/cancel notes NEVER enter this collection — the
 * recipient list of some events includes customers in future prompts, so the
 * preview must be safe by construction, not by filtering later.
 */

/**
 * Event-shaped notification types. Dotted identifiers keep the vocabulary
 * grep/dashboard friendly and let the frontend switch on `type` without
 * parsing prose.
 */
export const NOTIFICATION_TYPES = [
  'ticket.created',
  'ticket.assigned',
  'ticket.reassigned',
  'ticket.status_changed',
  'ticket.priority_changed',
  'conversation.public_message',
  'escalation.created',
  'escalation.assigned',
  'escalation.reassigned',
  'escalation.accepted',
  'escalation.resolved',
  'escalation.cancelled',
  'ai.handoff',
  'ai.failure',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** The entity a notification points at (the frontend resolves its own route). */
export const NOTIFICATION_ENTITY_TYPES = ['ticket', 'conversation', 'escalation'] as const;
export type NotificationEntityType = (typeof NOTIFICATION_ENTITY_TYPES)[number];

/**
 * Preference categories — the coarsest unit a user can mute without losing
 * mandatory operational notice. Each notification type maps to EXACTLY one
 * category (see `notification.preferences.ts`), so a preference toggle can
 * never silently leave an event category unhandled.
 */
export const NOTIFICATION_CATEGORIES = [
  'ticketAssignment',
  'ticketUpdates',
  'publicReplies',
  'escalations',
  'aiHandoff',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Channel + category preferences per (workspace, user).
 *
 * Defaults are "everything on": a support desk that misses an assignment is
 * worse than an inbox that is slightly noisy. `inAppEnabled`/`emailEnabled`
 * are channel switches; the category booleans gate BOTH channels for their
 * events (a user who muted "publicReplies" does not want the email either).
 */
export interface NotificationPreferenceDocument extends TenantScopedDocument {
  /** The staff user these preferences belong to (never client-supplied). */
  userId: Types.ObjectId;
  /** In-app notification records for this user. */
  inAppEnabled: boolean;
  /** Transactional email delivery for this user. */
  emailEnabled: boolean;
  /** Ticket assignment / reassignment events. */
  ticketAssignment: boolean;
  /** Ticket creation, status and priority changes. */
  ticketUpdates: boolean;
  /** New PUBLIC conversation messages. */
  publicReplies: boolean;
  /** Escalation lifecycle events (created/assigned/accepted/resolved/cancelled). */
  escalations: boolean;
  /** AI → human handoff and AI "needs human attention" events. */
  aiHandoff: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Plain preference values (defaults applied) — the resolved read model. */
export type NotificationPreferenceValues = {
  readonly [K in
    | 'inAppEnabled'
    | 'emailEnabled'
    | 'ticketAssignment'
    | 'ticketUpdates'
    | 'publicReplies'
    | 'escalations'
    | 'aiHandoff']: boolean;
};

/**
 * Notification — one in-app inbox entry for ONE recipient in ONE workspace.
 *
 * Isolation: `{ workspaceId, recipientId }` is the access key; every read and
 * mutation filters on both, so another user's notification is indistinguishable
 * from a missing one (404, never 403 — no existence oracle).
 *
 * Idempotency: `eventKey` is derived by the PUBLISHER from persisted facts
 * (`<entityId>:<kind>:<updatedAtMs>`), so a retried/duplicated domain event
 * produces the same key and the unique index rejects the second insert.
 */
export interface NotificationDocument extends TenantScopedDocument {
  recipientId: Types.ObjectId;
  type: NotificationType;
  /** Short, content-safe headline (e.g. "You were assigned ticket TCK-1042"). */
  title: string;
  /** One-line, content-safe description (never a message body or note). */
  body: string;
  entityType: NotificationEntityType;
  entityId: Types.ObjectId;
  /** Stable per-event key — the duplicate-prevention law (unique per recipient). */
  eventKey: string;
  /** Null = unread. Set once; marking read twice is an idempotent no-op. */
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Email delivery lifecycle. `SENT` means the PROVIDER ACCEPTED the message —
 * this deployment has no delivery webhook, so it is NOT proof of inbox
 * delivery, and nothing here claims otherwise.
 */
export const EMAIL_DELIVERY_STATUSES = [
  'PENDING',
  'PROCESSING',
  'SENT',
  'FAILED',
  'RETRY_PENDING',
] as const;
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];

/**
 * EmailDelivery — the durable delivery ledger.
 *
 * One row per (event, recipient). The provider is asked at most once per
 * attempt; retries reuse the SAME row (attempt counter + backoff), and the
 * unique index on `{ workspaceId, eventKey, recipientId }` is what prevents a
 * duplicated domain event from producing a second email.
 *
 * Honesty law: `acceptedAt` records provider acceptance. There is no queue,
 * worker or delivery confirmation in this deployment — a `RETRY_PENDING` row
 * only progresses when `sweepEmailDeliveries()` is invoked (documented in
 * docs/architecture.md), never from a hidden timer.
 */
export interface EmailDeliveryDocument extends TenantScopedDocument {
  recipientId: Types.ObjectId;
  /** In-app notification this email mirrors (null when in-app was muted). */
  notificationId: Types.ObjectId | null;
  /** Recipient address SNAPSHOT (never re-resolved at retry time). */
  to: string;
  templateKey: NotificationType;
  /** Content-safe headline reused for (re)rendering — same law as the inbox row. */
  title: string;
  /** Content-safe one-liner reused for (re)rendering. */
  body: string;
  eventKey: string;
  status: EmailDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  /** Stable machine code of the LAST failure — never a provider stack trace. */
  lastErrorCode: string | null;
  /** Provider that accepted the message (null until accepted). */
  provider: string | null;
  /** Provider acceptance timestamp — not proof of inbox delivery. */
  acceptedAt: Date | null;
  /** Earliest time the sweep may retry (exponential backoff). */
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A notification intent: what the mapping layer decided SHOULD be created for
 * one recipient. The dispatcher persists it, then queues email for it.
 *
 * `templateKey` is a NotificationType (the email registry keys off the same
 * vocabulary) so a new notification type cannot ship without deciding its
 * email rendering.
 */
export interface NotificationIntent {
  readonly recipientId: Types.ObjectId;
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string;
  readonly entityType: NotificationEntityType;
  readonly entityId: Types.ObjectId;
  readonly eventKey: string;
}

/** Facts the mapping layer needs about the affected ticket (bounded, no content). */
export interface TicketNotificationContext {
  readonly ticketId: Types.ObjectId;
  readonly ticketNumber: string;
  readonly subject: string;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
}
