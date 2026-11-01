import type { Types } from 'mongoose';

import type { TenantScopedDocument } from '../../database/tenant.js';
import type { TicketPriority } from '../tickets/ticket.types.js';

/**
 * Escalation domain vocabulary (Prompt 15) — the domain contract; the service
 * is the lifecycle boundary. Same types/dto split as the other modules.
 *
 * Design center: an escalation is a WORKSPACE-SCOPED handoff record that
 * transfers a conversation (and its ticket) from AI handling to authorized
 * human staff. It never duplicates ticket/conversation state — it REFERENCES
 * them and reuses their lifecycle laws (ticket transitions stay governed by
 * `isValidTicketTransition`, which this module never bypasses).
 */

// ── Trigger taxonomy ─────────────────────────────────────────────────────────

/**
 * Who/what decided this escalation was needed. `AI_AGENT` triggers come from
 * Prompt 14's structured response contract (abstention reasons, measured
 * provider/retrieval failures); `STAFF` triggers are explicit authorized
 * actions. The trigger is a MACHINE FACT recorded at creation — the AI model
 * itself never decides authorization, assignment or priority.
 */
export const ESCALATION_INITIATORS = ['AI_AGENT', 'STAFF'] as const;
export type EscalationInitiator = (typeof ESCALATION_INITIATORS)[number];

export const ESCALATION_TRIGGER_TYPES = [
  /** AI abstained: retrieved knowledge insufficient/irrelevant (Prompt 14 reasons). */
  'AI_INSUFFICIENT_KNOWLEDGE',
  /** The requester explicitly asked for a human (keyword rule, configurable). */
  'HUMAN_REQUEST',
  /** Question matched a configured sensitive-topic keyword rule. */
  'SENSITIVE_TOPIC',
  /** Threshold of consecutive unsuccessful AI interactions in one conversation. */
  'AI_REPEATED_FAILURE',
  /** Provider/retrieval/timeout failure prevented useful assistance. */
  'TECHNICAL_FAILURE',
  /** Authorized staff escalated manually. */
  'MANUAL',
] as const;
export type EscalationTriggerType = (typeof ESCALATION_TRIGGER_TYPES)[number];

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Escalation lifecycle inside a workspace. Deliberately SEPARATE from the
 * ticket status enum: an escalation follows who-owns-the-handoff (queue →
 * assignee → work → done), not ticket progress.
 *
 *   PENDING   — created; sits in the unassigned queue
 *   ASSIGNED  — an eligible staff member holds it (not yet accepted)
 *   ACCEPTED  — the assignee took ownership; AI answers are paused
 *   RESOLVED  — terminal: the human handling concluded
 *   CANCELLED — terminal: escalation withdrawn (mistake, duplicate, etc.)
 */
export const ESCALATION_STATUSES = ['PENDING', 'ASSIGNED', 'ACCEPTED', 'RESOLVED', 'CANCELLED'] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

/** Statuses counted as "active" — exactly one active escalation may exist per conversation (partial unique index). */
export const ACTIVE_ESCALATION_STATUSES: readonly EscalationStatus[] = ['PENDING', 'ASSIGNED', 'ACCEPTED'];

/**
 * Allowed status transitions — the ONLY lifecycle law of this module. The
 * service validates every transition through `isValidEscalationTransition`;
 * invalid moves are 409 with the allowed targets in the error details.
 *
 *   PENDING   → ASSIGNED (staff assignment) | ACCEPTED (self-claim) | CANCELLED
 *   ASSIGNED  → ACCEPTED (assignee admits) | ASSIGNED (reassignment) | CANCELLED
 *   ACCEPTED  → RESOLVED | ASSIGNED (work reassigned) | CANCELLED
 *   RESOLVED  → terminal
 *   CANCELLED → terminal
 */
export const ESCALATION_STATUS_TRANSITIONS: Record<EscalationStatus, readonly EscalationStatus[]> = {
  PENDING: ['ASSIGNED', 'ACCEPTED', 'CANCELLED'],
  // ASSIGNED→ASSIGNED is the authorized REASSIGNMENT route (triage may move
  // an unaccepted record to a different staff member; the service enforces
  // that only a DIFFERENT assignee counts as a move — same-assignee is an
  // idempotent no-op there).
  ASSIGNED: ['ASSIGNED', 'ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['RESOLVED', 'CANCELLED', 'ASSIGNED'],
  RESOLVED: [],
  CANCELLED: [],
};

export function isValidEscalationTransition(from: EscalationStatus, to: EscalationStatus): boolean {
  return ESCALATION_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Escalation priority REUSES the ticket priority vocabulary (single source of
 * truth — no second enum to keep in sync). Like tickets, it carries a derived
 * rank for urgency sorting; see the escalation model for the derivation hook.
 */
export type EscalationPriority = TicketPriority;

// ── History ──────────────────────────────────────────────────────────────────

/**
 * Lifecycle history entry — inside the escalation document (bounded array;
 * the cap lives in the model). Actions mirror the audit taxonomy but the
 * history is the escalation's OWN is-the-queue-story (the audit trail remains
 * the immutable compliance record; both are written for every real change).
 */
export const ESCALATION_HISTORY_ACTIONS = [
  'escalation.created',
  'escalation.assigned',
  'escalation.reassigned',
  'escalation.accepted',
  'escalation.resolved',
  'escalation.cancelled',
] as const;
export type EscalationHistoryAction = (typeof ESCALATION_HISTORY_ACTIONS)[number];

/** One bounded history entry. `actorId` is a staff id for STAFF history; AI decisions have none. */
export interface EscalationHistoryEntry {
  readonly action: EscalationHistoryAction;
  readonly at: Date;
  readonly actorType: EscalationInitiator;
  readonly actorId: Types.ObjectId | null;
  /** Optional bounded detail (assignee/unassign reason codes) — never message content. */
  readonly detail?: string;
}

// ── Document shape ───────────────────────────────────────────────────────────

/**
 * Escalation — one handoff record for a conversation inside a workspace.
 *
 * Isolation law: every reference is workspace-scoped and validated
 * server-side; the repository composes `workspaceId` into every query, so
 * foreign ids read as not-found and no client field can influence scope.
 *
 * No conversation or ticket content is stored here: bodies, notes and
 * passages stay in their own collections; the record holds ids, machine
 * reasons and bounded lifecycle metadata only.
 */
export interface EscalationDocument extends TenantScopedDocument {
  /** The conversation being handed off; same-workspace by law. */
  conversationId: Types.ObjectId;
  /** Copied from the verified conversation at creation (the ticket to work). */
  ticketId: Types.ObjectId;
  /** Copied from the verified conversation at creation (bounded metadata). */
  customerId: Types.ObjectId;
  triggerType: EscalationTriggerType;
  /**
   * Machine reason code preserved from the trigger: Prompt 14 abstention
   * reason (e.g. `NO_KNOWLEDGE`), provider/retrieval error code (e.g.
   * `AGENT_AI_PROVIDER_FAILED`), matched sensitive-topic key, or
   * `MANUAL` for staff creations. Server-validated — never model output.
   */
  reasonCode: string;
  /** Matched sensitive-topic key when triggerType === SENSITIVE_TOPIC, else null. */
  topicKey: string | null;
  priority: EscalationPriority;
  priorityRank: number;
  status: EscalationStatus;
  eligibleAssigneeId: Types.ObjectId | null;
  acceptedById: Types.ObjectId | null;
  resolvedById: Types.ObjectId | null;
  resolvedAt: Date | null;
  /** Bounded summary of the human conclusion (plain text; capped in validation). */
  resolutionNote: string | null;
  cancelledById: Types.ObjectId | null;
  cancelledAt: Date | null;
  /** Bounded reason for a cancellation (plain text; capped in validation). */
  cancelReason: string | null;
  /** Who/what initiated the escalation (see ESCALATION_INITIATORS). */
  initiatedBy: {
    actorType: EscalationInitiator;
    /** The authenticated staff member whose ask/action triggered it (traceability). */
    actorId: Types.ObjectId | null;
  };
  /** Bounded lifecycle story (see EscalationHistoryEntry). */
  history: EscalationHistoryEntry[];
  /** Mongoose optimistic-concurrency version key (transition writes $inc it). */
  __v: number;
  createdAt: Date;
  updatedAt: Date;
}
