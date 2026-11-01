import { EventEmitter } from 'node:events';

import { logger } from '../../core/logger/logger.js';

/**
 * Escalation event seam (Prompt 15 §9) — a typed publication boundary for
 * the lifecycle events future notification (Prompt 16) and frontend prompts
 * consume. It is deliberately NOT a real-time server and claims NO delivery
 * guarantees.
 *
 * Honest integration status: Prompt 10's Socket.IO layer exists in this
 * repository only as a design contract (`server/src/sockets/README.md` —
 * "prepared, not yet implemented"); there is no socket Server to publish to
 * yet. Rather than fabricate infrastructure, this seam:
 *
 * - types every event (a compile-time contract the future socket layer and
 *   the notification module code against);
 * - persists state changes FIRST and publishes only AFTER a successful
 *   persistence (the service never publishes on failed writes);
 * - publishes through a pluggable transport (`setEscalationEventTransport`),
 *   defaulting to a logged no-op that never throws — socket/notification
 *   wiring becomes transport registration, not a service rewrite;
 * - never lets a transport failure leak into the REST operation: publish is
 *   fire-safe by construction, so a transport error can never make a
 *   successfully persisted REST operation appear failed.
 *
 * Durability law: the audit trail + the escalation document ARE the durable
 * record. This seam is best-effort fan-out only — no durable queue, no
 * exactly-once delivery, no Redis dependency.
 */

export interface EscalationCreatedEvent {
  readonly type: 'escalation.created';
  readonly workspaceId: string;
  readonly escalationId: string;
  readonly conversationId: string;
  readonly ticketId: string;
  readonly triggerType: string;
  readonly priority: string;
}

export interface EscalationAssignedEvent {
  readonly type: 'escalation.assigned' | 'escalation.reassigned';
  readonly workspaceId: string;
  readonly escalationId: string;
  readonly conversationId: string;
  readonly assigneeId: string;
}

export interface EscalationAcceptedEvent {
  readonly type: 'escalation.accepted';
  readonly workspaceId: string;
  readonly escalationId: string;
  readonly conversationId: string;
  readonly acceptedById: string;
}

export interface EscalationConcludedEvent {
  readonly type: 'escalation.resolved' | 'escalation.cancelled';
  readonly workspaceId: string;
  readonly escalationId: string;
  readonly conversationId: string;
}

export type EscalationEvent =
  | EscalationCreatedEvent
  | EscalationAssignedEvent
  | EscalationAcceptedEvent
  | EscalationConcludedEvent;

/**
 * Transport contract for the future real-time layer: receives a fully
 * validated event AFTER its persistence succeeded, and decides its own
 * delivery (workspace-scoped rooms, membership checks — per the sockets
 * README's tenancy laws). Transports must be synchronous-or-void and
 * internally resilient; fans-out failures are their responsibility.
 */
export type EscalationEventTransport = (event: EscalationEvent) => void;

/** In-process bus for LOCAL subscribers (tests, dev tooling) — not a queue. */
export const escalationEventBus = new EventEmitter();
escalationEventBus.setMaxListeners(50);

let transport: EscalationEventTransport | null = null;

/** Registers (or replaces) the fan-out transport; `null` removes it. */
export function setEscalationEventTransport(next: EscalationEventTransport | null): void {
  transport = next;
}

/** Test seam — resets transport AND local bus listeners between drivers. */
export function resetEscalationEventsForTests(): void {
  transport = null;
  escalationEventBus.removeAllListeners();
}

/**
 * Fire-safe publish — invoked by the service ONLY after persistence
 * succeeded. Every failure is logged and swallowed: a consumer's absence
 * must never break the escalation itself, and the durable record lives in
 * the audit trail regardless.
 */
export function publishEscalationEvent(event: EscalationEvent): void {
  try {
    escalationEventBus.emit('escalation', event);
    if (transport !== null) {
      transport(event);
    } else if (process.env['NODE_ENV'] !== 'test') {
      logger.debug(
        { type: event.type, escalationId: event.escalationId, workspaceId: event.workspaceId },
        'escalation event published (no transport registered — audit trail is the durable record)',
      );
    }
  } catch (error: unknown) {
    // A transport that throws is its own bug: never propagates into the
    // REST flow (named in escalation.service.ts as the partial-failure law).
    logger.warn({ err: error, type: event.type }, 'escalation event transport failed');
  }
}
