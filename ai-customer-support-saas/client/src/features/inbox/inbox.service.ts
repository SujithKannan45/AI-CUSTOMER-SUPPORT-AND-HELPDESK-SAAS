import { httpClient } from '@/services/http-client.service';
import type {
  ConversationDetailPayload,
  ConversationListPayload,
  ConversationMutatedPayload,
  MessageCreatedPayload,
  MessageListPayload,
  MessageListQuery,
  MessageVisibility,
} from './types';

/**
 * Conversation/message endpoints (backend: `server/src/modules/conversations`).
 *
 * Authorization is entirely server-side: `conversation.view` gates reads,
 * `conversation.reply` gates sends, and the service additionally caps agents to
 * tickets they are assigned to or opened. Client-supplied ids identify the
 * resource only — the workspace in the path is the tenant the server validates
 * against the caller's membership, and `senderId`/`senderType`/`ticketId` are
 * composed server-side (never sent from here).
 */
function workspacePath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;
}

function ticketConversationsPath(workspaceId: string, ticketId: string): string {
  return `${workspacePath(workspaceId)}/tickets/${encodeURIComponent(ticketId)}/conversations`;
}

function conversationPath(workspaceId: string, conversationId: string, suffix = ''): string {
  return `${workspacePath(workspaceId)}/conversations/${encodeURIComponent(conversationId)}${suffix}`;
}

function signalOptions(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal !== undefined ? { signal } : {};
}

/** Query string for the messages endpoint (validated keys only). */
export function messageListSearch(query: MessageListQuery): string {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.search !== undefined && query.search.length > 0) params.set('search', query.search);
  return params.toString();
}

export const inboxService = {
  /** GET …/tickets/:ticketId/conversations — a ticket has at most one. */
  listForTicket(
    workspaceId: string,
    ticketId: string,
    query: { page?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<ConversationListPayload> {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const search = params.toString();
    return httpClient.get<ConversationListPayload>(
      `${ticketConversationsPath(workspaceId, ticketId)}${search.length > 0 ? `?${search}` : ''}`,
      signalOptions(signal),
    );
  },

  /** POST …/tickets/:ticketId/conversations — idempotent get-or-create. */
  startForTicket(workspaceId: string, ticketId: string): Promise<ConversationMutatedPayload> {
    return httpClient.post<ConversationMutatedPayload>(
      ticketConversationsPath(workspaceId, ticketId),
      {},
    );
  },

  /** GET …/conversations/:conversationId — live conversations only. */
  get(
    workspaceId: string,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<ConversationDetailPayload> {
    return httpClient.get<ConversationDetailPayload>(
      conversationPath(workspaceId, conversationId),
      signalOptions(signal),
    );
  },

  /** GET …/conversations/:conversationId/messages — chronological page. */
  listMessages(
    workspaceId: string,
    conversationId: string,
    query: MessageListQuery = {},
    signal?: AbortSignal,
  ): Promise<MessageListPayload> {
    const search = messageListSearch(query);
    return httpClient.get<MessageListPayload>(
      `${conversationPath(workspaceId, conversationId, '/messages')}${search.length > 0 ? `?${search}` : ''}`,
      signalOptions(signal),
    );
  },

  /**
   * POST …/conversations/:conversationId/messages — public reply or internal
   * note. Visibility is the SENDER's own choice (the server validates that the
   * caller is authorised to make it); the body is always plain text.
   */
  sendMessage(
    workspaceId: string,
    conversationId: string,
    input: { readonly body: string; readonly visibility: MessageVisibility },
  ): Promise<MessageCreatedPayload> {
    return httpClient.post<MessageCreatedPayload>(
      conversationPath(workspaceId, conversationId, '/messages'),
      { body: input.body, visibility: input.visibility },
    );
  },
};
