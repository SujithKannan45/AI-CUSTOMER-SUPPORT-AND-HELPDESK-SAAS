import type { Request, RequestHandler } from 'express';

import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';

import {
  type CustomerDetailPayload,
  type CustomerInteractionSummary,
} from './customer.dto.js';
import {
  archiveCustomerFlow,
  createCustomerFlow,
  getCustomerInteractionSummaryFlow,
  getCustomerFlow,
  listCustomersFlow,
  restoreCustomerFlow,
  updateCustomerFlow,
  type CustomerRequestContext,
} from './customer.service.js';
import type {
  CreateCustomerInput,
  ListCustomersQuery,
  UpdateCustomerInput,
} from './customer.validation.js';

/**
 * Customer controllers — HTTP shape only (parse → service → respond).
 * Authorization has ALREADY happened in middleware:
 *
 *   requireAuth → validate(...) → requireWorkspaceContext() → requirePermission(...)
 *
 * so these handlers read the validated context (`req.workspace`,
 * `req.validated.params`, parsed body/query) and never re-check roles.
 */

/**
 * Request shape after the customer param schema ran (see validate.middleware:
 * param schemas expose their parsed object via `req.validated.params` while
 * the live Express `req.params` getter stays untouched). `req.auth` and
 * `req.workspace` come from the auth / workspace middleware augmentations.
 */
interface CustomerValidatedRequest extends Request {
  readonly validated?: { readonly params?: { readonly customerId: string } };
}

/** The validated context baked by requireAuth + requireWorkspaceContext. */
function contextOf(req: CustomerValidatedRequest): CustomerRequestContext {
  const workspace = req.workspace!;
  return { workspaceId: workspace.workspaceId, actorId: req.auth!.userId };
}

function customerIdOf(req: CustomerValidatedRequest): string {
  return req.validated!.params!.customerId;
}

/**
 * POST /api/v1/workspaces/:workspaceId/customers — create a customer in the
 * validated workspace. Payload-protected fields (_id, workspaceId,
 * timestamps) cannot arrive: the strict create schema rejects them with 422.
 */
export const createCustomerController: RequestHandler = asyncHandler(async (req, res) => {
  const payload = await createCustomerFlow(contextOf(req), req.body as CreateCustomerInput);
  sendSuccess(res, 201, payload, req);
});

/** GET /api/v1/workspaces/:workspaceId/customers — filtered/paginated listing. */
export const listCustomersController: RequestHandler = asyncHandler(async (req, res) => {
  const payload = await listCustomersFlow(contextOf(req), req.query as unknown as ListCustomersQuery);
  sendSuccess(res, 200, payload, req);
});

/**
 * GET /api/v1/workspaces/:workspaceId/customers/:customerId — details of a
 * LIVE customer (archived customers read as not-found here; the listing's
 * archiveState=archived slice is the explicit way to see them).
 */
export const getCustomerController: RequestHandler = asyncHandler(async (req, res) => {
  const customerId = customerIdOf(req as CustomerValidatedRequest);
  const payload: CustomerDetailPayload = await getCustomerFlow(contextOf(req as CustomerValidatedRequest), customerId);
  sendSuccess(res, 200, payload, req);
});

/**
 * PATCH /api/v1/workspaces/:workspaceId/customers/:customerId — edit an
 * explicitly-allowlisted set of fields; workspace reassignment and id/timestamp
 * tampering are structurally impossible (strict schema + repository scoping).
 */
export const updateCustomerController: RequestHandler = asyncHandler(async (req, res) => {
  const customerId = customerIdOf(req as CustomerValidatedRequest);
  const customer = await updateCustomerFlow(
    contextOf(req as CustomerValidatedRequest),
    customerId,
    req.body as UpdateCustomerInput,
  );
  sendSuccess(res, 200, { customer }, req);
});

/** PATCH …/customers/:customerId/archive — idempotent soft delete. */
export const archiveCustomerController: RequestHandler = asyncHandler(async (req, res) => {
  const customerId = customerIdOf(req as CustomerValidatedRequest);
  const customer = await archiveCustomerFlow(contextOf(req as CustomerValidatedRequest), customerId);
  sendSuccess(res, 200, { customer }, req);
});

/** PATCH …/customers/:customerId/restore — idempotent undelete. */
export const restoreCustomerController: RequestHandler = asyncHandler(async (req, res) => {
  const customerId = customerIdOf(req as CustomerValidatedRequest);
  const customer = await restoreCustomerFlow(contextOf(req as CustomerValidatedRequest), customerId);
  sendSuccess(res, 200, { customer }, req);
});

/**
 * GET …/customers/:customerId/summary — the future interaction seam
 * (currently `available: false`; see customer.dto.ts).
 */
export const getCustomerSummaryController: RequestHandler = asyncHandler(async (req, res) => {
  const customerId = customerIdOf(req as CustomerValidatedRequest);
  const payload: CustomerInteractionSummary = await getCustomerInteractionSummaryFlow(
    contextOf(req as CustomerValidatedRequest),
    customerId,
  );
  sendSuccess(res, 200, { summary: payload }, req);
});
