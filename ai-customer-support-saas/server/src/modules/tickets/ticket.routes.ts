import { Router } from 'express';

import { validate } from '../../core/middlewares/validate.middleware.js';
import { requireAuth } from '../auth/require-auth.middleware.js';
import { WORKSPACE_PERMISSIONS } from '../rbac/rbac.permissions.js';
import { requirePermission } from '../rbac/require-permission.middleware.js';
import { requireWorkspaceContext } from '../workspaces/require-workspace.middleware.js';

import {
  archiveTicketController,
  createTicketController,
  getTicketController,
  listTicketsController,
  reopenTicketController,
  resolveTicketController,
  setTicketAssignmentController,
  setTicketPriorityController,
  setTicketStatusController,
  updateTicketController,
} from './ticket.controller.js';
import {
  createTicketSchema,
  listTicketsQuerySchema,
  resolveTicketSchema,
  setTicketAssignmentSchema,
  setTicketPrioritySchema,
  setTicketStatusSchema,
  ticketIdParamSchema,
  updateTicketSchema,
} from './ticket.validation.js';

/**
 * Ticket routes — mounted at
 * `/api/v1/workspaces/:workspaceId/tickets` (routes/api.routes.ts).
 *
 * The parent router's `:workspaceId` param arrives through this Router's
 * params object; both ids are validated together by `ticketIdParamSchema`
 * BEFORE `requireWorkspaceContext()` consumes the workspace (which parses
 * only the workspaceId key — see require-workspace.middleware.ts).
 *
 * Gate order (same as customers/workspace):
 *   1. requireAuth                        → 401
 *   2. validate(schema, 'params'|'body'|'query') → 422
 *   3. requireWorkspaceContext()          → 404 (foreign/inactive concealed)
 *   4. requirePermission(...)             → 403 (registry decision + audit)
 *
 * Permission mapping (registry grants, current state):
 * - create → `ticket.create` (owner/admin/agent).
 * - read/list → `ticket.view` (all roles).
 * - update/status/priority/resolve/reopen/archive → `ticket.update`
 *   (owner/admin/agent; agents remain capped by the assignment rule —
 *   resource-access.ts — enforced in the service via `req.workspace`).
 * - assignment → `ticket.assign` (owner/admin ONLY, per the registry —
 *   agents cannot reassign tickets to colleagues).
 */
export const ticketRouter = Router({ mergeParams: true });

const requireWorkspace = requireWorkspaceContext();

ticketRouter.post(
  '/',
  requireAuth,
  validate(createTicketSchema),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.createTicket),
  createTicketController,
);

ticketRouter.get(
  '/',
  requireAuth,
  validate(listTicketsQuerySchema, 'query'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.viewTickets),
  listTicketsController,
);

ticketRouter.get(
  '/:ticketId',
  requireAuth,
  validate(ticketIdParamSchema, 'params'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.viewTickets),
  getTicketController,
);

ticketRouter.patch(
  '/:ticketId',
  requireAuth,
  validate(ticketIdParamSchema, 'params'),
  validate(updateTicketSchema),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.updateTicket),
  updateTicketController,
);

ticketRouter.patch(
  '/:ticketId/status',
  requireAuth,
  validate(ticketIdParamSchema, 'params'),
  validate(setTicketStatusSchema),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.updateTicket),
  setTicketStatusController,
);

ticketRouter.patch(
  '/:ticketId/assignment',
  requireAuth,
  validate(ticketIdParamSchema, 'params'),
  validate(setTicketAssignmentSchema),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.assignTicket),
  setTicketAssignmentController,
);

ticketRouter.patch(
  '/:ticketId/priority',
  requireAuth,
  validate(ticketIdParamSchema, 'params'),
  validate(setTicketPrioritySchema),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.updateTicket),
  setTicketPriorityController,
);

ticketRouter.post(
  '/:ticketId/resolve',
  requireAuth,
  validate(ticketIdParamSchema, 'params'),
  validate(resolveTicketSchema),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.updateTicket),
  resolveTicketController,
);

ticketRouter.post(
  '/:ticketId/reopen',
  requireAuth,
  validate(ticketIdParamSchema, 'params'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.updateTicket),
  reopenTicketController,
);

ticketRouter.post(
  '/:ticketId/archive',
  requireAuth,
  validate(ticketIdParamSchema, 'params'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.updateTicket),
  archiveTicketController,
);
