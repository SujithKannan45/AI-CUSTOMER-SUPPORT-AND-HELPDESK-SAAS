import type { Types } from 'mongoose';

import type {
  ConversationDocument,
  MessageDocument,
  MessageAttachmentRef,
} from './conversation.types.js';

/**
 * Conversation module — public DTOs, service payloads and query objects
 * (the same split ticket.dto.ts established). The safe representation that
 * crosses the HTTP boundary lives here — never the raw Mongoose document.
 *
 * No content duplication: message bodies live only in Message documents;
 * the conversation DTO carries ids, counts-of-reference metadata and
 * timestamps only. Sender details (names/emails) are resolved by consumers
 * through the reference ids — no user/customer population happens here.
 */

// ── DTOs (HTTP read models) ──────────────────────────────────────────────────

export interface ConversationDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly ticketId: string;
  /** Customer reference, copied from the ticket at creation (server-side). */
  readonly customerId: string;
  readonly subject: string | null;
  /**
   * Constantly `true` in this design: a ticket has exactly ONE PRIMARY
   * conversation (unique `{ workspaceId, ticketId }` index). The explicit
   * flag documents the model without implying multi-conversation tickets.
   */
  readonly isPrimary: true;
  /**
   * Advisory last-message pointers (no content, no preview): when the newest
   * message landed and who sent it. Self-healing on read because no
   * transaction exists in this deployment (documented limitation).
   */
  readonly lastMessageAt: string | null;
  readonly lastMessageById: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MessageDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  /** Denormalized ticket reference (server-side at composition). */
  readonly ticketId: string;
  readonly senderId: string;
  readonly senderType: 'AGENT' | 'CUSTOMER';
  readonly body: string;
  readonly visibility: 'PUBLIC' | 'INTERNAL';
  /** Prompt 12 reference structure only — never content, never uploads. */
  readonly attachments: readonly MessageAttachmentRef[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Service payload types (controller envelope data) ─────────────────────────

/** GET …/conversations/:conversationId — 200 payload. */
export interface ConversationDetailPayload {
  readonly conversation: ConversationDto;
}

/**
 * POST …/tickets/:ticketId/conversations — 200 (existed) / 201 (created)
 * payload. `created` distinguishes the first materialization (which audits)
 * from the returned primary conversation (which has nothing new to audit).
 */
export interface ConversationMutatedPayload {
  readonly conversation: ConversationDto;
  readonly created: boolean;
}

/** GET …/tickets/:ticketId/conversations — 200 payload (same pagination contract as tickets). */
export interface ConversationListPayload {
  readonly items: readonly ConversationDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

/** POST …/conversations/:conversationId/messages — 201 payload. */
export interface MessageCreatedPayload {
  readonly message: MessageDto;
}

/** GET …/messages/:messageId — 200 payload. */
export interface MessageDetailPayload {
  readonly message: MessageDto;
}

/** GET …/conversations/:conversationId/messages — 200 payload. */
export interface MessageListPayload {
  readonly items: readonly MessageDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

// ── Mapper (the single place a document becomes a DTO) ───────────────────────

export function toConversationDto(doc: ConversationDocument): ConversationDto {
  return {
    id: doc._id.toHexString(),
    workspaceId: doc.workspaceId.toHexString(),
    ticketId: doc.ticketId.toHexString(),
    customerId: doc.customerId.toHexString(),
    subject: doc.subject?.length ? doc.subject : null,
    isPrimary: true,
    lastMessageAt: doc.lastMessageAt?.toISOString() ?? null,
    lastMessageById: doc.lastMessageById === null ? null : doc.lastMessageById.toHexString(),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toMessageDto(doc: MessageDocument): MessageDto {
  return {
    id: doc._id.toHexString(),
    workspaceId: doc.workspaceId.toHexString(),
    conversationId: doc.conversationId.toHexString(),
    ticketId: doc.ticketId.toHexString(),
    senderId: doc.senderId.toHexString(),
    senderType: doc.senderType,
    body: doc.body,
    visibility: doc.visibility,
    attachments: [...doc.attachments],
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ── Service → repository query objects (already validated) ───────────────────

export interface ConversationListSpec {
  readonly workspaceId: Types.ObjectId;
  readonly ticketId: Types.ObjectId;
  readonly page: number;
  readonly limit: number;
}
