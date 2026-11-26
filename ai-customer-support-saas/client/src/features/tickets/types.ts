/**
 * Client mirrors of the Prompt 8 ticket contracts
 * (`server/src/modules/tickets/ticket.dto.ts` / `ticket.types.ts`).
 *
 * The status transition table is copied from the server so the UI can offer
 * only transitions the backend will accept. The backend remains authoritative:
 * an invalid move is still a 409, surfaced as a plain error.
 */
export const TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_FOR_CUSTOMER',
  'RESOLVED',
  'CLOSED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** `server/src/modules/tickets/ticket.types.ts` — the lifecycle law. */
export const TICKET_STATUS_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['OPEN', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  WAITING_FOR_CUSTOMER: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['OPEN', 'IN_PROGRESS', 'CLOSED'],
  CLOSED: ['OPEN'],
};

/** Non-current statuses the backend accepts from the current one. */
export function statusTargetsFor(status: TicketStatus): readonly TicketStatus[] {
  return TICKET_STATUS_TRANSITIONS[status].filter((target) => target !== status);
}

export interface TicketDto {
  readonly id: string;
  readonly workspaceId: string;
  /** Workspace-scoped human number, e.g. `TKT-000012`. */
  readonly number: string;
  readonly customerId: string;
  readonly subject: string;
  readonly description: string;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  /** Assigned member (user id) or null when in the triage queue. */
  readonly agentId: string | null;
  readonly createdById: string;
  readonly tags: readonly string[];
  readonly category: string | null;
  readonly resolutionNote: string | null;
  readonly dueAt: string | null;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
  /** Archive stamp; null = live ticket. */
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TicketDetailPayload {
  readonly ticket: TicketDto;
}

export interface TicketListPayload {
  readonly items: readonly TicketDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

/** Server sort allowlist. */
export const TICKET_SORT_FIELDS = ['createdAt', 'updatedAt', 'priority', 'number'] as const;
export type TicketSortField = (typeof TICKET_SORT_FIELDS)[number];

export const TICKET_PAGE_SIZE = 20;
export const TICKET_MAX_PAGE_SIZE = 50;
export const TICKET_RESOLUTION_NOTE_MAX = 10_000;

export interface TicketListQuery {
  readonly page?: number;
  readonly limit?: number;
  /** Substring over ticket NUMBER or SUBJECT (server-side). */
  readonly search?: string;
  readonly status?: TicketStatus;
  readonly priority?: TicketPriority;
  /** Exact customer match (24-hex id). */
  readonly customerId?: string;
  /** Exact assigned-agent match (24-hex user id). */
  readonly agentId?: string;
  readonly tags?: readonly string[];
  readonly sort?: TicketSortField;
  readonly order?: 'asc' | 'desc';
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly updatedFrom?: string;
  readonly updatedTo?: string;
  readonly archiveState?: 'live' | 'archived' | 'all';
}
