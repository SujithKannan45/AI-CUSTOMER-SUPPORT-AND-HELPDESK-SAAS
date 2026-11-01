import type { Types } from 'mongoose';

import type { EscalationListResult } from './escalation.repository.js';
import type {
  EscalationDocument,
  EscalationHistoryEntry,
  EscalationPriority,
  EscalationStatus,
  EscalationTriggerType,
} from './escalation.types.js';
import type { ListEscalationsQuery } from './escalation.validation.js';

/**
 * Escalation module — public DTOs, service payloads and query objects (the
 * same split ticket.dto.ts/conversation.dto.ts established). The safe
 * representation that crosses the HTTP boundary lives here — never the raw
 * Mongoose document.
 *
 * Content law: the DTO carries ids, machine reason codes, lifecycle states
 * and bounded timestamps only. Conversation bodies, resolution notes and
 * cancel reasons stay OUT of list/detail payloads (resolution/cancel texts
 * are stored in the document, but the record is for staff desks and the
 * audit trail — which is itself content-free). Staff/name resolution is the
 * consumers' job through the reference ids (no population here).
 */

// ── DTOs (HTTP read models) ──────────────────────────────────────────────────

export interface EscalationDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  /** Copied from the verified conversation at creation (server-side). */
  readonly ticketId: string;
  /** Copied from the verified conversation at creation (server-side). */
  readonly customerId: string;
  readonly triggerType: EscalationTriggerType;
  /** Machine reason code preserved from the trigger (Prompt 14 reasons, provider codes, topic keys, MANUAL). */
  readonly reasonCode: string;
  /** Matched sensitive-topic key when triggerType === SENSITIVE_TOPIC, else null. */
  readonly topicKey: string | null;
  readonly priority: EscalationPriority;
  readonly status: EscalationStatus;
  /** Current work owner when ASSIGNED (staff user reference). */
  readonly eligibleAssigneeId: string | null;
  readonly acceptedById: string | null;
  readonly resolvedById: string | null;
  readonly resolvedAt: string | null;
  readonly cancelledById: string | null;
  readonly cancelledAt: string | null;
  /** Whether a resolution statement exists (without leaking its text). */
  readonly hasResolutionNote: boolean;
  /** Whether a cancel reason exists (without leaking its text). */
  readonly hasCancelReason: boolean;
  readonly initiatedBy: {
    readonly actorType: 'STAFF' | 'AI_AGENT';
    /** The staff member whose ask/action triggered the escalation (traceability). */
    readonly actorId: string | null;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Bounded lifecycle story — include only the newest N entries in payloads. */
const HISTORY_PAYLOAD_MAX_ENTRIES = 25;

export interface EscalationHistoryDto {
  readonly action: EscalationHistoryEntry['action'];
  readonly at: string;
  readonly actorType: 'STAFF' | 'AI_AGENT';
  readonly actorId: string | null;
  /** Bounded detail (e.g. created reason code / assignee id) — never message content. */
  readonly detail: string | null;
}

// ── Service payload types (controller envelope data) ─────────────────────────

/** POST …/escalations — 201 (created) / 200 (reused active) payload. */
export interface EscalationCreatedPayload {
  readonly escalation: EscalationDto;
  /** `false` when an ACTIVE escalation already existed for the conversation. */
  readonly created: boolean;
}

/** GET …/escalations/:escalationId — 200 payload. */
export interface EscalationDetailPayload {
  readonly escalation: EscalationDto;
}

/** GET …/escalations/:escalationId/history — 200 payload (bounded newest-last). */
export interface EscalationHistoryPayload {
  readonly history: readonly EscalationHistoryDto[];
}

/** GET …/escalations — 200 payload (same pagination contract as tickets). */
export interface EscalationListPayload {
  readonly items: readonly EscalationDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

// ── Mapper (the single place a document becomes a DTO) ───────────────────────

function toHistoryDto(entry: EscalationHistoryEntry): EscalationHistoryDto {
  return {
    action: entry.action,
    at: (entry.at instanceof Date ? entry.at : new Date(entry.at)).toISOString(),
    actorType: entry.actorType,
    actorId: entry.actorId === undefined || entry.actorId === null ? null : entry.actorId.toHexString(),
    detail: entry.detail === undefined ? null : entry.detail,
  };
}

export function toEscalationDto(doc: EscalationDocument): EscalationDto {
  return {
    id: doc._id.toHexString(),
    workspaceId: doc.workspaceId.toHexString(),
    conversationId: doc.conversationId.toHexString(),
    ticketId: doc.ticketId.toHexString(),
    customerId: doc.customerId.toHexString(),
    triggerType: doc.triggerType,
    reasonCode: doc.reasonCode,
    topicKey: doc.topicKey === undefined || doc.topicKey === null ? null : doc.topicKey,
    priority: doc.priority,
    status: doc.status,
    eligibleAssigneeId:
      doc.eligibleAssigneeId === null || doc.eligibleAssigneeId === undefined
        ? null
        : doc.eligibleAssigneeId.toHexString(),
    acceptedById: doc.acceptedById === null || doc.acceptedById === undefined ? null : doc.acceptedById.toHexString(),
    resolvedById: doc.resolvedById === null || doc.resolvedById === undefined ? null : doc.resolvedById.toHexString(),
    resolvedAt: doc.resolvedAt === null || doc.resolvedAt === undefined ? null : doc.resolvedAt.toISOString(),
    cancelledById:
      doc.cancelledById === null || doc.cancelledById === undefined ? null : doc.cancelledById.toHexString(),
    cancelledAt: doc.cancelledAt === null || doc.cancelledAt === undefined ? null : doc.cancelledAt.toISOString(),
    hasResolutionNote: typeof doc.resolutionNote === 'string' && doc.resolutionNote.length > 0,
    hasCancelReason: typeof doc.cancelReason === 'string' && doc.cancelReason.length > 0,
    initiatedBy: {
      actorType: doc.initiatedBy.actorType,
      actorId:
        doc.initiatedBy.actorId === null || doc.initiatedBy.actorId === undefined
          ? null
          : doc.initiatedBy.actorId.toHexString(),
    },
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toEscalationHistoryDto(doc: EscalationDocument): readonly EscalationHistoryDto[] {
  return [...doc.history]
    .slice(-HISTORY_PAYLOAD_MAX_ENTRIES)
    .map((entry) => toHistoryDto(entry));
}

// ── Service → repository payload composition ─────────────────────────────────

export function toEscalationListPayload(
  result: EscalationListResult,
  query: ListEscalationsQuery,
): EscalationListPayload {
  return {
    items: result.items.map((doc) => toEscalationDto(doc)),
    page: query.page,
    limit: query.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
}

/** Utility kept local: an ObjectId-ish to hex for event payloads. */
export function objectIdHex(value: Types.ObjectId): string {
  return value.toHexString();
}
