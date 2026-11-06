import { EventEmitter } from 'node:events';

import { logger } from '../../core/logger/logger.js';

import type { MessageSenderType, MessageVisibility } from './conversation.types.js';

/**
 * Conversation event seam (Prompt 16) — same laws as ticket.events.ts:
 * module-local bus, publish AFTER persistence, stable `eventKey`, fire-safe,
 * no queue and no delivery guarantee.
 *
 * Content law: the event carries ids, sender type and visibility — NEVER the
 * message body. Notification previews therefore cannot leak message content
 * even if a future consumer forgets to filter; there is nothing to leak.
 */

export interface ConversationMessageCreatedEvent {
  readonly type: 'conversation.message_created';
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly ticketSubject: string;
  /** Ticket assignee (audience) — null when the ticket is in triage. */
  readonly ticketAssigneeId: string | null;
  /** Ticket creator (audience) — included so no extra read is needed. */
  readonly ticketCreatedById: string;
  /** Sender — never notified about their own message. */
  readonly senderId: string;
  readonly senderType: MessageSenderType;
  /**
   * INTERNAL notes are published too (the seam is the full truth of what
   * happened) — the notification mapping ignores them by law. Customer-facing
   * identity does not exist yet, so `CUSTOMER` cannot be produced today.
   */
  readonly visibility: MessageVisibility;
  /** Stable per-event key: `<messageId>:created`. */
  readonly eventKey: string;
}

export type ConversationEvent = ConversationMessageCreatedEvent;

export const conversationEventBus = new EventEmitter();
conversationEventBus.setMaxListeners(50);

export function resetConversationEventsForTests(): void {
  conversationEventBus.removeAllListeners();
}

export function conversationMessageEventKey(messageId: string): string {
  return `${messageId}:created`;
}

export function publishConversationEvent(event: ConversationEvent): void {
  try {
    conversationEventBus.emit('conversation', event);
  } catch (error: unknown) {
    logger.warn({ err: error, type: event.type }, 'conversation event subscriber failed');
  }
}
