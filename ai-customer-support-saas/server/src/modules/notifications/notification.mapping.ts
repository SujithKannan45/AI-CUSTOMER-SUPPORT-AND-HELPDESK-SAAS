import { Types } from 'mongoose';

import { env } from '../../config/env.config.js';
import type { ConversationMessageCreatedEvent } from '../conversations/conversation.events.js';
import type { EscalationEvent } from '../escalations/escalation.events.js';
import { findEscalationInWorkspace } from '../escalations/escalation.repository.js';
import { roleHasPermission, type WorkspacePermission } from '../rbac/rbac.permissions.js';
import type { TicketEvent } from '../tickets/ticket.events.js';
import { findTicketInWorkspace } from '../tickets/ticket.repository.js';
import type { TicketPriority, TicketStatus } from '../tickets/ticket.types.js';
import { listActiveWorkspaceMembers } from '../workspaces/workspace.repository.js';

import type { NotificationEntityType, NotificationType } from './notification.types.js';

/**
 * The ONE event → notification mapping (Prompt 16 §4).
 *
 * Everything about "who hears about what, and what does it say" lives here.
 * Business modules publish typed facts; this module decides:
 *
 * - RECIPIENTS: the affected staff (assignee, creator, queue desk), resolved
 *   from the event's ids and one workspace-scoped member read. The acting user
 *   is excluded (nobody needs a notification for their own click), duplicates
 *   are collapsed, and queue fan-out is capped by NOTIFICATION_MAX_RECIPIENTS
 *   in a deterministic order.
 * - CONTENT: title/body are composed from machine facts (number, status,
 *   priority, trigger type). Conversation bodies, internal notes, AI prompts,
 *   retrieved passages, resolution notes and cancel reasons are never read —
 *   not filtered, simply never touched.
 * - TYPE: the notification vocabulary (and therefore the email template key).
 *
 * Unmapped events return `null`: unassigned tickets and INTERNAL notes are real
 * events with no notification by design.
 */

export interface MappedNotification {
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string;
  readonly entityType: NotificationEntityType;
  readonly entityId: Types.ObjectId;
  readonly recipients: readonly Types.ObjectId[];
  /** Stable per-event key — the duplicate-prevention/idempotency input. */
  readonly eventKey: string;
}

const TITLE_MAX = 200;
const BODY_MAX = 500;

const STATUS_LABELS: Readonly<Record<TicketStatus, string>> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  WAITING_FOR_CUSTOMER: 'Waiting for customer',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

const PRIORITY_LABELS: Readonly<Record<TicketPriority, string>> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

const TRIGGER_LABELS: Readonly<Record<string, string>> = {
  AI_INSUFFICIENT_KNOWLEDGE: 'the AI could not ground an answer',
  HUMAN_REQUEST: 'a human was requested',
  SENSITIVE_TOPIC: 'a sensitive topic was detected',
  AI_REPEATED_FAILURE: 'repeated AI failures',
  TECHNICAL_FAILURE: 'an AI technical failure',
  MANUAL: 'manual staff escalation',
};

/**
 * Escalation events do not carry a version, so the PERSISTED document state is
 * the identity: re-emitting an event for the same document state collapses to
 * one notification, while a later transition (new `updatedAt`) is a new event.
 */
function escalationKey(type: string, escalationId: string, updatedAt: Date): string {
  return `${escalationId}:${type}:${updatedAt.getTime()}`;
}

function bounded(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Collapses candidate ids into a deterministic, actor-free recipient list.
 * Invalid/absent ids are dropped; a recipient never learns about their own
 * action.
 */
function audience(candidates: readonly (string | null | undefined)[], actorId: string | null): Types.ObjectId[] {
  const seen = new Set<string>();
  const result: Types.ObjectId[] = [];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    if (actorId !== null && candidate === actorId) continue;
    if (!/^[0-9a-fA-F]{24}$/.test(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(new Types.ObjectId(candidate));
  }
  return result;
}

/**
 * Workspace desk members holding a permission — the queue audience for
 * unassigned work. Deterministic (sorted) and capped so one event cannot fan
 * out to an unbounded member list.
 */
async function deskRecipients(
  workspaceId: string,
  permission: WorkspacePermission,
  actorId: string | null,
): Promise<Types.ObjectId[]> {
  const members = await listActiveWorkspaceMembers(new Types.ObjectId(workspaceId));
  const eligible = members
    .filter((member) => roleHasPermission(member.role, permission))
    .map((member) => member.userId.toHexString())
    .sort((left, right) => left.localeCompare(right));
  return audience(eligible.slice(0, env.NOTIFICATION_MAX_RECIPIENTS), actorId);
}

// ── Ticket events ────────────────────────────────────────────────────────────

export async function mapTicketEvent(event: TicketEvent): Promise<MappedNotification | null> {
  const entity = { entityType: 'ticket' as const, entityId: new Types.ObjectId(event.ticketId) };
  const ticketLabel = event.ticketNumber.length > 0 ? event.ticketNumber : 'ticket';

  switch (event.type) {
    case 'ticket.created': {
      const recipients =
        event.assigneeId !== null
          ? audience([event.assigneeId], event.actorId)
          : await deskRecipients(event.workspaceId, 'ticket.assign', event.actorId);
      if (recipients.length === 0) return null;
      return {
        type: 'ticket.created',
        eventKey: event.eventKey,
        title: bounded(`New ticket ${ticketLabel}: ${event.subject}`, TITLE_MAX),
        body: bounded(
          `Status ${STATUS_LABELS[event.status]} · Priority ${PRIORITY_LABELS[event.priority]}`,
          BODY_MAX,
        ),
        ...entity,
        recipients,
      };
    }
    case 'ticket.assigned':
    case 'ticket.reassigned': {
      const recipients =
        event.assigneeId === null ? [] : audience([event.assigneeId], event.actorId);
      if (recipients.length === 0) return null;
      return {
        type: event.type,
        eventKey: event.eventKey,
        title: bounded(
          `${event.type === 'ticket.assigned' ? 'You were assigned' : 'Ticket reassigned to you'} ${ticketLabel}`,
          TITLE_MAX,
        ),
        body: bounded(event.subject, BODY_MAX),
        ...entity,
        recipients,
      };
    }
    case 'ticket.status_changed': {
      const recipients = audience([event.assigneeId, event.createdById], event.actorId);
      if (recipients.length === 0) return null;
      return {
        type: 'ticket.status_changed',
        eventKey: event.eventKey,
        title: bounded(`${ticketLabel} is now ${STATUS_LABELS[event.to]}`, TITLE_MAX),
        body: bounded(`Was ${STATUS_LABELS[event.from]} · ${event.subject}`, BODY_MAX),
        ...entity,
        recipients,
      };
    }
    case 'ticket.priority_changed': {
      const recipients = audience([event.assigneeId, event.createdById], event.actorId);
      if (recipients.length === 0) return null;
      return {
        type: 'ticket.priority_changed',
        eventKey: event.eventKey,
        title: bounded(`${ticketLabel} priority is now ${PRIORITY_LABELS[event.to]}`, TITLE_MAX),
        body: bounded(`Was ${PRIORITY_LABELS[event.from]} · ${event.subject}`, BODY_MAX),
        ...entity,
        recipients,
      };
    }
    case 'ticket.unassigned':
      // Returning a ticket to triage informs nobody: the queue is a view.
      return null;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

// ── Conversation events ──────────────────────────────────────────────────────

export function mapConversationEvent(event: ConversationMessageCreatedEvent): MappedNotification | null {
  // INTERNAL staff notes are never customer-facing and never notified.
  if (event.visibility !== 'PUBLIC') return null;

  const ticketLabel = event.ticketNumber.length > 0 ? event.ticketNumber : 'ticket';
  const recipients = audience(
    [event.ticketAssigneeId, event.ticketCreatedById],
    event.senderId,
  );
  if (recipients.length === 0) return null;

  return {
    type: 'conversation.public_message',
    eventKey: event.eventKey,
    title: bounded(`New reply on ${ticketLabel}`, TITLE_MAX),
    body: bounded(`Ticket ${ticketLabel}: ${event.ticketSubject}`, BODY_MAX),
    entityType: 'conversation',
    entityId: new Types.ObjectId(event.conversationId),
    recipients,
  };
}

// ── Escalation events ────────────────────────────────────────────────────────

/**
 * Escalation mapping loads the escalation (workspace-scoped) plus its ticket so
 * titles carry the human ticket number. A vanished record returns `null` — a
 * notification about a deleted handoff would be a dead link.
 */
export async function mapEscalationEvent(event: EscalationEvent): Promise<MappedNotification | null> {
  const workspaceId = new Types.ObjectId(event.workspaceId);
  const escalation = await findEscalationInWorkspace(
    workspaceId,
    new Types.ObjectId(event.escalationId),
  );
  if (escalation === null) return null;

  const ticket = await findTicketInWorkspace(workspaceId, escalation.ticketId);
  const ticketLabel = ticket?.number ?? 'ticket';
  const priorityLabel = PRIORITY_LABELS[escalation.priority];
  const entity = {
    entityType: 'escalation' as const,
    entityId: escalation._id,
  };

  switch (event.type) {
    case 'escalation.created': {
      const recipients = await deskRecipients(
        event.workspaceId,
        'escalation.manage',
        event.actorId,
      );
      if (recipients.length === 0) return null;

      const aiInitiated = escalation.initiatedBy.actorType === 'AI_AGENT';
      const technical = escalation.triggerType === 'TECHNICAL_FAILURE';
      const type: NotificationType = aiInitiated
        ? technical
          ? 'ai.failure'
          : 'ai.handoff'
        : 'escalation.created';
      const headline = technical
        ? `AI needs attention: ${ticketLabel}`
        : aiInitiated
          ? `AI handed off ${ticketLabel}`
          : `New escalation: ${ticketLabel}`;

      return {
        type,
        // Escalation events intentionally carry no key of their own: the
        // persisted version is the stable identity of this state transition.
        eventKey: escalationKey(event.type, escalation._id.toHexString(), escalation.updatedAt),
        title: bounded(headline, TITLE_MAX),
        body: bounded(
          `Priority ${priorityLabel} · ${TRIGGER_LABELS[escalation.triggerType] ?? 'escalation created'}`,
          BODY_MAX,
        ),
        ...entity,
        recipients,
      };
    }
    case 'escalation.assigned':
    case 'escalation.reassigned': {
      const recipients = audience([event.assigneeId], event.actorId);
      if (recipients.length === 0) return null;
      return {
        type: event.type,
        eventKey: escalationKey(event.type, escalation._id.toHexString(), escalation.updatedAt),
        title: bounded(
          `${event.type === 'escalation.assigned' ? 'You were assigned' : 'Escalation reassigned to you'}: ${ticketLabel}`,
          TITLE_MAX,
        ),
        body: bounded(`Priority ${priorityLabel}`, BODY_MAX),
        ...entity,
        recipients,
      };
    }
    case 'escalation.accepted': {
      // The PREVIOUS assignee learns the work was claimed; the accepter already knows.
      const previousAssignee =
        escalation.eligibleAssigneeId?.equals(new Types.ObjectId(event.acceptedById)) === true
          ? null
          : escalation.eligibleAssigneeId?.toHexString() ?? null;
      const recipients = audience([previousAssignee], event.actorId);
      if (recipients.length === 0) return null;
      return {
        type: 'escalation.accepted',
        eventKey: escalationKey(event.type, escalation._id.toHexString(), escalation.updatedAt),
        title: bounded(`Escalation accepted: ${ticketLabel}`, TITLE_MAX),
        body: bounded(`Priority ${priorityLabel}`, BODY_MAX),
        ...entity,
        recipients,
      };
    }
    case 'escalation.resolved': {
      const recipients = audience(
        [
          escalation.eligibleAssigneeId?.toHexString() ?? null,
          escalation.acceptedById?.toHexString() ?? null,
          escalation.initiatedBy.actorId?.toHexString() ?? null,
        ],
        event.actorId,
      );
      if (recipients.length === 0) return null;
      return {
        type: 'escalation.resolved',
        eventKey: escalationKey(event.type, escalation._id.toHexString(), escalation.updatedAt),
        title: bounded(`Escalation resolved: ${ticketLabel}`, TITLE_MAX),
        body: bounded(`Priority ${priorityLabel}`, BODY_MAX),
        ...entity,
        recipients,
      };
    }
    case 'escalation.cancelled': {
      const recipients = audience(
        [
          escalation.eligibleAssigneeId?.toHexString() ?? null,
          escalation.acceptedById?.toHexString() ?? null,
          escalation.initiatedBy.actorId?.toHexString() ?? null,
        ],
        event.actorId,
      );
      if (recipients.length === 0) return null;
      return {
        type: 'escalation.cancelled',
        eventKey: escalationKey(event.type, escalation._id.toHexString(), escalation.updatedAt),
        title: bounded(`Escalation cancelled: ${ticketLabel}`, TITLE_MAX),
        body: bounded(`Priority ${priorityLabel}`, BODY_MAX),
        ...entity,
        recipients,
      };
    }
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
