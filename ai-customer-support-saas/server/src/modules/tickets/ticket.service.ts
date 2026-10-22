import { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import { CustomerModel } from '../customers/customer.model.js';
import { roleHasPermission, WORKSPACE_PERMISSIONS } from '../rbac/rbac.permissions.js';
import { evaluateResourceModification } from '../rbac/resource-access.js';
import { getMembership } from '../workspaces/workspace.service.js';
import { hasAtLeastRole, type WorkspaceRole } from '../workspaces/workspace.types.js';

import { TICKET_AUDIT_ACTIONS, recordTicketAudit } from './ticket-audit.js';
import {
  toTicketDto,
  type TicketCreatedPayload,
  type TicketDetailPayload,
  type TicketDto,
  type TicketListPayload,
  type TicketListSpec,
} from './ticket.dto.js';
import {
  archiveTicketRecord,
  createTicketRecord,
  findTicketInWorkspace,
  listTickets,
  updateTicketAssignment,
  updateTicketFields,
  updateTicketPriority,
  updateTicketStatus,
} from './ticket.repository.js';
import {
  isValidTicketTransition,
  TICKET_STATUS_TRANSITIONS,
  type TicketDocument,
  type TicketStatus,
} from './ticket.types.js';
import type {
  CreateTicketInput,
  ListTicketsQuery,
  ResolveTicketInput,
  SetTicketAssignmentInput,
  SetTicketPriorityInput,
  SetTicketStatusInput,
  UpdateTicketInput,
} from './ticket.validation.js';

/**
 * Ticket business flows (controllers stay thin; authorization has ALREADY
 * run in middleware — this layer is tenant-, lifecycle- and integrity logic).
 *
 * Rules:
 * - Workspace association always comes from the validated workspace context;
 *   payloads are structurally incapable of carrying a workspaceId, number,
 *   status or lifecycle timestamps (strict Zod schemas reject them) and the
 *   repository composes every query from the server-side `workspaceId`.
 * - Cross-references are verified server-side: the customer must exist LIVE
 *   in the SAME workspace (404 otherwise), and a supplied assignee must be
 *   an ACTIVE member of the same workspace with an agent-or-above role
 *   (viewers are not desk staff).
 * - Lifecycle law: every status change goes through `isValidTicketTransition`
 *   (see ticket.types.ts); invalid moves are 409 with the allowed targets in
 *   the error details. Convenience endpoints (resolve/reopen) are guided
 *   transitions, all idempotent: a repeated request without a net state
 *   change returns the ticket unchanged and audits nothing.
 * - Agent cap: agents may modify ONLY tickets assigned to them or created by
 *   them (documented per-module policy via `evaluateResourceModification` —
 *   creator edits allowed for the open-it-then-work-it desk flow). Viewers
 *   are structurally denied (no update permission). Owner/admin pass the cap
 *   as privileged triage roles.
 * - Audit reliability: audit appends follow the project-wide fire-and-forget
 *   pattern (a failed append is logged, never breaks the user-visible flow).
 *   Multi-document transactions are NOT used; ticket+counter are
 *   document-atomic, and the consistency caveat is documented in
 *   docs/data-model.md and the counter model.
 */
const TICKET_NOT_FOUND = 'Ticket not found';
const CUSTOMER_NOT_FOUND = 'Customer not found';

export interface TicketRequestContext {
  /** Validated workspace context id (middleware-loaded), hex string. */
  readonly workspaceId: string;
  /** Authenticated actor (audit trail + caps), hex string. */
  readonly actorId: string;
  /** Effective role from the validated membership (owner-anomaly resolved). */
  readonly role: WorkspaceRole;
}

async function requireLiveCustomer(workspaceId: Types.ObjectId, customerId: string): Promise<void> {
  const customer = await CustomerModel.findOne({
    workspaceId,
    _id: new Types.ObjectId(customerId),
  });
  if (customer === null) throw AppError.notFound(CUSTOMER_NOT_FOUND);
}

async function requireWorkspaceAssignee(
  workspaceId: Types.ObjectId,
  agentId: string,
): Promise<void> {
  const membership = await getMembership(workspaceId.toHexString(), agentId);
  if (
    membership === null ||
    membership.status !== 'active' ||
    !hasAtLeastRole(membership.role, 'agent')
  ) {
    // Same response whether the user is foreign, non-member or ineligible —
    // no workspace-membership oracle for foreign users.
    throw AppError.validation(
      'Assignee must be an active agent, admin or owner of this workspace',
    );
  }
}

/** Agents may only touch tickets assigned to them or created by them. */
function assertCanModifyTicket(context: TicketRequestContext, ticket: TicketDocument): void {
  const decision = evaluateResourceModification(
    { userId: context.actorId, role: context.role, workspaceId: context.workspaceId },
    {
      workspaceId: ticket.workspaceId.toHexString(),
      assigneeId: ticket.agentId,
      createdById: ticket.createdById,
    },
    { permission: WORKSPACE_PERMISSIONS.updateTicket, allowCreator: true },
  );
  if (!decision.allowed) {
    throw AppError.forbidden(
      'Only assigned agents (or workspace administrators) may modify this ticket',
    );
  }
}

export async function createTicketFlow(
  context: TicketRequestContext,
  input: CreateTicketInput,
): Promise<TicketCreatedPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);

  await requireLiveCustomer(workspaceId, input.customerId);

  let assigneeId: Types.ObjectId | null = null;
  if (input.agentId !== undefined) {
    // Assignment at creation is a `ticket.assign` action even though the
    // route's gate is `ticket.create` — the actor must hold both.
    if (!roleHasPermission(context.role, WORKSPACE_PERMISSIONS.assignTicket)) {
      throw AppError.forbidden('Only owners and administrators may assign tickets at creation');
    }
    await requireWorkspaceAssignee(workspaceId, input.agentId);
    assigneeId = new Types.ObjectId(input.agentId);
  }

  const ticket = await createTicketRecord(workspaceId, {
    customerId: new Types.ObjectId(input.customerId),
    subject: input.subject,
    description: input.description,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    agentId: input.agentId !== undefined ? assigneeId : undefined,
    createdById: new Types.ObjectId(context.actorId),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.dueAt !== undefined ? { dueAt: new Date(input.dueAt) } : {}),
  });

  recordTicketAudit({
    action: TICKET_AUDIT_ACTIONS.created,
    workspaceId,
    actorId: new Types.ObjectId(context.actorId),
    ticketId: ticket._id.toHexString(),
    metadata: {
      number: ticket.number,
      ...(assigneeId !== null ? { assignedTo: assigneeId.toHexString() } : {}),
    },
  });

  return { ticket: toTicketDto(ticket) };
}

export async function getTicketFlow(
  context: TicketRequestContext,
  ticketId: string,
): Promise<TicketDetailPayload> {
  const ticket = await findTicketInWorkspace(
    new Types.ObjectId(context.workspaceId),
    new Types.ObjectId(ticketId),
  );
  if (ticket === null) throw AppError.notFound(TICKET_NOT_FOUND);
  return { ticket: toTicketDto(ticket) };
}

function toListSpec(context: TicketRequestContext, query: ListTicketsQuery): TicketListSpec {
  return {
    workspaceId: new Types.ObjectId(context.workspaceId),
    page: query.page,
    limit: query.limit,
    ...(query.search !== undefined ? { search: query.search } : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.priority !== undefined ? { priority: query.priority } : {}),
    ...(query.customerId !== undefined ? { customerId: query.customerId } : {}),
    ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
    ...(query.tags !== undefined ? { tags: query.tags } : {}),
    sort: query.sort,
    order: query.order,
    ...(query.createdFrom !== undefined ? { createdFrom: new Date(query.createdFrom) } : {}),
    ...(query.createdTo !== undefined ? { createdTo: new Date(query.createdTo) } : {}),
    ...(query.updatedFrom !== undefined ? { updatedFrom: new Date(query.updatedFrom) } : {}),
    ...(query.updatedTo !== undefined ? { updatedTo: new Date(query.updatedTo) } : {}),
    archiveState: query.archiveState,
  };
}

export async function listTicketsFlow(
  context: TicketRequestContext,
  query: ListTicketsQuery,
): Promise<TicketListPayload> {
  const result = await listTickets(toListSpec(context, query));
  return {
    items: result.items.map((doc) => toTicketDto(doc)),
    page: query.page,
    limit: query.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
}

/** Loads the CURRENT live ticket (archived tickets read as not-found). */
async function loadLiveTicket(
  context: TicketRequestContext,
  ticketId: string,
): Promise<{ readonly workspaceId: Types.ObjectId; readonly ticketId: Types.ObjectId; readonly doc: TicketDocument }> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const ticketObjectId = new Types.ObjectId(ticketId);
  const doc = await findTicketInWorkspace(workspaceId, ticketObjectId);
  if (doc === null) throw AppError.notFound(TICKET_NOT_FOUND);
  return { workspaceId, ticketId: ticketObjectId, doc };
}

function changedFieldNames(updates: UpdateTicketInput): string[] {
  return Object.entries(updates)
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field);
}

export async function updateTicketFlow(
  context: TicketRequestContext,
  ticketId: string,
  updates: UpdateTicketInput,
): Promise<TicketDto> {
  const { workspaceId, ticketId: ticketObjectId, doc } = await loadLiveTicket(context, ticketId);
  assertCanModifyTicket(context, doc);

  if (updates.customerId !== undefined) {
    await requireLiveCustomer(workspaceId, updates.customerId);
  }

  const set: Record<string, unknown> = {};
  if (updates.subject !== undefined) set['subject'] = updates.subject;
  if (updates.description !== undefined) set['description'] = updates.description;
  if (updates.tags !== undefined) set['tags'] = updates.tags;
  if (updates.category !== undefined) set['category'] = updates.category;
  if (updates.dueAt !== undefined) set['dueAt'] = new Date(updates.dueAt);
  if (updates.customerId !== undefined) {
    set['customerId'] = new Types.ObjectId(updates.customerId);
  }

  const updated = await updateTicketFields(workspaceId, ticketObjectId, set);
  // The doc read above proves existence; a null here would mean an archive
  // raced between read and write — surfaced as the same not-found contract.
  if (updated === null) throw AppError.notFound(TICKET_NOT_FOUND);

  recordTicketAudit({
    action: TICKET_AUDIT_ACTIONS.updated,
    workspaceId,
    actorId: new Types.ObjectId(context.actorId),
    ticketId: updated._id.toHexString(),
    metadata: { fields: changedFieldNames(updates) },
  });

  return toTicketDto(updated);
}

/**
 * Lifecycle stamps for one transition — the single place they are derived.
 *
 * Entering a state stamps it; leaving it clears it (single timestamps, no
 * per-transition history inside the ticket document). One deliberate
 * exception: RESOLVED → CLOSED RETAINS resolvedAt (when a resolved ticket
 * was closed, it was resolved) — only an exit from RESOLVED that is not
 * closure (reopen, back to IN_PROGRESS, …) clears the stamp.
 */
function lifecycleStampsFor(target: TicketStatus): Partial<{
  readonly resolvedAt: Date | null;
  readonly closedAt: Date | null;
}> {
  switch (target) {
    case 'RESOLVED':
      return { resolvedAt: new Date(), closedAt: null };
    case 'CLOSED':
      // resolvedAt is deliberately NOT set — retained from the resolution.
      return { closedAt: new Date() };
    default:
      return { resolvedAt: null, closedAt: null };
  }
}

function transitionError(from: TicketStatus, to: TicketStatus): AppError {
  return new AppError(`Cannot change ticket status from ${from} to ${to}`, {
    statusCode: 409,
    code: 'INVALID_STATUS_TRANSITION',
    details: { from, to, allowedFrom: [...TICKET_STATUS_TRANSITIONS[from]] },
  });
}

export async function changeStatusFlow(
  context: TicketRequestContext,
  ticketId: string,
  input: SetTicketStatusInput,
): Promise<TicketDto> {
  const { workspaceId, ticketId: ticketObjectId, doc } = await loadLiveTicket(context, ticketId);
  assertCanModifyTicket(context, doc);

  if (doc.status === input.status) {
    // Idempotent no-op: a repeated request without a state change succeeds
    // without auditing a transition that did not happen.
    return toTicketDto(doc);
  }
  if (!isValidTicketTransition(doc.status, input.status)) {
    throw transitionError(doc.status, input.status);
  }

  const updated = await updateTicketStatus(workspaceId, ticketObjectId, {
    status: input.status,
    ...lifecycleStampsFor(input.status),
  });
  if (updated === null) throw AppError.notFound(TICKET_NOT_FOUND);

  recordTicketAudit({
    action: TICKET_AUDIT_ACTIONS.statusChanged,
    workspaceId,
    actorId: new Types.ObjectId(context.actorId),
    ticketId: updated._id.toHexString(),
    metadata: { from: doc.status, to: updated.status },
  });

  return toTicketDto(updated);
}

export async function changePriorityFlow(
  context: TicketRequestContext,
  ticketId: string,
  input: SetTicketPriorityInput,
): Promise<TicketDto> {
  const { workspaceId, ticketId: ticketObjectId, doc } = await loadLiveTicket(context, ticketId);
  assertCanModifyTicket(context, doc);

  if (doc.priority === input.priority) return toTicketDto(doc);

  const updated = await updateTicketPriority(workspaceId, ticketObjectId, input.priority);
  if (updated === null) throw AppError.notFound(TICKET_NOT_FOUND);

  recordTicketAudit({
    action: TICKET_AUDIT_ACTIONS.priorityChanged,
    workspaceId,
    actorId: new Types.ObjectId(context.actorId),
    ticketId: updated._id.toHexString(),
    metadata: { from: doc.priority, to: updated.priority },
  });

  return toTicketDto(updated);
}

export async function assignTicketFlow(
  context: TicketRequestContext,
  ticketId: string,
  input: SetTicketAssignmentInput,
): Promise<TicketDto> {
  const { workspaceId, ticketId: ticketObjectId, doc } = await loadLiveTicket(context, ticketId);

  const targetId =
    input.agentId === null ? null : new Types.ObjectId(input.agentId);
  if (input.agentId !== null) await requireWorkspaceAssignee(workspaceId, input.agentId);

  const unchanged = doc.agentId === null ? targetId === null : doc.agentId.equals(targetId);
  if (unchanged) return toTicketDto(doc);

  const updated = await updateTicketAssignment(workspaceId, ticketObjectId, targetId);
  if (updated === null) throw AppError.notFound(TICKET_NOT_FOUND);

  recordTicketAudit({
    action: targetId === null ? TICKET_AUDIT_ACTIONS.unassigned : TICKET_AUDIT_ACTIONS.assigned,
    workspaceId,
    actorId: new Types.ObjectId(context.actorId),
    ticketId: updated._id.toHexString(),
    metadata:
      targetId === null
        ? { from: doc.agentId?.toHexString() ?? null }
        : { to: targetId.toHexString(), from: doc.agentId?.toHexString() ?? null },
  });

  return toTicketDto(updated);
}

export async function resolveTicketFlow(
  context: TicketRequestContext,
  ticketId: string,
  input: ResolveTicketInput,
): Promise<TicketDto> {
  const { workspaceId, ticketId: ticketObjectId, doc } = await loadLiveTicket(context, ticketId);
  assertCanModifyTicket(context, doc);

  if (doc.status === 'RESOLVED') {
    // Idempotent: resolving an already-resolved ticket (optionally updating
    // the note) never audits a fake second resolution.
    if (input.resolutionNote === undefined || input.resolutionNote === doc.resolutionNote) {
      return toTicketDto(doc);
    }
  } else if (!isValidTicketTransition(doc.status, 'RESOLVED')) {
    throw transitionError(doc.status, 'RESOLVED');
  }

  const updated = await updateTicketStatus(workspaceId, ticketObjectId, {
    status: 'RESOLVED',
    resolutionNote: input.resolutionNote ?? doc.resolutionNote,
    // Transitioning INTO resolution stamps it now; a note-update on an
    // already-resolved ticket keeps its FIRST resolution time.
    resolvedAt: doc.status === 'RESOLVED' ? doc.resolvedAt : new Date(),
  });
  if (updated === null) throw AppError.notFound(TICKET_NOT_FOUND);

  if (doc.status !== 'RESOLVED') {
    recordTicketAudit({
      action: TICKET_AUDIT_ACTIONS.resolved,
      workspaceId,
      actorId: new Types.ObjectId(context.actorId),
      ticketId: updated._id.toHexString(),
      metadata: { from: doc.status, to: 'RESOLVED' },
    });
  }

  return toTicketDto(updated);
}

export async function reopenTicketFlow(
  context: TicketRequestContext,
  ticketId: string,
): Promise<TicketDto> {
  const { workspaceId, ticketId: ticketObjectId, doc } = await loadLiveTicket(context, ticketId);
  assertCanModifyTicket(context, doc);

  if (doc.status === 'OPEN') return toTicketDto(doc);
  if (!isValidTicketTransition(doc.status, 'OPEN')) {
    throw transitionError(doc.status, 'OPEN');
  }

  const updated = await updateTicketStatus(workspaceId, ticketObjectId, {
    status: 'OPEN',
    ...lifecycleStampsFor('OPEN'),
  });
  if (updated === null) throw AppError.notFound(TICKET_NOT_FOUND);

  recordTicketAudit({
    action: TICKET_AUDIT_ACTIONS.reopened,
    workspaceId,
    actorId: new Types.ObjectId(context.actorId),
    ticketId: updated._id.toHexString(),
    metadata: { from: doc.status, to: 'OPEN' },
  });

  return toTicketDto(updated);
}

export async function archiveTicketFlow(
  context: TicketRequestContext,
  ticketId: string,
): Promise<TicketDto> {
  const { workspaceId, ticketId: ticketObjectId, doc } = await loadLiveTicket(context, ticketId);
  assertCanModifyTicket(context, doc);

  // Archiving an already-archived ticket is unreachable through this flow
  // (loadLiveTicket 404s archived docs) — the listing's
  // archiveState=archived slice is the explicit way to view them.
  const archived = await archiveTicketRecord(workspaceId, ticketObjectId, new Date());
  if (archived === null) throw AppError.notFound(TICKET_NOT_FOUND);

  recordTicketAudit({
    action: TICKET_AUDIT_ACTIONS.archived,
    workspaceId,
    actorId: new Types.ObjectId(context.actorId),
    ticketId: archived._id.toHexString(),
  });

  return toTicketDto(archived);
}
