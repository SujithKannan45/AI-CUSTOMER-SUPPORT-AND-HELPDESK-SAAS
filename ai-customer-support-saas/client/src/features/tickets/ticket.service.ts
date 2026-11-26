import { httpClient } from '@/services/http-client.service';
import type {
  TicketDetailPayload,
  TicketDto,
  TicketListPayload,
  TicketListQuery,
  TicketPriority,
  TicketStatus,
} from './types';

/**
 * Ticket endpoints (backend: `server/src/modules/tickets`).
 *
 * Permission gates are server-side (`ticket.view`, `ticket.update`,
 * `ticket.assign`) and the service layer additionally caps agents to tickets
 * assigned to them or opened by them. This module only builds requests.
 */
function ticketPath(workspaceId: string, suffix = ''): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tickets${suffix}`;
}

function ticketIdPath(workspaceId: string, ticketId: string, suffix = ''): string {
  return ticketPath(workspaceId, `/${encodeURIComponent(ticketId)}${suffix}`);
}

/** Query construction limited to the validated server contract. */
export function ticketListSearch(query: TicketListQuery): string {
  const params = new URLSearchParams();

  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.search !== undefined && query.search.length > 0) params.set('search', query.search);
  if (query.status !== undefined) params.set('status', query.status);
  if (query.priority !== undefined) params.set('priority', query.priority);
  if (query.customerId !== undefined) params.set('customerId', query.customerId);
  if (query.agentId !== undefined) params.set('agentId', query.agentId);
  if (query.tags !== undefined && query.tags.length > 0) params.set('tags', query.tags.join(','));
  if (query.sort !== undefined) params.set('sort', query.sort);
  if (query.order !== undefined) params.set('order', query.order);
  if (query.createdFrom !== undefined) params.set('createdFrom', query.createdFrom);
  if (query.createdTo !== undefined) params.set('createdTo', query.createdTo);
  if (query.updatedFrom !== undefined) params.set('updatedFrom', query.updatedFrom);
  if (query.updatedTo !== undefined) params.set('updatedTo', query.updatedTo);
  if (query.archiveState !== undefined) params.set('archiveState', query.archiveState);

  return params.toString();
}

function signalOptions(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal !== undefined ? { signal } : {};
}

export const ticketService = {
  /** GET …/tickets — tenant-scoped, filtered, paginated listing. */
  list(workspaceId: string, query: TicketListQuery = {}, signal?: AbortSignal): Promise<TicketListPayload> {
    const search = ticketListSearch(query);
    return httpClient.get<TicketListPayload>(
      `${ticketPath(workspaceId)}${search.length > 0 ? `?${search}` : ''}`,
      signalOptions(signal),
    );
  },

  /** GET …/tickets/:ticketId — live tickets only (archived read 404). */
  get(workspaceId: string, ticketId: string, signal?: AbortSignal): Promise<TicketDetailPayload> {
    return httpClient.get<TicketDetailPayload>(
      ticketIdPath(workspaceId, ticketId),
      signalOptions(signal),
    );
  },

  /** PATCH …/tickets/:ticketId/status — server enforces allowed transitions. */
  setStatus(workspaceId: string, ticketId: string, status: TicketStatus): Promise<TicketDetailPayload> {
    return httpClient.patch<TicketDetailPayload>(ticketIdPath(workspaceId, ticketId, '/status'), {
      status,
    });
  },

  /** PATCH …/tickets/:ticketId/priority. */
  setPriority(
    workspaceId: string,
    ticketId: string,
    priority: TicketPriority,
  ): Promise<TicketDetailPayload> {
    return httpClient.patch<TicketDetailPayload>(ticketIdPath(workspaceId, ticketId, '/priority'), {
      priority,
    });
  },

  /** POST …/tickets/:ticketId/resolve — optional plain-text resolution note. */
  resolve(
    workspaceId: string,
    ticketId: string,
    resolutionNote?: string,
  ): Promise<TicketDetailPayload> {
    return httpClient.post<TicketDetailPayload>(ticketIdPath(workspaceId, ticketId, '/resolve'), {
      ...(resolutionNote !== undefined && resolutionNote.length > 0 ? { resolutionNote } : {}),
    });
  },

  /** POST …/tickets/:ticketId/reopen — guided transition back to OPEN. */
  reopen(workspaceId: string, ticketId: string): Promise<TicketDetailPayload> {
    return httpClient.post<TicketDetailPayload>(ticketIdPath(workspaceId, ticketId, '/reopen'));
  },
};

/** Narrowing helper for callers that receive an untrusted string. */
export function isTicketStatus(value: string): value is TicketStatus {
  return value === 'OPEN' || value === 'IN_PROGRESS' || value === 'WAITING_FOR_CUSTOMER' || value === 'RESOLVED' || value === 'CLOSED';
}

/** Narrowing helper for callers that receive an untrusted string. */
export function isTicketPriority(value: string): value is TicketPriority {
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'URGENT';
}

export type { TicketDto };
