import { Schema, model, type Model } from 'mongoose';

import { TICKET_PRIORITY_RANKS, TICKET_PRIORITIES, type TicketPriority } from '../tickets/ticket.types.js';

import {
  ACTIVE_ESCALATION_STATUSES,
  ESCALATION_HISTORY_ACTIONS,
  ESCALATION_INITIATORS,
  ESCALATION_STATUSES,
  ESCALATION_TRIGGER_TYPES,
  type EscalationDocument,
  type EscalationHistoryEntry,
  type EscalationInitiator,
  type EscalationStatus,
  type EscalationTriggerType,
} from './escalation.types.js';

/**
 * One bounded lifecycle story per escalation — both the array cap and the
 * newest-entry detail length live here so every writer inherits them.
 */
export const MAX_ESCALATION_HISTORY_ENTRIES = 25;
const MAX_HISTORY_DETAIL_CHARS = 200;

function trimHistory(entries: EscalationHistoryEntry[]): EscalationHistoryEntry[] {
  if (entries.length <= MAX_ESCALATION_HISTORY_ENTRIES) return entries;
  return [...entries.slice(entries.length - MAX_ESCALATION_HISTORY_ENTRIES)];
}

/**
 * Escalation persistence — the collection-level laws:
 *
 * - `{ workspaceId, conversationId }` PARTIAL-UNIQUE over ACTIVE statuses —
 *   AT MOST ONE ACTIVE escalation per conversation. This is the
 *   duplicate-prevention LAW (not just a service convention): concurrent
 *   triggers lose safely against the index and the service re-uses the
 *   winner (race-safe create, same pattern as conversations). Docs are
 *   partial so RESOLVED/CANCELLED rows never block a later escalation of
 *   the same conversation after its first handoff concluded.
 * - `{ workspaceId, status, priorityRank, createdAt: -1 }` — the escalation
 *   queue read: filter by status, order by urgency then age (priorityRank
 *   derived for the same alphabetical-sort reason as tickets).
 * - `{ workspaceId, assignedToId, updatedAt: -1 }` — "my assignment" reads.
 * - `{ workspaceId, ticketId, createdAt: -1 }` — everything escalated about
 *   a ticket.
 * - `{ workspaceId, createdAt: -1 }` — workspace activity fallback sorts.
 */
const escalationSchema = new Schema<EscalationDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: [true, 'Conversation reference is required'],
    },
    /** Copied from the verified conversation — never written by clients. */
    ticketId: {
      type: Schema.Types.ObjectId,
      ref: 'Ticket',
      required: [true, 'Ticket reference is required'],
    },
    /** Copied from the verified conversation — never written by clients. */
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'Customer',
      required: [true, 'Customer reference is required'],
    },
    triggerType: {
      type: String,
      enum: ESCALATION_TRIGGER_TYPES,
      required: true,
    },
    reasonCode: {
      type: String,
      required: [true, 'Escalation reason code is required'],
      trim: true,
      maxlength: 64,
      // Same machine-vocabulary constraint as audit actions.
      match: [/^[a-z_][a-z0-9._-]*$/i, 'Reason code must be a machine-safe identifier'],
    },
    topicKey: {
      type: String,
      trim: true,
      maxlength: 64,
      default: null,
      match: [/^[a-z][a-z0-9._-]*$/i, 'Topic key must be a machine-safe identifier'],
    },
    priority: {
      type: String,
      enum: [...TICKET_PRIORITIES],
      default: 'MEDIUM',
      required: true,
    },
    /** Derived sort weight (1 LOW … 4 URGENT) — same rake as ticket.priorityRank. */
    priorityRank: {
      type: Number,
      required: true,
      min: 1,
      max: 4,
    },
    status: {
      type: String,
      enum: ESCALATION_STATUSES,
      default: 'PENDING',
      required: true,
    },
    eligibleAssigneeId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    acceptedById: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    resolvedById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, trim: true, maxlength: 2_000, default: null },
    cancelledById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, trim: true, maxlength: 500, default: null },
    initiatedBy: {
      actorType: {
        type: String,
        enum: ESCALATION_INITIATORS,
        required: true,
      },
      actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    },
    history: {
      type: [
        {
          action: { type: String, enum: ESCALATION_HISTORY_ACTIONS, required: true },
          at: { type: Date, required: true },
          actorType: { type: String, enum: ESCALATION_INITIATORS, required: true },
          actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          detail: { type: String, maxlength: MAX_HISTORY_DETAIL_CHARS },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

/** History cap hook: every save keeps at most the newest N entries. */
escalationSchema.pre('validate', function capEscalationHistory(): void {
  const history = this.get('history') as EscalationHistoryEntry[] | undefined;
  if (Array.isArray(history)) {
    this.set('history', trimHistory(history));
  }
});

/**
 * Keeps `priorityRank` glued to `priority` (mirror of the ticket model hook;
 * fires on saves and `findOneAndUpdate` updates).
 */
escalationSchema.pre('validate', function syncPriorityRank(): void {
  const priority = this.get('priority') as TicketPriority | undefined;
  if (priority !== undefined && priority !== null) {
    this.set('priorityRank', TICKET_PRIORITY_RANKS[priority]);
  }
});
escalationSchema.pre('findOneAndUpdate', function syncPriorityRankOnUpdate(): void {
  const update = this.getUpdate() as Record<string, unknown> | null | undefined;
  if (update === null || update === undefined) return;
  const priority = (update['$set'] as Record<string, unknown> | undefined)?.['priority'] ?? update['priority'];
  if (typeof priority === 'string') {
    this.set({ priorityRank: TICKET_PRIORITY_RANKS[priority as TicketPriority] });
  }
});

escalationSchema.index(
  { workspaceId: 1, conversationId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: [...ACTIVE_ESCALATION_STATUSES] } },
    name: 'uniq_active_escalation_per_conversation',
  },
);
escalationSchema.index(
  { workspaceId: 1, status: 1, priorityRank: -1, createdAt: -1 },
  { name: 'idx_escalations_queue' },
);
escalationSchema.index(
  { workspaceId: 1, eligibleAssigneeId: 1, updatedAt: -1 },
  { name: 'idx_escalations_by_assignee' },
);
escalationSchema.index(
  { workspaceId: 1, ticketId: 1, createdAt: -1 },
  { name: 'idx_escalations_by_ticket' },
);
// Prompt 17 added a customer reference filter to the queue listing; the
// workspace-leading compound keeps that scan inside one tenant slice and
// ordered by the default newest-first sort.
escalationSchema.index(
  { workspaceId: 1, customerId: 1, createdAt: -1 },
  { name: 'idx_escalations_by_customer' },
);
escalationSchema.index({ workspaceId: 1, createdAt: -1 }, { name: 'idx_escalations_by_created' });

export const EscalationModel = model<EscalationDocument, Model<EscalationDocument>>(
  'Escalation',
  escalationSchema,
  'escalations',
);

/**
 * True when the error is a duplicate-key on the ACTIVE escalation scope
 * specifically (index `uniq_active_escalation_per_conversation`). Any other
 * duplicate key is a programming error and is rethrown untouched.
 */
export function isDuplicateActiveEscalationError(error: unknown): boolean {
  const candidate = error as { code?: unknown; keyValue?: Record<string, unknown> } | null;
  if (candidate === null || typeof candidate !== 'object') return false;
  if (candidate['code'] !== 11000) return false;
  return (
    candidate['keyValue']?.['workspaceId'] !== undefined &&
    candidate['keyValue']?.['conversationId'] !== undefined
  );
}

/** Narrow type exports for documents loaded with `.lean()` in drivers. */
export type EscalationStatusNames = EscalationStatus;
export type EscalationTriggerNames = EscalationTriggerType;
export type EscalationInitiatorNames = EscalationInitiator;
