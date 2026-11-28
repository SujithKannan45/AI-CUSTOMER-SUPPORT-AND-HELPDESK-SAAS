/**
 * Client mirrors of the Prompt 9 conversation/message contracts
 * (`server/src/modules/conversations/conversation.dto.ts`).
 *
 * Only fields the API actually returns are modelled. In particular:
 * - a conversation carries NO status/assignment/unread state of its own — it
 *   follows its ticket's lifecycle, so the inbox shows the ticket's status and
 *   assignee rather than inventing conversation state;
 * - a conversation carries NO message preview; `lastMessageAt` is a pointer to
 *   the newest message and its body must be read from the messages endpoint.
 */

export const MESSAGE_VISIBILITIES = ['PUBLIC', 'INTERNAL'] as const;
export type MessageVisibility = (typeof MESSAGE_VISIBILITIES)[number];

export const MESSAGE_SENDER_TYPES = ['AGENT', 'CUSTOMER'] as const;
export type MessageSenderType = (typeof MESSAGE_SENDER_TYPES)[number];

/** Prompt 12 reference structure — stored, but no API accepts uploads yet. */
export interface MessageAttachmentRef {
  readonly fileKey: string;
  readonly filename: string;
  readonly sizeBytes?: number;
  readonly mimeType?: string;
}

export interface ConversationDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly customerId: string;
  readonly subject: string | null;
  /** Always true in this design: one primary conversation per ticket. */
  readonly isPrimary: true;
  readonly lastMessageAt: string | null;
  readonly lastMessageById: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MessageDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly ticketId: string;
  readonly senderId: string;
  readonly senderType: MessageSenderType;
  readonly body: string;
  readonly visibility: MessageVisibility;
  readonly attachments: readonly MessageAttachmentRef[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationListPayload {
  readonly items: readonly ConversationDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface ConversationDetailPayload {
  readonly conversation: ConversationDto;
}

export interface ConversationMutatedPayload {
  readonly conversation: ConversationDto;
  readonly created: boolean;
}

export interface MessageListPayload {
  readonly items: readonly MessageDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface MessageCreatedPayload {
  readonly message: MessageDto;
}

export interface MessageListQuery {
  readonly page?: number;
  readonly limit?: number;
  /** Literal substring over message bodies inside this conversation. */
  readonly search?: string;
}

/** Server maximum page size for both conversations and messages. */
export const INBOX_MAX_PAGE_SIZE = 50;
/** Messages loaded per thread page. */
export const INBOX_MESSAGE_PAGE_SIZE = 50;
/** Threads (tickets with one conversation each) per inbox page. */
export const INBOX_THREAD_PAGE_SIZE = 20;
/** `MAX_MESSAGE_BODY_LENGTH` in conversation.validation.ts. */
export const MESSAGE_BODY_MAX_LENGTH = 10_000;

/** Narrowing helper for untrusted strings. */
export function isMessageVisibility(value: string): value is MessageVisibility {
  return value === 'PUBLIC' || value === 'INTERNAL';
}
