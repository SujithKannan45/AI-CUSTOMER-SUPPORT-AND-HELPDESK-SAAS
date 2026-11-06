import { EventEmitter } from 'node:events';

import { logger } from '../../core/logger/logger.js';

import type { TicketPriority, TicketStatus } from './ticket.types.js';

/**
 * Ticket event seam (Prompt 16) — the typed publication boundary the
 * notification module subscribes to. It mirrors `escalation.events.ts`
 * exactly: a module-local EventEmitter, no transport, no queue, NO delivery
 * guarantee.
 *
 * Laws:
 * - Publish ONLY after the write succeeded (services call this after the
 *   repository returned the updated document). A failed write never emits.
 * - `eventKey` is derived from PERSISTED facts (`<ticketId>:<kind>:<updatedAtMs>`),
 *   so a duplicated or retried publication carries the SAME key and the
 *   notification/email idempotency indexes collapse it. It is never random.
 * - Publication is fire-safe: a subscriber (notification dispatcher, tests,
 *   future socket bridge) cannot break the ticket operation it observes.
 *
 * The event carries the bounded, staff-visible facts needed to compose a
 * notification (number, subject, status, priority) — never a message body,
 * internal note or AI content.
 */

interface TicketEventBase {
  readonly workspaceId: string;
  readonly ticketId: string;
  /** Human-readable ticket number (e.g. TCK-1042). */
  readonly ticketNumber: string;
  /** Ticket subject — staff-visible, length-bounded upstream. */
  readonly subject: string;
  /** Who performed the action (never notified about their own action). */
  readonly actorId: string;
  /** Ticket assignee AFTER the action (null = unassigned). */
  readonly assigneeId: string | null;
  /** Ticket creator — included so audience resolution needs no extra read. */
  readonly createdById: string;
  /** Stable per-event key (see module docs). */
  readonly eventKey: string;
}

export interface TicketCreatedEvent extends TicketEventBase {
  readonly type: 'ticket.created';
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
}

export interface TicketAssignmentEvent extends TicketEventBase {
  readonly type: 'ticket.assigned' | 'ticket.reassigned' | 'ticket.unassigned';
  readonly previousAssigneeId: string | null;
}

export interface TicketStatusEvent extends TicketEventBase {
  readonly type: 'ticket.status_changed';
  readonly from: TicketStatus;
  readonly to: TicketStatus;
}

export interface TicketPriorityEvent extends TicketEventBase {
  readonly type: 'ticket.priority_changed';
  readonly from: TicketPriority;
  readonly to: TicketPriority;
}

export type TicketEvent =
  | TicketCreatedEvent
  | TicketAssignmentEvent
  | TicketStatusEvent
  | TicketPriorityEvent;

/** In-process bus for LOCAL subscribers (notification dispatcher, drivers). */
export const ticketEventBus = new EventEmitter();
ticketEventBus.setMaxListeners(50);

/** Test seam — drops every listener between driver runs. */
export function resetTicketEventsForTests(): void {
  ticketEventBus.removeAllListeners();
}

/**
 * Builds the stable event key from persisted facts. Callers pass the document's
 * `updatedAt` (or `createdAt` for creation) so the same persisted state always
 * yields the same key.
 */
export function ticketEventKey(ticketId: string, kind: string, at: Date): string {
  return `${ticketId}:${kind}:${at.getTime()}`;
}

/** Fire-safe publication — never throws into the caller's business flow. */
export function publishTicketEvent(event: TicketEvent): void {
  try {
    ticketEventBus.emit('ticket', event);
  } catch (error: unknown) {
    logger.warn({ err: error, type: event.type }, 'ticket event subscriber failed');
  }
}
