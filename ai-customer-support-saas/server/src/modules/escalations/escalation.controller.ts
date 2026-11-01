import type { Request, RequestHandler } from 'express';

import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';
import { resolveEffectiveRole } from '../rbac/require-permission.middleware.js';

import {
  acceptEscalationFlow,
  assignEscalationFlow,
  cancelEscalationFlow,
  createManualEscalationFlow,
  getEscalationFlow,
  getEscalationHistoryFlow,
  listEscalationsFlow,
  resolveEscalationFlow,
  type EscalationRequestContext,
} from './escalation.service.js';
import type {
  AssignEscalationInput,
  CancelEscalationInput,
  CreateEscalationInput,
  EscalationParams,
  ResolveEscalationInput,
} from './escalation.validation.js';

/**
 * Escalation controllers — HTTP shape only (parse → service → respond), the
 * same thin composition as the other modules. Authorization has ALREADY
 * happened in middleware:
 *
 *   requireAuth → validate(...) → requireWorkspaceContext() → requirePermission(...)
 *
 * so handlers read the validated context (`req.workspace`,
 * `req.validated.params`, parsed bodies) and never see a client-supplied
 * workspace id or actor id. Ownership/lifecycle rules live in the service.
 */

interface EscalationValidatedRequest extends Request {
  readonly validated?: {
    readonly params?: EscalationParams;
  };
}

function contextOf(req: EscalationValidatedRequest): EscalationRequestContext {
  const workspace = req.workspace!;
  return {
    workspaceId: workspace.workspaceId,
    actorId: req.auth!.userId,
    role: resolveEffectiveRole(workspace),
  };
}

function escalationIdOf(req: EscalationValidatedRequest): string {
  return req.validated!.params!.escalationId;
}

/** POST …/escalations — manual staff escalation over a verified conversation. */
export const createEscalationController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as EscalationValidatedRequest;
  const result = await createManualEscalationFlow(
    contextOf(r),
    req.body as CreateEscalationInput,
    req,
  );
  sendSuccess(res, result.created ? 201 : 200, result, req);
});

/** GET …/escalations — paginated, filterable queue/history listing. */
export const listEscalationsController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as EscalationValidatedRequest;
  const payload = await listEscalationsFlow(contextOf(r), req.query as never);
  sendSuccess(res, 200, payload, req);
});

/** GET …/escalations/:escalationId — record details (bounded metadata). */
export const getEscalationController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as EscalationValidatedRequest;
  const payload = await getEscalationFlow(contextOf(r), escalationIdOf(r));
  sendSuccess(res, 200, payload, req);
});

/** GET …/escalations/:escalationId/history — bounded lifecycle story. */
export const getEscalationHistoryController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as EscalationValidatedRequest;
  const payload = await getEscalationHistoryFlow(contextOf(r), escalationIdOf(r));
  sendSuccess(res, 200, payload, req);
});

/** POST …/escalations/:escalationId/assign — authorized staff assignment/reassignment. */
export const assignEscalationController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as EscalationValidatedRequest;
  const payload = await assignEscalationFlow(
    contextOf(r),
    escalationIdOf(r),
    req.body as AssignEscalationInput,
    req,
  );
  sendSuccess(res, 200, payload, req);
});

/** POST …/escalations/:escalationId/accept — assignee admits work / queue claim. */
export const acceptEscalationController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as EscalationValidatedRequest;
  const payload = await acceptEscalationFlow(contextOf(r), escalationIdOf(r), req);
  sendSuccess(res, 200, payload, req);
});

/** POST …/escalations/:escalationId/resolve — assignee/administrator concludes the handoff. */
export const resolveEscalationController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as EscalationValidatedRequest;
  const payload = await resolveEscalationFlow(
    contextOf(r),
    escalationIdOf(r),
    req.body as ResolveEscalationInput,
    req,
  );
  sendSuccess(res, 200, payload, req);
});

/** POST …/escalations/:escalationId/cancel — involved staff/administrator withdraws the handoff. */
export const cancelEscalationController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as EscalationValidatedRequest;
  const payload = await cancelEscalationFlow(
    contextOf(r),
    escalationIdOf(r),
    req.body as CancelEscalationInput,
    req,
  );
  sendSuccess(res, 200, payload, req);
});
