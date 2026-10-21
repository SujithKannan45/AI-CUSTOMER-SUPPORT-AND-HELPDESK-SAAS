import { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';

import { recordCustomerAudit, CUSTOMER_AUDIT_ACTIONS } from './customer-audit.js';
import {
  toCustomerDto,
  type CustomerCreatedPayload,
  type CustomerDetailPayload,
  type CustomerDto,
  type CustomerInteractionSummary,
  type CustomerListPayload,
  type CustomerListSpec,
} from './customer.dto.js';
import {
  archiveCustomer,
  createCustomer,
  findCustomerInWorkspace,
  listCustomers,
  restoreCustomer,
  updateCustomer,
} from './customer.repository.js';
import type { CreateCustomerInput, ListCustomersQuery, UpdateCustomerInput } from './customer.validation.js';

/**
 * Customer business flows (controllers stay thin; authorization has ALREADY
 * run in middleware — this layer is tenant- and data-integrity logic).
 *
 * Rules:
 * - Workspace association always comes from the validated workspace context;
 *   payloads are structurally incapable of carrying a workspaceId (strict
 *   Zod schemas reject it) and the repository composes every query from the
 *   server-side `workspaceId` argument.
 * - Duplicate-email policy (documented product rule): customer emails are
 *   unique PER WORKSPACE among live customers — the same person may be a
 *   customer of many workspaces; archived customers release their address.
 *   A conflicting email is a 409, mapped from the database's partial unique
 *   index `uniq_customer_email_per_workspace` (race-free by construction).
 * - Archive/restore are IDEMPOTENT: archiving an already-archived customer
 *   (and restoring a live one) returns the customer unchanged — the state is
 *   predictable under retries instead of 404-flickering.
 * - Interaction summaries are a future seam: nothing invented, only the
 *   model's existing `lastInteractionAt` is served (customer.dto.ts).
 */
const CUSTOMER_NOT_FOUND = 'Customer not found';

export interface CustomerRequestContext {
  /** Validated workspace context id (middleware-loaded), hex string. */
  readonly workspaceId: string;
  /** Authenticated actor (audit trail), hex string. */
  readonly actorId: string;
}

export async function createCustomerFlow(
  context: CustomerRequestContext,
  input: CreateCustomerInput,
): Promise<CustomerCreatedPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const customer = await createCustomer(workspaceId, {
    name: input.name,
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  });

  recordCustomerAudit({
    action: CUSTOMER_AUDIT_ACTIONS.created,
    workspaceId,
    actorId: new Types.ObjectId(context.actorId),
    customerId: customer._id.toHexString(),
    // No PII in the audit trail — the resource id locates the record.
    request: undefined,
  });

  return { customer: toCustomerDto(customer) };
}

export async function getCustomerFlow(
  context: CustomerRequestContext,
  customerId: string,
): Promise<CustomerDetailPayload> {
  const customer = await findCustomerInWorkspace(
    new Types.ObjectId(context.workspaceId),
    new Types.ObjectId(customerId),
  );
  if (customer === null) {
    throw AppError.notFound(CUSTOMER_NOT_FOUND);
  }
  return { customer: toCustomerDto(customer) };
}

/** Query spec built ONLY from validated middleware output. */
function toListSpec(context: CustomerRequestContext, query: ListCustomersQuery): CustomerListSpec {
  return {
    workspaceId: new Types.ObjectId(context.workspaceId),
    page: query.page,
    limit: query.limit,
    ...(query.search !== undefined ? { search: query.search } : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.tags !== undefined ? { tags: query.tags } : {}),
    sort: query.sort,
    order: query.order,
    ...(query.createdFrom !== undefined ? { createdFrom: new Date(query.createdFrom) } : {}),
    ...(query.createdTo !== undefined ? { createdTo: new Date(query.createdTo) } : {}),
    archiveState: query.archiveState,
  };
}

export async function listCustomersFlow(
  context: CustomerRequestContext,
  query: ListCustomersQuery,
): Promise<CustomerListPayload> {
  const result = await listCustomers(toListSpec(context, query));
  const items = result.items.map((doc) => toCustomerDto(doc));
  return {
    items,
    page: query.page,
    limit: query.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
}

/** Field names changed by an update — audit metadata, never values. */
function changedFieldNames(updates: UpdateCustomerInput): string[] {
  return Object.entries(updates)
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => (value === null ? `${field}.cleared` : field));
}

export async function updateCustomerFlow(
  context: CustomerRequestContext,
  customerId: string,
  updates: UpdateCustomerInput,
): Promise<CustomerDto> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const customer = await updateCustomer(workspaceId, new Types.ObjectId(customerId), updates);
  if (customer === null) {
    throw AppError.notFound(CUSTOMER_NOT_FOUND);
  }

  recordCustomerAudit({
    action: CUSTOMER_AUDIT_ACTIONS.updated,
    workspaceId,
    actorId: new Types.ObjectId(context.actorId),
    customerId: customer._id.toHexString(),
    metadata: { fields: changedFieldNames(updates) },
    request: undefined,
  });

  return toCustomerDto(customer);
}

export async function archiveCustomerFlow(
  context: CustomerRequestContext,
  customerId: string,
): Promise<CustomerDto> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const customerIdObject = new Types.ObjectId(customerId);

  // Idempotent semantics: the transition (live → archived) is attempted
  // first; ONLY that transition is audited. An already-archived customer
  // returns unchanged (predictable retries, no duplicate audit entries);
  // unknown/foreign ids fall through to 404 with no existence oracle.
  const archived = await archiveCustomer(workspaceId, customerIdObject, new Date());
  if (archived !== null) {
    recordCustomerAudit({
      action: CUSTOMER_AUDIT_ACTIONS.archived,
      workspaceId,
      actorId: new Types.ObjectId(context.actorId),
      customerId: archived._id.toHexString(),
      request: undefined,
    });
    return toCustomerDto(archived);
  }

  // Not live here — either already archived (idempotent) or nonexistent.
  const existing = await findCustomerInWorkspace(workspaceId, customerIdObject, {
    includeArchived: true,
  });
  if (existing === null) {
    throw AppError.notFound(CUSTOMER_NOT_FOUND);
  }
  return toCustomerDto(existing);
}

export async function restoreCustomerFlow(
  context: CustomerRequestContext,
  customerId: string,
): Promise<CustomerDto> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const customerIdObject = new Types.ObjectId(customerId);

  // Idempotent restore — mirror of archiveCustomerFlow: only the real
  // transition (archived → live) is audited. If a live customer registered
  // the same email while this one was archived, the repository translates the
  // index conflict into a 409 (never a raw DB error).
  const restored = await restoreCustomer(workspaceId, customerIdObject);
  if (restored !== null) {
    recordCustomerAudit({
      action: CUSTOMER_AUDIT_ACTIONS.restored,
      workspaceId,
      actorId: new Types.ObjectId(context.actorId),
      customerId: restored._id.toHexString(),
      request: undefined,
    });
    return toCustomerDto(restored);
  }

  const existing = await findCustomerInWorkspace(workspaceId, customerIdObject, {
    includeArchived: true,
  });
  if (existing === null) {
    throw AppError.notFound(CUSTOMER_NOT_FOUND);
  }
  return toCustomerDto(existing);
}

/**
 * Interaction-summary seam. Deliberately data-honest: tickets, conversations
 * and CSAT do not exist yet, so `available` stays false and the endpoint
 * serves only the model's existing `lastInteractionAt`. Future interaction
 * modules fill a real implementation behind this contract — customer
 * documents NEVER embed those histories (bounded-document rule).
 */
export async function getCustomerInteractionSummaryFlow(
  context: CustomerRequestContext,
  customerId: string,
): Promise<CustomerInteractionSummary> {
  const customer = await findCustomerInWorkspace(
    new Types.ObjectId(context.workspaceId),
    new Types.ObjectId(customerId),
  );
  if (customer === null) {
    throw AppError.notFound(CUSTOMER_NOT_FOUND);
  }
  return {
    available: false,
    lastInteractionAt: customer.lastInteractionAt?.toISOString() ?? null,
  };
}
