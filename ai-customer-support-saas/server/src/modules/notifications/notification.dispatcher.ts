import { Types } from 'mongoose';

import { logger } from '../../core/logger/logger.js';
import {
  conversationEventBus,
  type ConversationEvent,
} from '../conversations/conversation.events.js';
import { escalationEventBus, type EscalationEvent } from '../escalations/escalation.events.js';
import { ticketEventBus, type TicketEvent } from '../tickets/ticket.events.js';

import { deliverNotificationEmail } from './email/email-delivery.service.js';
import { getOrCreateNotificationPreferences } from './notification-preference.repository.js';
import {
  mapConversationEvent,
  mapEscalationEvent,
  mapTicketEvent,
  type MappedNotification,
} from './notification.mapping.js';
import { decideChannels, resolvePreferenceValues } from './notification.preferences.js';
import { publishNotification } from './notification.publisher.js';
import { createNotificationIfAbsent } from './notification.repository.js';
import type { NotificationDocument } from './notification.types.js';

/**
 * Notification dispatcher — the composition point between domain events and
 * the notification/email services.
 *
 * Execution model (honest):
 * - Listeners are SYNCHRONOUS and return immediately; the work is scheduled as
 *   a tracked in-process promise. Domain publishers therefore never wait on
 *   notifications and never fail because of them.
 * - There is NO queue and NO worker: a process restart loses in-flight
 *   dispatch. The durable record is the domain entity (ticket/escalation/message)
 *   and the audit trail — exactly the same honesty as the escalation seam.
 *   Duplicates are handled by the unique indexes, so a future
 *   outbox/queue can replay events without double-notifying.
 * - `awaitNotificationDispatchIdle()` gives drivers (and a graceful-shutdown
 *   hook) a way to wait for the in-flight set; production code must not depend
 *   on it for correctness.
 */

/** In-flight dispatches — used ONLY for draining in tests/shutdown. */
const inflight = new Set<Promise<void>>();
let registered = false;

function track(work: Promise<void>): void {
  inflight.add(work);
  void work.finally(() => inflight.delete(work));
}

function schedule(kind: string, work: () => Promise<void>): void {
  track(
    work().catch((error: unknown) => {
      // Never throws further: a notification failure is not a business failure.
      logger.error({ err: error, kind }, 'notification dispatch failed');
    }),
  );
}

async function dispatchMapped(
  workspaceId: string,
  mapped: MappedNotification,
): Promise<void> {
  const workspaceObjectId = new Types.ObjectId(workspaceId);

  for (const recipientId of mapped.recipients) {
    try {
      const preferenceDocument = await getOrCreateNotificationPreferences(
        workspaceObjectId,
        recipientId,
      );
      const channels = decideChannels(mapped.type, resolvePreferenceValues(preferenceDocument));
      if (!channels.inApp && !channels.email) continue;

      let notification: NotificationDocument | null = null;
      if (channels.inApp) {
        const outcome = await createNotificationIfAbsent(
          {
            recipientId,
            type: mapped.type,
            title: mapped.title,
            body: mapped.body,
            entityType: mapped.entityType,
            entityId: mapped.entityId,
            eventKey: mapped.eventKey,
          },
          workspaceObjectId,
        );
        if (outcome !== null && outcome.created) {
          notification = outcome.notification;
          // Persisted first, published second (fire-safe, no delivery claim).
          publishNotification(outcome.notification);
        }
      }

      if (channels.email) {
        await deliverNotificationEmail({
          workspaceId: workspaceObjectId,
          recipientId,
          notificationId: notification?._id ?? null,
          type: mapped.type,
          eventKey: mapped.eventKey,
          title: mapped.title,
          body: mapped.body,
        });
      }
    } catch (error: unknown) {
      // One recipient's failure must not starve the rest of the fan-out.
      logger.error(
        { err: error, recipientId: recipientId.toHexString(), type: mapped.type },
        'notification recipient dispatch failed',
      );
    }
  }
}

/**
 * Registers the event subscriptions. Idempotent — `createApp` may run several
 * times in one process (tests), and duplicate listeners would double-dispatch
 * (the unique index would collapse it, but the extra work is pointless).
 */
export function registerNotificationDispatcher(): void {
  if (registered) return;
  registered = true;

  ticketEventBus.on('ticket', (event: TicketEvent) => {
    schedule('ticket', async () => {
      const mapped = await mapTicketEvent(event);
      if (mapped === null) return;
      await dispatchMapped(event.workspaceId, mapped);
    });
  });

  conversationEventBus.on('conversation', (event: ConversationEvent) => {
    schedule('conversation', async () => {
      const mapped = mapConversationEvent(event);
      if (mapped === null) return;
      await dispatchMapped(event.workspaceId, mapped);
    });
  });

  escalationEventBus.on('escalation', (event: EscalationEvent) => {
    schedule('escalation', async () => {
      const mapped = await mapEscalationEvent(event);
      if (mapped === null) return;
      await dispatchMapped(event.workspaceId, mapped);
    });
  });
}

/** Awaits every in-flight dispatch (tests/shutdown only). */
export async function awaitNotificationDispatchIdle(): Promise<void> {
  // A dispatch may schedule further work while draining; loop until stable.
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight]);
  }
}

/** Test seam — detaches listeners and drains the in-flight set. */
export async function resetNotificationDispatcherForTests(): Promise<void> {
  ticketEventBus.removeAllListeners('ticket');
  conversationEventBus.removeAllListeners('conversation');
  escalationEventBus.removeAllListeners('escalation');
  registered = false;
  await awaitNotificationDispatchIdle();
}
