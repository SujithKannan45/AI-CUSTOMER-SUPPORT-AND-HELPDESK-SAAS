import type { Types } from 'mongoose';

import type { TicketDocument, TicketPriority, TicketStatus } from './ticket.types.js';
import type { ArchiveState, TicketSortField } from './ticket.validation.js';

/**
 * Ticket module — public DTOs, service payloads and query objects.
 *
 * The safe representation that crosses the HTTP boundary lives here — never
 * the raw Mongoose document. No PII beyond ids: customer/user details are
 * resolved by their own modules through the reference ids (no duplication).
 */
export interface TicketDto {
  readonly id: string;
  readonly workspaceId: string;
  /** Human-readable workspace-scoped number, e.g. `TKT-000012`. */
  readonly number: string;
  readonly customerId: string;
  readonly subject: string;
  readonly description: string;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  /** Assigned agent (user hex id) or null when in the triage queue. */
  readonly agentId: string | null;
  readonly createdById: string;
  readonly tags: readonly string[];
  readonly category: string | null;
  readonly resolutionNote: string | null;
  readonly dueAt: string | null;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
  /** Archive stamp (null = live ticket). */
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** GET …/tickets/:ticketId — 200 payload. */
export interface TicketDetailPayload {
  readonly ticket: TicketDto;
}

/** POST …/tickets — 201 payload. */
export type TicketCreatedPayload = TicketDetailPayload;

/** GET …/tickets — 200 payload (pagination contract matches customers). */
export interface TicketListPayload {
  readonly items: readonly TicketDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

// ── Mapper (the single place a document becomes a DTO) ───────────────────────

export function toTicketDto(doc: TicketDocument): TicketDto {
  return {
    id: doc._id.toHexString(),
    workspaceId: doc.workspaceId.toHexString(),
    number: doc.number,
    customerId: doc.customerId.toHexString(),
    subject: doc.subject,
    description: doc.description,
    status: doc.status,
    priority: doc.priority,
    agentId: doc.agentId === null ? null : doc.agentId.toHexString(),
    createdById: doc.createdById.toHexString(),
    tags: [...doc.tags],
    category: doc.category?.length ? doc.category : null,
    resolutionNote: doc.resolutionNote?.length ? doc.resolutionNote : null,
    dueAt: doc.dueAt?.toISOString() ?? null,
    resolvedAt: doc.resolvedAt?.toISOString() ?? null,
    closedAt: doc.closedAt?.toISOString() ?? null,
    archivedAt: doc.deletedAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Query object handed from the service to the repository (already validated). */
export interface TicketListSpec {
  readonly workspaceId: Types.ObjectId;
  readonly page: number;
  readonly limit: number;
  readonly search?: string;
  readonly status?: TicketStatus;
  readonly priority?: TicketPriority;
  readonly customerId?: string;
  readonly agentId?: string;
  readonly tags?: string[];
  readonly sort: TicketSortField;
  readonly order: 'asc' | 'desc';
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
  readonly updatedFrom?: Date;
  readonly updatedTo?: Date;
  readonly archiveState: ArchiveState;
}
