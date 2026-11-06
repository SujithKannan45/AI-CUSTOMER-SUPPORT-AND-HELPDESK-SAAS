import type { Request } from 'express';
import { Types } from 'mongoose';

import { env } from '../../config/env.config.js';
import { AppError } from '../../core/errors/app-error.js';
import { logger } from '../../core/logger/logger.js';
import type { AgentAbstentionReason } from '../agent/agent.types.js';
import { AuditLogModel } from '../audit-logs/audit-log.model.js';
import { findConversationInWorkspace } from '../conversations/conversation.repository.js';
import { isWorkspacePrivilegedRole, roleHasPermission, WORKSPACE_PERMISSIONS } from '../rbac/rbac.permissions.js';
import { findTicketInWorkspace, updateTicketStatus } from '../tickets/ticket.repository.js';
import {
  isValidTicketTransition,
  type TicketDocument,
} from '../tickets/ticket.types.js';
import { getMembership } from '../workspaces/workspace.service.js';
import { hasAtLeastRole, type WorkspaceRole } from '../workspaces/workspace.types.js';

import {
  ESCALATION_AUDIT_ACTIONS,
  recordEscalationAudit,
} from './escalation-audit.js';
import {
  toEscalationDto,
  toEscalationHistoryDto,
  toEscalationListPayload,
  type EscalationCreatedPayload,
  type EscalationDetailPayload,
  type EscalationHistoryPayload,
  type EscalationListPayload,
} from './escalation.dto.js';
import { publishEscalationEvent } from './escalation.events.js';
import {
  createActiveEscalationRaceSafe,
  findActiveEscalationByConversation,
  findEscalationInWorkspace,
  listEscalations,
  transitionEscalation,
} from './escalation.repository.js';
import {
  decideEscalationTrigger,
  escalationPolicyFromEnv,
  repeatedFailureTrigger,
  shouldEscalateRepeatedFailure,
  type AgentInteractionOutcome,
} from './escalation.rules.js';
import {
  type EscalationDocument,
  type EscalationHistoryEntry,
  type EscalationPriority,
  type EscalationStatus,
} from './escalation.types.js';
import type {
  AssignEscalationInput,
  CancelEscalationInput,
  CreateEscalationInput,
  ListEscalationsQuery,
  ResolveEscalationInput,
} from './escalation.validation.js';

/**
 * Escalation business flows (Prompt 15) — controllers stay thin; authorization
 * has ALREADY run in middleware, and this layer adds ownership, lifecycle and
 * routing rules.
 *
 * Isolation law: the workspace ALWAYS comes from the validated middleware
 * context; every reference (conversation, ticket, assignee) is resolved
 * through its own module's workspace-scoped lookup, so foreign ids read as
 * not-found and nothing here can cross tenants. The AI model NEVER decides
 * any of this: trigger signals are measured application facts, reasons are
 * machine codes validated server-side, and assignment is a staff action.
 *
 * Duplicate law: at most ONE ACTIVE escalation per conversation (partial
 * unique index). Concurrent triggers lose safely against the index and
 * re-use the winner with `created: false` — repeated requests and racing
 * triggers can neither fabricate a second handoff nor report one that
 * failed to persist.
 *
 * Lifecycle law: every status change is a scoped `findOneAndUpdate` whose
 * filter pins the CURRENT status, and the transition map
 * (`escalation.types.ts`) is the only admitted move — invalid transitions
 * are 409 with the allowed targets. Terminal states accept nothing.
 *
 * Consistency (documented honestly — NO multi-document transactions in this
 * deployment): the escalation record is the source of truth of a handoff;
 * the ticket status side-effect is a separate best-effort write that follows
 * the ticket module's OWN transition law and is audited (including skipped
 * transitions) — a failed ticket write never makes the escalation itself
 * roll back or lie about success. Event publication happens only AFTER the
 * escalation persisted, is fire-safe, and claims no delivery guarantees.
 * Audit appends are fire-and-forget (same convention as every module).
 */

const ESCALATION_NOT_FOUND = 'Escalation not found';
const CONVERSATION_NOT_FOUND = 'Conversation not found';
const TICKET_NOT_FOUND = 'Ticket not found';

export interface EscalationRequestContext {
  /** Validated workspace context id (middleware-loaded), hex string. */
  readonly workspaceId: string;
  /** Authenticated actor (identity + caps), hex string — never a client field. */
  readonly actorId: string;
  /** Effective role from the validated membership. */
  readonly role: WorkspaceRole;
}

// ── Shared validation helpers ────────────────────────────────────────────────

/** Loads a LIVE conversation and its LIVE ticket in the workspace (404 otherwise). */
async function requireLiveConversationWithTicket(
  workspaceId: Types.ObjectId,
  conversationId: string,
): Promise<{ conversationId: Types.ObjectId; ticketId: Types.ObjectId; customerId: Types.ObjectId }> {
  const conversation = await findConversationInWorkspace(workspaceId, new Types.ObjectId(conversationId));
  if (conversation === null) throw AppError.notFound(CONVERSATION_NOT_FOUND);

  const ticket = await findTicketInWorkspace(workspaceId, conversation.ticketId);
  if (ticket === null) throw AppError.notFound(TICKET_NOT_FOUND);

  return {
    conversationId: conversation._id,
    ticketId: conversation.ticketId,
    customerId: conversation.customerId,
  };
}

/** Same eligibility as ticket assignment: an ACTIVE desk member of THIS workspace. */
async function requireWorkspaceAssignee(
  workspaceId: Types.ObjectId,
  assigneeId: string,
): Promise<void> {
  const membership = await getMembership(workspaceId.toHexString(), assigneeId);
  if (membership === null || membership.status !== 'active' || !hasAtLeastRole(membership.role, 'agent')) {
    // One response for foreign/non-member/ineligible assignees — no oracle.
    throw AppError.validation('Assignee must be an active agent, admin or owner of this workspace');
  }
}

function transitionError(from: EscalationStatus, to: EscalationStatus): AppError {
  return new AppError(`Cannot change escalation status from ${from} to ${to}`, {
    statusCode: 409,
    code: 'INVALID_ESCALATION_TRANSITION',
    details: { from, to },
  });
}

function historyEntry(
  action: EscalationHistoryEntry['action'],
  actorType: 'STAFF' | 'AI_AGENT',
  actorId: Types.ObjectId | null,
  detail?: string,
): EscalationHistoryEntry {
  return {
    action,
    at: new Date(),
    actorType,
    actorId, // null for AI decisions — EscalationHistoryEntry requires an explicit null
    ...(detail !== undefined && detail.length > 0 ? { detail } : {}),
  };
}

/**
 * Best-effort ticket side-effect following the ticket module's OWN lifecycle
 * law. The escalation remains the source of truth; a skipped/failed ticket
 * write is audited and logged, never masked as success or failure.
 */
async function transitionEscalatedTicket(
  workspaceId: Types.ObjectId,
  ticketId: Types.ObjectId,
  target: 'IN_PROGRESS' | 'RESOLVED',
  actorId: Types.ObjectId | null,
  escalationId: string,
): Promise<void> {
  try {
    const ticket: TicketDocument | null = await findTicketInWorkspace(workspaceId, ticketId);
    if (ticket === null) {
      recordEscalationAudit({
        action: ESCALATION_AUDIT_ACTIONS.ticketTransitionSkipped,
        workspaceId,
        actorId,
        escalationId,
        metadata: { reason: 'TICKET_NOT_FOUND', target },
      });
      return;
    }
    if (ticket.status === target) return; // already there — nothing to audit
    if (!isValidTicketTransition(ticket.status, target)) {
      recordEscalationAudit({
        action: ESCALATION_AUDIT_ACTIONS.ticketTransitionSkipped,
        workspaceId,
        actorId,
        escalationId,
        metadata: { reason: 'INVALID_TICKET_TRANSITION', from: ticket.status, target },
      });
      return;
    }
    const updated = await updateTicketStatus(workspaceId, ticketId, { status: target });
    if (updated === null) {
      recordEscalationAudit({
        action: ESCALATION_AUDIT_ACTIONS.ticketTransitionSkipped,
        workspaceId,
        actorId,
        escalationId,
        metadata: { reason: 'UPDATE_LOST_RACE', target },
      });
      return;
    }
    recordEscalationAudit({
      action: ESCALATION_AUDIT_ACTIONS.ticketTransitioned,
      workspaceId,
      actorId,
      escalationId,
      metadata: { ticketId: ticketId.toHexString(), from: ticket.status, to: target },
    });
    void logger.info({ escalationId, ticketId: ticketId.toHexString(), to: target }, 'escalated ticket transitioned');
  } catch (error: unknown) {
    // Side effect must never undo the escalation (documented partial failure).
    logger.error({ err: error, escalationId }, 'escalated ticket transition failed');
    recordEscalationAudit({
      action: ESCALATION_AUDIT_ACTIONS.ticketTransitionSkipped,
      workspaceId,
      actorId,
      escalationId,
      metadata: { reason: 'TRANSITION_ERROR', target },
    });
  }
}

// ── Creation ─────────────────────────────────────────────────────────────────

/** Shared creation path used by manual and automatic escalations. */
async function materializeEscalation(args: {
  workspaceId: Types.ObjectId;
  payload: {
    conversationId: Types.ObjectId;
    ticketId: Types.ObjectId;
    customerId: Types.ObjectId;
  };
  triggerType: Parameters<typeof createActiveEscalationRaceSafe>[1]['triggerType'];
  reasonCode: string;
  topicKey: string | null;
  priority: EscalationPriority;
  initiator: { actorType: 'STAFF' | 'AI_AGENT'; actorId: Types.ObjectId | null };
  history: readonly EscalationHistoryEntry[];
  actorId: Types.ObjectId;
  request?: Request;
}): Promise<{ escalation: EscalationDocument; created: boolean }> {
  const { escalation, created } = await createActiveEscalationRaceSafe(args.workspaceId, {
    conversationId: args.payload.conversationId,
    ticketId: args.payload.ticketId,
    customerId: args.payload.customerId,
    triggerType: args.triggerType,
    reasonCode: args.reasonCode,
    topicKey: args.topicKey,
    priority: args.priority,
    initiatedBy: args.initiator,
    history: args.history,
  });

  if (created) {
    // Persist → audit → publish (the escalation document is the durable state
    // of the handoff; events and audit never replace it).
    recordEscalationAudit({
      action: ESCALATION_AUDIT_ACTIONS.created,
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      escalationId: escalation._id.toHexString(),
      metadata: {
        triggerType: args.triggerType,
        reasonCode: args.reasonCode,
        ...(args.topicKey !== null ? { topicKey: args.topicKey } : {}),
        priority: args.priority,
        ticketId: args.payload.ticketId.toHexString(),
        conversationId: args.payload.conversationId.toHexString(),
      },
      ...(args.request !== undefined ? { request: args.request } : {}),
    });
    await transitionEscalatedTicket(
      args.workspaceId,
      args.payload.ticketId,
      'IN_PROGRESS',
      args.initiator.actorType === 'STAFF' ? args.initiator.actorId : args.actorId,
      escalation._id.toHexString(),
    );
    publishEscalationEvent({
      type: 'escalation.created',
      workspaceId: args.workspaceId.toHexString(),
      escalationId: escalation._id.toHexString(),
      conversationId: args.payload.conversationId.toHexString(),
      ticketId: args.payload.ticketId.toHexString(),
      triggerType: args.triggerType,
      priority: args.priority,
      // Self-notification suppression only (not authorization).
      actorId: args.initiator.actorId?.toHexString() ?? null,
    });
  }

  return { escalation, created };
}

/**
 * Manual staff escalation (Prompt 15 §3F). Requires an EXISTING live
 * conversation (the handoff unit); its ticket relationship is validated, not
 * accepted from the client.
 */
export async function createManualEscalationFlow(
  context: EscalationRequestContext,
  input: CreateEscalationInput,
  request?: Request,
): Promise<EscalationCreatedPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);

  const { conversationId, ticketId, customerId } = await requireLiveConversationWithTicket(
    workspaceId,
    input.conversationId,
  );

  const { escalation, created } = await materializeEscalation({
    workspaceId,
    payload: { conversationId, ticketId, customerId },
    triggerType: 'MANUAL',
    reasonCode: 'MANUAL',
    topicKey: null,
    priority: input.priority ?? env.ESCALATION_DEFAULT_PRIORITY,
    initiator: { actorType: 'STAFF', actorId },
    history: [
      historyEntry(
        'escalation.created',
        'STAFF',
        actorId,
        input.note === undefined ? undefined : input.note,
      ),
    ],
    actorId,
    request,
  });

  return { escalation: toEscalationDto(escalation), created };
}

// ── Agent-driven triggers (Prompt 14 integration) ────────────────────────────

export interface AgentEscalationSignal {
  readonly workspaceId: Types.ObjectId;
  /** The conversation the AI just served (the handoff unit). */
  readonly conversationId: Types.ObjectId;
  /** The authenticated staff member whose ask triggered the flow (traceability). */
  readonly actorId: Types.ObjectId;
  /** The bounded, validated question text — the ONLY text keyword rules see. */
  readonly question: string;
  readonly outcome: AgentInteractionOutcome;
  readonly request?: Request;
}

/**
 * Counts THIS conversation's IMMEDIATELY PRECEDING unsuccessful AI
 * interactions from the content-free audit trail (agent_response rows carry
 * the outcome codes; the CURRENT interaction's audit row is written AFTER
 * this hook runs, so it is naturally excluded). Zero when the trail does not
 * show a full run of consecutive unsuccessful asks inside the window.
 */
async function countRecentUnsuccessful(
  workspaceId: Types.ObjectId,
  conversationId: Types.ObjectId,
  threshold: number,
): Promise<number> {
  const need = threshold - 1; // the current interaction completes the run
  if (need < 1) return 0;
  const windowStart = new Date(Date.now() - env.ESCALATION_FAILURE_WINDOW_HOURS * 3_600_000);
  const rows = await AuditLogModel.find({
    workspaceId,
    resourceType: 'agent_response',
    resourceId: conversationId.toHexString(),
    action: { $in: ['agent.question_answered', 'agent.question_failed'] },
    createdAt: { $gte: windowStart },
  })
    .sort({ createdAt: -1 })
    .limit(need)
    .select('action metadata')
    .lean<readonly { action: string; metadata?: Record<string, unknown> }[]>()
    .exec();
  if (rows.length < need) return 0;
  const allUnsuccessful = rows.every((row) =>
    row.action === 'agent.question_failed' || (row.metadata?.['outcome'] as string | undefined) !== 'ANSWERED',
  );
  return allUnsuccessful ? need : 0;
}

/**
 * The Prompt 14 ↔ Prompt 15 integration hook — called by the agent service
 * for every conversation-scoped ask, with the MEASURED interaction outcome.
 * Decides (pure rules) and creates (race-safe) the escalation; adds its own
 * fire-safe finally so a trigger evaluation failure can never corrupt the
 * agent's already-computed answer or a provider error path.
 */
export async function noteAgentInteraction(signal: AgentEscalationSignal): Promise<void> {
  try {
    const policy = escalationPolicyFromEnv();
    const planned = decideEscalationTrigger(signal.question, signal.outcome, policy);

    // Repeated-failure rule overrides single-shot reasons when the audit
    // trail shows a full run of consecutive unsuccessful asks.
    if (shouldEscalateRepeatedFailure(signal.outcome.kind !== 'ANSWERED', await countRecentUnsuccessful(
      signal.workspaceId,
      signal.conversationId,
      policy.repeatedFailureThreshold,
    ), policy)) {
      const repeated = repeatedFailureTrigger(policy);
      await materializeEscalation({
        workspaceId: signal.workspaceId,
        payload: await requireLiveConversationWithTicket(
          signal.workspaceId,
          signal.conversationId.toHexString(),
        ),
        triggerType: repeated.triggerType,
        reasonCode: repeated.reasonCode,
        topicKey: null,
        priority: repeated.priority,
        initiator: { actorType: 'AI_AGENT', actorId: signal.actorId },
        history: [historyEntry('escalation.created', 'AI_AGENT', null, repeated.reasonCode)],
        actorId: signal.actorId,
        request: signal.request,
      });
      return;
    }

    if (planned === null) return;

    await materializeEscalation({
      workspaceId: signal.workspaceId,
      payload: await requireLiveConversationWithTicket(
        signal.workspaceId,
        signal.conversationId.toHexString(),
      ),
      triggerType: planned.triggerType,
      reasonCode: planned.reasonCode,
      topicKey: planned.topicKey,
      priority: planned.priority,
      initiator: { actorType: 'AI_AGENT', actorId: signal.actorId },
      history: [historyEntry('escalation.created', 'AI_AGENT', null, planned.reasonCode)],
      actorId: signal.actorId,
      request: signal.request,
    });
  } catch (error: unknown) {
    // Fire-safe: a trigger failure is logged, never propagated into the
    // agent response (the ask itself has already completed its work).
    if (error instanceof AppError && error.statusCode === 404) {
      // Foreign/vanished conversation: nothing to attach an escalation to.
      return;
    }
    logger.error({ err: error }, 'escalation trigger evaluation failed');
  }
}

/**
 * The active handoff marker for one conversation (agent pause gate). Kept in
 * the escalation module so the agent depends on the service boundary, not on
 * repository internals.
 */
export async function getActiveHandoff(
  workspaceId: Types.ObjectId,
  conversationId: Types.ObjectId,
): Promise<{ escalationId: string; status: EscalationStatus } | null> {
  const active = await findActiveEscalationByConversation(workspaceId, conversationId);
  if (active === null) return null;
  return { escalationId: active._id.toHexString(), status: active.status };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listEscalationsFlow(
  context: EscalationRequestContext,
  query: ListEscalationsQuery,
): Promise<EscalationListPayload> {
  const result = await listEscalations({
    workspaceId: new Types.ObjectId(context.workspaceId),
    page: query.page,
    limit: query.limit,
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.priority !== undefined ? { priority: query.priority } : {}),
    ...(query.triggerType !== undefined ? { triggerType: query.triggerType } : {}),
    ...(query.assignedToId !== undefined ? { eligibleAssigneeId: new Types.ObjectId(query.assignedToId) } : {}),
  });
  return toEscalationListPayload(result, query);
}

async function requireEscalation(
  context: EscalationRequestContext,
  escalationId: string,
): Promise<EscalationDocument> {
  const escalation = await findEscalationInWorkspace(
    new Types.ObjectId(context.workspaceId),
    new Types.ObjectId(escalationId),
  );
  if (escalation === null) throw AppError.notFound(ESCALATION_NOT_FOUND);
  return escalation;
}

export async function getEscalationFlow(
  context: EscalationRequestContext,
  escalationId: string,
): Promise<EscalationDetailPayload> {
  return { escalation: toEscalationDto(await requireEscalation(context, escalationId)) };
}

export async function getEscalationHistoryFlow(
  context: EscalationRequestContext,
  escalationId: string,
): Promise<EscalationHistoryPayload> {
  const escalation = await requireEscalation(context, escalationId);
  return { history: toEscalationHistoryDto(escalation) };
}

// ── Assignment ───────────────────────────────────────────────────────────────

/**
 * Assignment/reassignment — an authorized-staff action
 * (`ticket.assign` permission: owner/admin, the same grant the tickets use
 * for assignment). The assignee must be an ACTIVE desk member of THIS
 * workspace (validated here, never optional: the queue is the only
 * unassigned state and moving an escalated conversation back to the queue is
 * not a route (cancellation covers withdrawing a handoff).
 * Re-assigning an ACCEPTED escalation resets its acceptance — the new
 * assignee must accept again (work-ownership resets).
 */
export async function assignEscalationFlow(
  context: EscalationRequestContext,
  escalationId: string,
  input: AssignEscalationInput,
  request?: Request,
): Promise<EscalationDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);

  if (!roleHasPermission(context.role, WORKSPACE_PERMISSIONS.assignTicket)) {
    throw AppError.forbidden('Only owners and administrators may assign escalations');
  }
  await requireWorkspaceAssignee(workspaceId, input.assigneeId);
  const assigneeId = new Types.ObjectId(input.assigneeId);

  const escalation = await requireEscalation(context, escalationId);

  // Idempotent: assigning the same staff member twice changes nothing.
  if (escalation.status === 'ASSIGNED' && escalation.eligibleAssigneeId?.equals(assigneeId) === true) {
    return { escalation: toEscalationDto(escalation) };
  }

  const isReassign = escalation.eligibleAssigneeId !== null;
  // PENDING→ASSIGNED (queue placement), ASSIGNED→ASSIGNED (triage move of an
  // unaccepted record — the idempotent same-assignee no-op is handled above)
  // and ACCEPTED→ASSIGNED (reassign out of accepted work) are all map-legal;
  // reassigning an ACCEPTED record clears the previous acceptance stamp
  // (fresh work ownership). Terminal states cannot receive work at all.
  if (escalation.status === 'RESOLVED' || escalation.status === 'CANCELLED') {
    throw transitionError(escalation.status, 'ASSIGNED');
  }
  const updated = await transitionEscalation(workspaceId, escalation._id, escalation.status, {
    status: 'ASSIGNED',
    expectedVersion: escalation.__v, // optimistic guard — same-status races write-conflict
    eligibleAssigneeId: assigneeId,
    acceptedById: null, // fresh work ownership for the new assignee
    historyEntry: historyEntry(
      isReassign ? 'escalation.reassigned' : 'escalation.assigned',
      'STAFF',
      actorId,
      assigneeId.toHexString(),
    ),
  });
  if (updated === null) {
    throw new AppError('Escalation state changed concurrently, retry', {
      statusCode: 409,
      code: 'ESCALATION_CONCURRENT_CHANGE',
    });
  }

  recordEscalationAudit({
    action: isReassign ? ESCALATION_AUDIT_ACTIONS.reassigned : ESCALATION_AUDIT_ACTIONS.assigned,
    workspaceId,
    actorId,
    escalationId: updated._id.toHexString(),
    metadata: {
      to: assigneeId.toHexString(),
      from: escalation.eligibleAssigneeId?.toHexString() ?? null,
    },
    ...(request !== undefined ? { request } : {}),
  });
  publishEscalationEvent({
    type: isReassign ? 'escalation.reassigned' : 'escalation.assigned',
    workspaceId: context.workspaceId,
    escalationId: updated._id.toHexString(),
    conversationId: updated.conversationId.toHexString(),
    assigneeId: assigneeId.toHexString(),
    actorId: context.actorId,
  });

  return { escalation: toEscalationDto(updated) };
}

/**
 * Acceptance — the assignee claims the work (ASSIGNED), or an eligible desk
 * member pulls it straight from the queue (PENDING → self-assignment).
 * Already-accepted escalations are idempotent no-ops for their owner.
 */
export async function acceptEscalationFlow(
  context: EscalationRequestContext,
  escalationId: string,
  request?: Request,
): Promise<EscalationDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);

  const escalation = await requireEscalation(context, escalationId);

  if (escalation.status === 'ACCEPTED') {
    if (escalation.acceptedById?.equals(actorId) || isWorkspacePrivilegedRole(context.role)) {
      return { escalation: toEscalationDto(escalation) };
    }
    throw new AppError('Escalation is already accepted by another staff member', {
      statusCode: 409,
      code: 'ESCALATION_CONCURRENT_CHANGE',
    });
  }

  if (escalation.status === 'ASSIGNED') {
    // Only the CURRENT assignee may accept (privileged staff reassign instead).
    if (escalation.eligibleAssigneeId === null || !escalation.eligibleAssigneeId.equals(actorId)) {
      throw AppError.forbidden('Only the assigned staff member may accept this escalation');
    }
  } else if (escalation.status !== 'PENDING') {
    throw transitionError(escalation.status, 'ACCEPTED');
  }

  const updated = await transitionEscalation(workspaceId, escalation._id, escalation.status, {
    status: 'ACCEPTED',
    expectedVersion: escalation.__v, // optimistic guard — same-status races write-conflict
    // Pulling from the queue assigns the accepter; an assigned accept keeps
    // its assignee (which the filter above proved equals the actor).
    eligibleAssigneeId: escalation.status === 'PENDING' ? actorId : escalation.eligibleAssigneeId,
    acceptedById: actorId,
    resolvedById: null,
    resolvedAt: null,
    resolutionNote: null,
    cancelledById: null,
    cancelledAt: null,
    cancelReason: null,
    historyEntry: historyEntry('escalation.accepted', 'STAFF', actorId),
  });
  if (updated === null) {
    throw new AppError('Escalation state changed concurrently, retry', {
      statusCode: 409,
      code: 'ESCALATION_CONCURRENT_CHANGE',
    });
  }

  recordEscalationAudit({
    action: ESCALATION_AUDIT_ACTIONS.accepted,
    workspaceId,
    actorId,
    escalationId: updated._id.toHexString(),
    ...(request !== undefined ? { request } : {}),
  });
  publishEscalationEvent({
    type: 'escalation.accepted',
    workspaceId: context.workspaceId,
    escalationId: updated._id.toHexString(),
    conversationId: updated.conversationId.toHexString(),
    acceptedById: actorId.toHexString(),
    actorId: context.actorId,
  });

  return { escalation: toEscalationDto(updated) };
}

// ── Conclusion ───────────────────────────────────────────────────────────────

/**
 * Resolution — the acceptee (or an administrator) concludes the handoff. The
 * ticket side-effect transitions the ticket to RESOLVED following the ticket
 * lifecycle law (best-effort, audited; see `transitionEscalatedTicket`).
 * Resolution keeps its original stamp on a repeated same-note request.
 */
export async function resolveEscalationFlow(
  context: EscalationRequestContext,
  escalationId: string,
  input: ResolveEscalationInput,
  request?: Request,
): Promise<EscalationDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);

  const escalation = await requireEscalation(context, escalationId);

  if (escalation.status === 'RESOLVED') {
    // Idempotent same-conclusion; a DIFFERENT note means a second, distinct
    // resolution claim — rejected rather than silently overwriting history.
    if (input.resolutionNote === undefined || input.resolutionNote === escalation.resolutionNote) {
      return { escalation: toEscalationDto(escalation) };
    }
    throw new AppError('Escalation is already resolved', {
      statusCode: 409,
      code: 'ESCALATION_CONCURRENT_CHANGE',
    });
  }
  if (escalation.status !== 'ACCEPTED') {
    throw transitionError(escalation.status, 'RESOLVED');
  }
  const privileged = isWorkspacePrivilegedRole(context.role);
  const isAssignee = escalation.acceptedById?.equals(actorId) === true;
  if (!privileged && !isAssignee) {
    throw AppError.forbidden('Only the accepting staff member (or an administrator) may resolve this escalation');
  }

  const updated = await transitionEscalation(workspaceId, escalation._id, 'ACCEPTED', {
    status: 'RESOLVED',
    expectedVersion: escalation.__v, // optimistic guard — same-status races write-conflict
    resolvedById: actorId,
    resolvedAt: new Date(),
    resolutionNote: input.resolutionNote ?? null,
    historyEntry: historyEntry('escalation.resolved', 'STAFF', actorId),
  });
  if (updated === null) {
    throw new AppError('Escalation state changed concurrently, retry', {
      statusCode: 409,
      code: 'ESCALATION_CONCURRENT_CHANGE',
    });
  }

  recordEscalationAudit({
    action: ESCALATION_AUDIT_ACTIONS.resolved,
    workspaceId,
    actorId,
    escalationId: updated._id.toHexString(),
    ...(request !== undefined ? { request } : {}),
  });
  await transitionEscalatedTicket(workspaceId, escalation.ticketId, 'RESOLVED', actorId, updated._id.toHexString());
  publishEscalationEvent({
    type: 'escalation.resolved',
    workspaceId: context.workspaceId,
    escalationId: updated._id.toHexString(),
    conversationId: updated.conversationId.toHexString(),
    actorId: context.actorId,
  });

  return { escalation: toEscalationDto(updated) };
}

/**
 * Cancellation — withdraw a handoff (mistake/duplicate/requester resolved
 * directly). Eligible: the current assignee, the original acceptee, the
 * initiator of record, or an administrator. The ticket is left untouched.
 */
export async function cancelEscalationFlow(
  context: EscalationRequestContext,
  escalationId: string,
  input: CancelEscalationInput,
  request?: Request,
): Promise<EscalationDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);

  const escalation = await requireEscalation(context, escalationId);

  if (escalation.status === 'CANCELLED') {
    return { escalation: toEscalationDto(escalation) }; // idempotent
  }
  if (escalation.status === 'RESOLVED') {
    throw transitionError(escalation.status, 'CANCELLED');
  }
  const privileged = isWorkspacePrivilegedRole(context.role);
  const involved =
    escalation.eligibleAssigneeId?.equals(actorId) === true ||
    escalation.acceptedById?.equals(actorId) === true ||
    escalation.initiatedBy.actorId?.equals(actorId) === true;
  if (!privileged && !involved) {
    throw AppError.forbidden('Only involved staff (or an administrator) may cancel this escalation');
  }

  const updated = await transitionEscalation(workspaceId, escalation._id, escalation.status, {
    status: 'CANCELLED',
    expectedVersion: escalation.__v, // optimistic guard — same-status races write-conflict
    cancelledById: actorId,
    cancelledAt: new Date(),
    cancelReason: input.reason ?? null,
    historyEntry: historyEntry('escalation.cancelled', 'STAFF', actorId),
  });
  if (updated === null) {
    throw new AppError('Escalation state changed concurrently, retry', {
      statusCode: 409,
      code: 'ESCALATION_CONCURRENT_CHANGE',
    });
  }

  recordEscalationAudit({
    action: ESCALATION_AUDIT_ACTIONS.cancelled,
    workspaceId,
    actorId,
    escalationId: updated._id.toHexString(),
    ...(request !== undefined ? { request } : {}),
  });
  publishEscalationEvent({
    type: 'escalation.cancelled',
    workspaceId: context.workspaceId,
    escalationId: updated._id.toHexString(),
    conversationId: updated.conversationId.toHexString(),
    actorId: context.actorId,
  });

  return { escalation: toEscalationDto(updated) };
}

/** Re-export for the controller's request plumbing (no state, additive only). */
export type { AgentAbstentionReason };
