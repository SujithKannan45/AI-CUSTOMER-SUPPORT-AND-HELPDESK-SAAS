import type { Types } from 'mongoose';

import type { TenantScopedDocument } from '../../database/tenant.js';

/** Ticket lifecycle inside a workspace. */
export const TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_FOR_CUSTOMER',
  'RESOLVED',
  'CLOSED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Ticket triage urgency. Sorted by the `priorityRank` derived field (see model). */
export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/**
 * Numerical weight per priority — the single source for the model's derived
 * `priorityRank` field, which exists ONLY so MongoDB can sort by urgency:
 * string enum sorting would order HIGH < LOW < MEDIUM < URGENT
 * alphabetically, which is wrong. One derived integer per document, written
 * by the model hook, never client-controlled.
 */
export const TICKET_PRIORITY_RANKS: Record<TicketPriority, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  URGENT: 4,
};

/**
 * Allowed status transitions — the ONLY lifecycle law in the system. Both
 * the generic `PATCH /status` endpoint and the convenience wrappers
 * (`resolve`, `reopen`) go through `isValidTicketTransition`; no client can
 * write a status the map does not permit.
 *
 *   OPEN → IN_PROGRESS | WAITING_FOR_CUSTOMER | RESOLVED | CLOSED
 *   IN_PROGRESS → OPEN | WAITING_FOR_CUSTOMER | RESOLVED | CLOSED
 *   WAITING_FOR_CUSTOMER → OPEN | IN_PROGRESS | RESOLVED | CLOSED
 *   RESOLVED → OPEN (reopen/rework) | IN_PROGRESS | CLOSED (finalize)
 *   CLOSED → OPEN (the only way a closed ticket lives again)
 */
export const TICKET_STATUS_TRANSITIONS: Record<
  TicketStatus,
  readonly TicketStatus[]
> = {
  OPEN: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['OPEN', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  WAITING_FOR_CUSTOMER: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['OPEN', 'IN_PROGRESS', 'CLOSED'],
  CLOSED: ['OPEN'],
};

export function isValidTicketTransition(
  from: TicketStatus,
  to: TicketStatus,
): boolean {
  return TICKET_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Ticket — one support request inside a workspace, referencing a Customer and
 * (optionally) the agent working it.
 *
 * Strictly tenant-scoped; conversations and messages will REFERENCE this
 * document by id in Prompt 9 — never embed them here (bounded documents,
 * independent growth rates). Customer/user data is never duplicated on the
 * ticket: ids only, with consumers resolving names through their own modules.
 */
export interface TicketDocument extends TenantScopedDocument {
  /** Human-readable sequence number, unique within the workspace (see ticket-number.ts). */
  number: string;
  /** The customer this ticket is about; must belong to the same workspace. */
  customerId: Types.ObjectId;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  /**
   * Derived sort weight for the priority field (1 LOW … 4 URGENT),
   * maintained by a model hook — the only derived field, documented there.
   */
  priorityRank: number;
  /** The agent (a workspace member's user) currently on the ticket; null = triage queue. */
  agentId: Types.ObjectId | null;
  /** Staff member (any member role) who opened the ticket; used by the creator cap. */
  createdById: Types.ObjectId;
  tags: string[];
  /** Free-form routing label (e.g. "billing"); optional, workspace-managed. */
  category?: string;
  /** How the resolution was described at resolve time (optional, PLAIN TEXT). */
  resolutionNote?: string;
  /** Contractual deadline, when the workspace tracks one; no SLA engine yet. */
  dueAt?: Date | null;
  /** Set when entering RESOLVED from another state, cleared when leaving it. */
  resolvedAt: Date | null;
  /** Set when entering CLOSED, cleared on reopen. */
  closedAt: Date | null;
  /** Soft delete / archive stamp (customers convention); null = live. */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
