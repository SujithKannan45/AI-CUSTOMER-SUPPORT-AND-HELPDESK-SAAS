import { logger } from '../../core/logger/logger.js';

import type { NotificationDocument } from './notification.types.js';

/**
 * Real-time publication seam (Prompt 16 §9).
 *
 * Honest status: Prompt 10's Socket.IO layer exists in this repository as a
 * design contract only (`server/src/sockets/README.md` — "prepared, not yet
 * implemented"); there is no socket Server to publish to, so no live
 * real-time notification delivery is claimed anywhere.
 *
 * What this seam guarantees instead:
 * - publication happens ONLY after the notification row persisted (the
 *   dispatcher calls it on `created: true`);
 * - publication is FIRE-SAFE: a transport failure can never make a persisted
 *   notification — or the business operation that caused it — look failed;
 * - the publisher receives the notification document, which carries exactly
 *   the recipient id the future socket layer must authorize against
 *   (`workspace:{workspaceId}` room + `userId` match, per the sockets README);
 * - no internal metadata (no preferences, no delivery ledger, no audit) is
 *   handed to the transport.
 *
 * Connecting real time later is transport registration, not a service rewrite.
 */

export interface NotificationPublisher {
  /** Fan-out for ONE persisted notification. Must not throw; must not block. */
  publish(notification: NotificationDocument): void;
}

let publisher: NotificationPublisher | null = null;

/** Registers (or replaces) the publisher; `null` removes it. */
export function setNotificationPublisher(next: NotificationPublisher | null): void {
  publisher = next;
}

/** Fire-safe publication — logs and swallows every failure. */
export function publishNotification(notification: NotificationDocument): void {
  if (publisher === null) return;
  try {
    publisher.publish(notification);
  } catch (error: unknown) {
    logger.warn(
      { err: error, notificationId: notification._id.toHexString() },
      'notification publisher failed — the persisted notification remains the source of truth',
    );
  }
}
