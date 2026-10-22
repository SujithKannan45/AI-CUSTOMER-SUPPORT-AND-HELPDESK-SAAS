import { Router } from 'express';

import { validate } from '../../core/middlewares/validate.middleware.js';
import { requireAuth } from '../auth/require-auth.middleware.js';
import { WORKSPACE_PERMISSIONS } from '../rbac/rbac.permissions.js';
import { requirePermission } from '../rbac/require-permission.middleware.js';
import { requireWorkspaceContext } from '../workspaces/require-workspace.middleware.js';

import {
  createMessageController,
  editMessageController,
  getConversationController,
  getMessageController,
  getOrCreateConversationController,
  listMessagesController,
  listTicketConversationsController,
} from './conversation.controller.js';
import {
  conversationParamSchema,
  createConversationSchema,
  createMessageSchema,
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  messageParamSchema,
  ticketConversationParamSchema,
  updateMessageSchema,
} from './conversation.validation.js';

/**
 * Conversation routes — mounted at TWO prefixes in routes/api.routes.ts:
 *
 *   /api/v1/workspaces/:workspaceId/tickets/:ticketId/conversations  (ticket nested)
 *   /api/v1/workspaces/:workspaceId/conversations/:conversationId    (root conversation)
 *
 * `mergeParams` carries the parent `:workspaceId` (and `:ticketId` on the
 * nested router) so every request is scoped by the SAME validated
 * workspace-context middleware the tickets/customers use. Gate order per
 * route (identical to other modules):
 *
 *   1. requireAuth                             → 401
 *   2. validate(schema, 'params'|'body'|'query') → 422
 *   3. requireWorkspaceContext()               → 404 (foreign/inactive concealed)
 *   4. requirePermission(...)                  → 403 (registry decision + audit)
 *
 * Permission mapping (registry grants):
 * - get-or-create → `conversation.reply` (owner/admin/agent): creating the
 *   primary conversation is a MUTATION, so a read-only viewer cannot
 *   materialize it (read-only is enforced structurally, not by convention).
 * - list/read → `conversation.view` (owner/admin/agent/viewer — viewer is
 *   strictly read-only).
 * - send message (public reply or internal note; visibility is a
 *   sender-context decision the service authorizes) and edit own message
 *   → `conversation.reply` (owner/admin/agent). Agents remain capped by the
 *   ticket assignment rule (resource-access.ts, `allowCreator: true`) —
 *   enforced in the service via `req.workspace`.
 * - Internal notes are STAFF-ONLY by construction: `conversation.reply` is
 *   held only by staff roles, and read-side excludes INTERNAL from queries
 *   for roles without it. No customer-portal auth exists yet; customer
 *   boundaries are a documented dependency (see conversation.types.ts).
 */
export const ticketConversationRouter = Router({ mergeParams: true });

const requireWorkspace = requireWorkspaceContext();

ticketConversationRouter.post(
  '/:ticketId/conversations',
  requireAuth,
  validate(ticketConversationParamSchema, 'params'),
  validate(createConversationSchema),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.replyToConversations),
  getOrCreateConversationController,
);

ticketConversationRouter.get(
  '/:ticketId/conversations',
  requireAuth,
  validate(ticketConversationParamSchema, 'params'),
  validate(listConversationsQuerySchema, 'query'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.viewConversations),
  listTicketConversationsController,
);

export const conversationRouter = Router({ mergeParams: true });

conversationRouter.get(
  '/:conversationId',
  requireAuth,
  validate(conversationParamSchema, 'params'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.viewConversations),
  getConversationController,
);

conversationRouter.post(
  '/:conversationId/messages',
  requireAuth,
  validate(conversationParamSchema, 'params'),
  validate(createMessageSchema),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.replyToConversations),
  createMessageController,
);

conversationRouter.get(
  '/:conversationId/messages',
  requireAuth,
  validate(conversationParamSchema, 'params'),
  validate(listMessagesQuerySchema, 'query'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.viewConversations),
  listMessagesController,
);

conversationRouter.get(
  '/:conversationId/messages/:messageId',
  requireAuth,
  validate(messageParamSchema, 'params'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.viewConversations),
  getMessageController,
);

conversationRouter.patch(
  '/:conversationId/messages/:messageId',
  requireAuth,
  validate(messageParamSchema, 'params'),
  validate(updateMessageSchema),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.replyToConversations),
  editMessageController,
);
