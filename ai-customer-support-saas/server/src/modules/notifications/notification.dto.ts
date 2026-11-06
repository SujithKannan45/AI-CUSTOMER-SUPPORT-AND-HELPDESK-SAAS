import type {
  NotificationDocument,
  NotificationEntityType,
  NotificationPreferenceValues,
  NotificationType,
} from './notification.types.js';

/**
 * Notification module — public read models and service payloads (same split as
 * escalation.dto.ts / ticket.dto.ts). The safe representation crosses the HTTP
 * boundary; the Mongoose document never does.
 *
 * Exposure law: the DTO carries the content-safe title/body, the event type,
 * entity references and read state. It never carries: the event key
 * (idempotency internals), preference rows of other users, delivery ledger
 * data, recipient ids other than implicit "mine", or any message/note content
 * (there is none in the collection).
 */
export interface NotificationDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string;
  readonly entityType: NotificationEntityType;
  readonly entityId: string;
  /** null = unread. */
  readonly readAt: string | null;
  readonly createdAt: string;
}

export function toNotificationDto(document: NotificationDocument): NotificationDto {
  return {
    id: document._id.toHexString(),
    workspaceId: document.workspaceId.toHexString(),
    type: document.type,
    title: document.title,
    body: document.body,
    entityType: document.entityType,
    entityId: document.entityId.toHexString(),
    readAt: document.readAt === null ? null : document.readAt.toISOString(),
    createdAt: document.createdAt.toISOString(),
  };
}

export interface NotificationListPayload {
  readonly items: NotificationDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface NotificationUnreadCountPayload {
  readonly unreadCount: number;
}

export interface NotificationReadPayload {
  readonly notification: NotificationDto;
}

export interface NotificationReadAllPayload {
  /** Number of notifications that transitioned to read in this call. */
  readonly markedRead: number;
}

/** Preferences read model — defaults resolved, timestamps for optimistic UIs. */
export interface NotificationPreferencesDto extends NotificationPreferenceValues {
  readonly workspaceId: string;
  readonly userId: string;
  /** Null for a user who has never stored preferences (defaults applied). */
  readonly updatedAt: string | null;
}

export interface NotificationPreferencesPayload {
  readonly preferences: NotificationPreferencesDto;
}
