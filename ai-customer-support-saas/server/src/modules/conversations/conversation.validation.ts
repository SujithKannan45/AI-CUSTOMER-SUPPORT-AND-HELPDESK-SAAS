import { z } from 'zod';

import { MESSAGE_VISIBILITIES, type MessageVisibility } from './conversation.types.js';

/**
 * Conversation & Message request validation (Zod, applied declaratively at
 * the routes) — mirroring the models so HTTP failures are 422s and anything
 * that slips past is still caught at the schema boundary.
 *
 * Mass-assignment protection: every schema is `.strict()` and defines ONLY
 * the accepted keys. Fields that could corrupt tenant identity or lifecycle
 * are STRUCTURALLY unacceptable:
 * - the client can NEVER supply `workspaceId`, `ticketId`, `customerId`,
 *   `conversationId`, `senderId` or `senderType` — those are composed
 *   server-side from the validated workspace context, ticket and the
 *   authenticated principal;
 * - `visibility` is accepted at SEND time only (sender chooses their own
 *   message's visibility, restricted server-side to what their identity can
 *   hold) and is IMMUTABLE afterwards — PATCH messages accept `body` only,
 *   so a client can never flip public↔internal;
 * - `attachments` is not accepted anywhere yet (Prompt 12 owns that flow).
 */
export const CONVERSATION_SUBJECT_MAX = 200;
export const MAX_MESSAGE_BODY_LENGTH = 10_000;
export const MAX_SEARCH_LENGTH = 100;
export const MAX_PAGE_SIZE = 50;

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'Must be a 24-character hex string');

// ── Identification ───────────────────────────────────────────────────────────

/** Ticket-scoped conversation routes: `/workspaces/:ws/tickets/:ticketId/conversations`. */
export const ticketConversationParamSchema = z
  .object({
    workspaceId: objectIdSchema,
    ticketId: objectIdSchema,
  })
  .strict();

export interface TicketConversationParams {
  workspaceId: string;
  ticketId: string;
}

/** Conversation-scoped routes: `/workspaces/:ws/conversations/:conversationId`. */
export const conversationParamSchema = z
  .object({
    workspaceId: objectIdSchema,
    conversationId: objectIdSchema,
  })
  .strict();

export interface ConversationParams {
  workspaceId: string;
  conversationId: string;
}

export const messageParamSchema = z
  .object({
    workspaceId: objectIdSchema,
    conversationId: objectIdSchema,
    messageId: objectIdSchema,
  })
  .strict();

export interface MessageParams {
  workspaceId: string;
  conversationId: string;
  messageId: string;
}

// ── Create (get-or-create the primary conversation) ──────────────────────────

export const createConversationSchema = z
  .object({
    /** Optional label; absent/null keeps the ticket subject as source of truth. */
    subject: z.string().trim().min(1).max(CONVERSATION_SUBJECT_MAX).optional(),
  })
  .strict();

export interface CreateConversationInput {
  subject?: string;
}

// ── Messages ─────────────────────────────────────────────────────────────────

const messageBodySchema = z
  .string()
  .trim()
  .min(1, 'Message body is required')
  .max(MAX_MESSAGE_BODY_LENGTH, `Message body must be at most ${MAX_MESSAGE_BODY_LENGTH} characters`);

/**
 * Send-time visibility choice. `INTERNAL` is validated structurally here but
 * the SERVICE further authorizes it against the effective role — the schema
 * is the shape contract, the service is the authorization decision.
 */
export const createMessageSchema = z
  .object({
    body: messageBodySchema,
    visibility: z.enum(MESSAGE_VISIBILITIES).default('PUBLIC'),
  })
  .strict();

export interface CreateMessageInput {
  body: string;
  visibility: MessageVisibility;
}

/**
 * Edit policy: body only. Visibility, sender, conversation, ticket and
 * timestamps are immutable — the strict shape REJECTS any attempt (including
 * a public→internal flip that could paste a public violation or shield an
 * internal note into customer-visible territory).
 */
export const updateMessageSchema = z
  .object({
    body: messageBodySchema,
  })
  .strict();

export interface UpdateMessageInput {
  body: string;
}

// ── Listing ──────────────────────────────────────────────────────────────────

export const listConversationsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z
      .coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE, `Page size must be at most ${MAX_PAGE_SIZE}`)
      .default(20),
  })
  .strict();

export const listMessagesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z
      .coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE, `Page size must be at most ${MAX_PAGE_SIZE}`)
      .default(20),
  })
  .strict();

export interface ListConversationsQuery {
  page: number;
  limit: number;
}

export interface ListMessagesQuery {
  page: number;
  limit: number;
}

/**
 * Documentation only (identity fields are rejected by the strict schemas): the
 * fields that can NEVER be accepted from a request payload. Listed here so
 * reviewers can check the schemas against the identity contract in one place.
 */
export const NON_CLIENT_FIELDS = [
  'workspaceId',
  'ticketId',
  'customerId',
  'conversationId',
  'senderId',
  'senderType',
] as const;
