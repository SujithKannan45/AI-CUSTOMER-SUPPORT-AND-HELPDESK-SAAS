import type { Types } from 'mongoose';

import type { TenantScopedDocument } from '../../database/tenant.js';

/**
 * Message visibility. PUBLIC messages are customer-facing conversation
 * content; INTERNAL notes are workspace-staff-only annotations. Visibility is
 * decided at send time by the SENDER'S ROLE (staff vs. future customer
 * identity), never by a client-supplied flag on a different actor's behalf —
 * and it is immutable after the message exists (no public↔internal swaps).
 */
export const MESSAGE_VISIBILITIES = ['PUBLIC', 'INTERNAL'] as const;
export type MessageVisibility = (typeof MESSAGE_VISIBILITIES)[number];

/**
 * Message sender types, derived from the EXISTING identity/authentication
 * model:
 *
 * - `AGENT` — a workspace member (user) authenticated through the staff JWT
 *   auth module. This is the ONLY sender type producible today, because no
 *   customer-portal authentication exists yet (documented Prompt 9 dependency;
 *   customer senders arrive when that identity mechanism does — never by
 *   trusting a client-supplied customerId).
 * - `CUSTOMER` — reserved for the future customer identity mechanism.
 */
export const MESSAGE_SENDER_TYPES = ['AGENT', 'CUSTOMER'] as const;
export type MessageSenderType = (typeof MESSAGE_SENDER_TYPES)[number];

/**
 * Conversation — the staff↔customer thread attached to ONE ticket.
 *
 * Model decision (enforced by a UNIQUE index, not just convention): a ticket
 * has exactly ONE PRIMARY conversation. The ticket lifecycle is the only
 * lifecycle — conversations deliberately carry NO status of their own (they
 * open and close with their ticket; a second state machine here would be a
 * conflicting lifecycle to keep in sync). Archiving/lifecycle behavior is
 * inherited: conversations for a live ticket are readable/writable; when the
 * ticket is archived (soft-deleted) its conversation reads as not-found.
 *
 * Content never lives here: messages are a separate collection referencing
 * this document by id (bounded documents, independent growth — same rule as
 * tickets referencing customers). The conversation carries only pointers and
 * small, non-content metadata (`subject`, last-message pointer metadata).
 */
export interface ConversationDocument extends TenantScopedDocument {
  /** The ticket this conversation belongs to; same-workspace by law. */
  ticketId: Types.ObjectId;
  /**
   * The ticket's customer, copied from the ticket AT CREATION TIME by the
   * service (never by the client) so customer-scoped queries on conversations
   * need no join. Pure reference — never duplicated profile data.
   */
  customerId: Types.ObjectId;
  /** Optional workspace-facing label; the ticket subject remains the source of truth. */
  subject: string | null;
  /**
   * Advisory pointer metadata: when the most recent message landed and who
   * sent it (ids only — no content preview, no duplicated message data).
   * Maintained by the message-send flow; deliberately self-healing on read
   * because this deployment does NOT support multi-document transactions
   * (documented limitation — see conversation.service.ts).
   */
  lastMessageAt: Date | null;
  lastMessageById: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Minimal attachment REFERENCE — the Prompt 12 integration point. Storage
 * keys are opaque strings pointing at the future file-management module;
 * conversations/messages NEVER store bytes, mime content or uploads. No API
 * accepts this structure yet (this prompt stores only the model shape) so
 * client-request payloads cannot fabricate attachment metadata.
 */
export interface MessageAttachmentRef {
  /** Opaque storage key owned by the future StorageService (Prompt 12). */
  readonly fileKey: string;
  readonly filename: string;
  readonly sizeBytes?: number;
  readonly mimeType?: string;
}

/**
 * Message — one immutable-after-send (subject to the audited sender-only edit
 * policy) entry in a conversation. The `ticketId` is denormalized from the
 * conversation (server-side) purely for efficient ticket-scoped queries and
 * tenant indexes; it is never a writable client field.
 */
export interface MessageDocument extends TenantScopedDocument {
  conversationId: Types.ObjectId;
  /** Denormalized from the conversation at server-side composition. */
  ticketId: Types.ObjectId;
  /** Sender — a User today (see MESSAGE_SENDER_TYPES for the customer case). */
  senderId: Types.ObjectId;
  senderType: MessageSenderType;
  /** Normalized plain-text body (trimmed, length-bounded by validation). */
  body: string;
  visibility: MessageVisibility;
  /** Prompt 12 references only — no uploads, no client writes in this prompt. */
  attachments: MessageAttachmentRef[];
  createdAt: Date;
  updatedAt: Date;
}
