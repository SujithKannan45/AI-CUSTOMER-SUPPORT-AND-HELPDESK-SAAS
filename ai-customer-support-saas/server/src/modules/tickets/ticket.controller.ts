import type { Request, RequestHandler } from 'express';

import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';
import { resolveEffectiveRole } from '../rbac/require-permission.middleware.js';

import type { TicketDetailPayload } from './ticket.dto.js';
import {
  archiveTicketFlow,
  assignTicketFlow,
  changePriorityFlow,
  changeStatusFlow,
  createTicketFlow,
  getTicketFlow,
  listTicketsFlow,
  reopenTicketFlow,
  resolveTicketFlow,
  updateTicketFlow,
  type TicketRequestContext,
} from './ticket.service.js';
import type {
  CreateTicketInput,
  ListTicketsQuery,
  ResolveTicketInput,
  SetTicketAssignmentInput,
  SetTicketPriorityInput,
  SetTicketStatusInput,
} from './ticket.validation.js';

/**
 * Ticket controllers — HTTP shape only (parse → service → respond).
 * Authorization has ALREADY happened in middleware:
 *
 *   requireAuth → validate(...) → requireWorkspaceContext() → requirePermission(...)
 *
 * so these handlers read the validated context (`req.workspace`,
 * `req.validated.params`, parsed body/query) and never re-check roles.
 * The service additionally enforces the assignment cap for agents using the
 * effective role resolved here (same owner-integrity rule as the RBAC
 * middleware).
 */

interface TicketValidatedRequest extends Request {
  readonly validated?: { readonly params?: { readonly ticketId: string } };
}

function contextOf(req: TicketValidatedRequest): TicketRequestContext {
  const workspace = req.workspace!;
  return {
    workspaceId: workspace.workspaceId,
    actorId: req.auth!.userId,
    role: resolveEffectiveRole(workspace),
  };
}

function ticketIdOf(req: TicketValidatedRequest): string {
  return req.validated!.params!.ticketId;
}

/** POST /api/v1/workspaces/:workspaceId/tickets — create a ticket. */
export const createTicketController: RequestHandler = asyncHandler(async (req, res) => {
  const payload = await createTicketFlow(contextOf(req), req.body as CreateTicketInput);
  sendSuccess(res, 201, payload, req);
});

/** GET /api/v1/workspaces/:workspaceId/tickets — filtered/paginated listing. */
export const listTicketsController: RequestHandler = asyncHandler(async (req, res) => {
  const payload = await listTicketsFlow(
    contextOf(req),
    req.query as unknown as ListTicketsQuery,
  );
  sendSuccess(res, 200, payload, req);
});

/** GET …/tickets/:ticketId — details of a LIVE ticket. */
export const getTicketController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as TicketValidatedRequest;
  const payload: TicketDetailPayload = await getTicketFlow(
    contextOf(r),
    ticketIdOf(r),
  );
  sendSuccess(res, 200, payload, req);
});

/** PATCH …/tickets/:ticketId — edit explicitly allowlisted fields. */
export const updateTicketController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as TicketValidatedRequest;
  const ticket = await updateTicketFlow(
    contextOf(r),
    ticketIdOf(r),
    req.body as Parameters<typeof updateTicketFlow>[2],
  );
  sendSuccess(res, 200, { ticket }, req);
});

/** PATCH …/tickets/:ticketId/status — validated lifecycle transition. */
export const setTicketStatusController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as TicketValidatedRequest;
  const ticket = await changeStatusFlow(
    contextOf(r),
    ticketIdOf(r),
    req.body as SetTicketStatusInput,
  );
  sendSuccess(res, 200, { ticket }, req);
});

/** PATCH …/tickets/:ticketId/assignment — assign/unassign (owner/admin). */
export const setTicketAssignmentController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as TicketValidatedRequest;
  const ticket = await assignTicketFlow(
    contextOf(r),
    ticketIdOf(r),
    req.body as SetTicketAssignmentInput,
  );
  sendSuccess(res, 200, { ticket }, req);
});

/** PATCH …/tickets/:ticketId/priority — change triage urgency. */
export const setTicketPriorityController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as TicketValidatedRequest;
  const ticket = await changePriorityFlow(
    contextOf(r),
    ticketIdOf(r),
    req.body as SetTicketPriorityInput,
  );
  sendSuccess(res, 200, { ticket }, req);
});

/** POST …/tickets/:ticketId/resolve — guided transition to RESOLVED. */
export const resolveTicketController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as TicketValidatedRequest;
  const ticket = await resolveTicketFlow(
    contextOf(r),
    ticketIdOf(r),
    (req.body ?? {}) as ResolveTicketInput,
  );
  sendSuccess(res, 200, { ticket }, req);
});

/** POST …/tickets/:ticketId/reopen — guided transition back to OPEN. */
export const reopenTicketController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as TicketValidatedRequest;
  const ticket = await reopenTicketFlow(contextOf(r), ticketIdOf(r));
  sendSuccess(res, 200, { ticket }, req);
});

/** POST …/tickets/:ticketId/archive — idempotent soft delete (live-only). */
export const archiveTicketController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as TicketValidatedRequest;
  const ticket = await archiveTicketFlow(contextOf(r), ticketIdOf(r));
  sendSuccess(res, 200, { ticket }, req);
});
