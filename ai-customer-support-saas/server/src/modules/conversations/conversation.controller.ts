import type { Request, RequestHandler } from 'express';

import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';
import { resolveEffectiveRole } from '../rbac/require-permission.middleware.js';

import type { ConversationDetailPayload, ConversationListPayload, MessageDetailPayload, MessageListPayload } from './conversation.dto.js';
import {
  getConversationFlow,
  getOrCreateConversationFlow,
  editMessageFlow,
  getMessageFlow,
  listMessagesFlow,
  createMessageFlow,
  listTicketConversationsFlow,
  type ConversationRequestContext,
} from './conversation.service.js';
import {
  type CreateConversationInput,
  type CreateMessageInput,
  type ListMessagesQuery,
  type UpdateMessageInput,
type  ListConversationsQuery } from './conversation.validation.js';

/**
 * Conversation & message controllers — HTTP shape only (parse → service →
 * respond). Authorization has ALREADY happened in middleware:
 *
 *   requireAuth → validate(...) → requireWorkspaceContext() → requirePermission(...)
 *
 * so handlers read the validated context (`req.workspace`,
 * `req.validated.params`, parsed body/query). The service additionally
 * enforces the agent assignment cap for sends/edits using the effective role
 * resolved here (same owner-integrity rule as the ticket controllers).
 */

interface ConversationValidatedRequest extends Request {
  readonly validated?: {
    readonly params?: {
      readonly workspaceId?: string;
      readonly ticketId?: string;
      readonly conversationId?: string;
      readonly messageId?: string;
    };
  };
}

function contextOf(req: ConversationValidatedRequest): ConversationRequestContext {
  const workspace = req.workspace!;
  return {
    workspaceId: workspace.workspaceId,
    actorId: req.auth!.userId,
    role: resolveEffectiveRole(workspace),
  };
}

function ticketIdOf(req: ConversationValidatedRequest): string {
  return req.validated!.params!.ticketId!;
}

function conversationIdOf(req: ConversationValidatedRequest): string {
  return req.validated!.params!.conversationId!;
}

function messageIdOf(req: ConversationValidatedRequest): string {
  return req.validated!.params!.messageId!;
}

/** POST …/tickets/:ticketId/conversations — get-or-create the primary conversation. */
export const getOrCreateConversationController: RequestHandler = asyncHandler(
  async (req, res) => {
    const r = req as ConversationValidatedRequest;
    const result = await getOrCreateConversationFlow(
      contextOf(r),
      ticketIdOf(r),
      (req.body ?? {}) as CreateConversationInput,
    );
    sendSuccess(res, result.created ? 201 : 200, result, req);
  },
);

/** GET …/tickets/:ticketId/conversations — paginated conversations of a ticket. */
export const listTicketConversationsController: RequestHandler = asyncHandler(
  async (req, res) => {
    const r = req as ConversationValidatedRequest;
    const payload: ConversationListPayload = await listTicketConversationsFlow(
      contextOf(r),
      ticketIdOf(r),
      req.query as unknown as ListConversationsQuery,
    );
    sendSuccess(res, 200, payload, req);
  },
);

/** GET …/conversations/:conversationId — details of a live conversation. */
export const getConversationController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as ConversationValidatedRequest;
  const payload: ConversationDetailPayload = await getConversationFlow(
    contextOf(r),
    conversationIdOf(r),
  );
  sendSuccess(res, 200, payload, req);
});

/** POST …/conversations/:conversationId/messages — public reply or internal note. */
export const createMessageController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as ConversationValidatedRequest;
  const result = await createMessageFlow(
    contextOf(r),
    conversationIdOf(r),
    req.body as CreateMessageInput,
  );
  sendSuccess(res, 201, result, req);
});

/** GET …/conversations/:conversationId/messages — chronological thread page. */
export const listMessagesController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as ConversationValidatedRequest;
  const payload: MessageListPayload = await listMessagesFlow(
    contextOf(r),
    conversationIdOf(r),
    req.query as unknown as ListMessagesQuery,
  );
  sendSuccess(res, 200, payload, req);
});

/** GET …/conversations/:conversationId/messages/:messageId — authorized single message. */
export const getMessageController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as ConversationValidatedRequest;
  const payload: MessageDetailPayload = await getMessageFlow(
    contextOf(r),
    conversationIdOf(r),
    messageIdOf(r),
  );
  sendSuccess(res, 200, payload, req);
});

/** PATCH …/conversations/:conversationId/messages/:messageId — sender-only body edit. */
export const editMessageController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as ConversationValidatedRequest;
  const result = await editMessageFlow(
    contextOf(r),
    conversationIdOf(r),
    messageIdOf(r),
    req.body as UpdateMessageInput,
  );
  sendSuccess(res, 200, result, req);
});
