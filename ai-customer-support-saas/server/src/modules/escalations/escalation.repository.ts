import { type FilterQuery, type Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import { assertTenantScope, tenantFilter } from '../../database/tenant.js';

import {
  isDuplicateActiveEscalationError,
  MAX_ESCALATION_HISTORY_ENTRIES,
  EscalationModel,
} from './escalation.model.js';
import {
  ACTIVE_ESCALATION_STATUSES,
  type EscalationDocument,
  type EscalationHistoryEntry,
  type EscalationInitiator,
  type EscalationPriority,
  type EscalationStatus,
  type EscalationTriggerType,
} from './escalation.types.js';

/**
 * Escalation persistence layer — the ONLY module that touches the
 * `escalations` collection, mirroring the conversation/ticket repository
 * conventions:
 *
 * - EVERY query is built through `tenantFilter()` and asserted with
 *   `assertTenantScope()`. Foreign ids read as not-found; no caller can
 *   fetch "an escalation id" without the workspace scope.
 * - The at-most-one-ACTIVE-escalation-per-conversation rule is the partial
 *   unique index's job; creation races reuse the winner (see
 *   `createActiveEscalationRaceSafe`).
 * - Every lifecycle mutation is a SCOPED `findOneAndUpdate` with the
 *   transition's expected current status in the filter (the state-machine
 *   check happens at WRITE time — the concurrency guard), so no
 *   read-then-write windows exist. `null` result = the transition lost
 *   (concurrently moved/terminal), surfaced as 409 by the service.
 * - This deployment does NOT support multi-document transactions
 *   (standalone MongoDB); the escalation record is document-atomic, and
 *   the ticket side-effect is a separate best-effort write documented in
 *   escalation.service.ts — no transaction is claimed anywhere.
 */

/** Creation arguments — all references already validated by the service. */
export interface EscalationCreateArgs {
  readonly conversationId: Types.ObjectId;
  readonly ticketId: Types.ObjectId;
  readonly customerId: Types.ObjectId;
  readonly triggerType: EscalationTriggerType;
  readonly reasonCode: string;
  readonly topicKey: string | null;
  readonly priority: EscalationPriority;
  readonly initiatedBy: {
    readonly actorType: EscalationInitiator;
    readonly actorId: Types.ObjectId | null;
  };
  readonly history: readonly EscalationHistoryEntry[];
}

export async function createEscalation(
  workspaceId: Types.ObjectId,
  record: EscalationCreateArgs,
): Promise<EscalationDocument> {
  return EscalationModel.create({
    ...tenantFilter(workspaceId),
    conversationId: record.conversationId,
    ticketId: record.ticketId,
    customerId: record.customerId,
    triggerType: record.triggerType,
    reasonCode: record.reasonCode,
    topicKey: record.topicKey,
    priority: record.priority,
    status: 'PENDING',
    initiatedBy: record.initiatedBy,
    history: [...record.history],
  });
}

/**
 * Duplicate-safe creation over the partial-unique active index: a duplicate
 * key on the active scope re-reads the WINNING active escalation and returns
 * it with `created: false` (never fabricates a "successful" second record).
 * Any OTHER duplicate key is a programming error and rethrows untouched.
 */
export async function createActiveEscalationRaceSafe(
  workspaceId: Types.ObjectId,
  record: EscalationCreateArgs,
): Promise<{ escalation: EscalationDocument; created: boolean }> {
  try {
    const createdDocument = await createEscalation(workspaceId, record);
    return { escalation: createdDocument, created: true };
  } catch (error) {
    if (!isDuplicateActiveEscalationError(error)) {
      throw error;
    }
    const winner = await findActiveEscalationByConversation(workspaceId, record.conversationId);
    if (winner === null) {
      throw new AppError('Escalation uniqueness race could not be resolved', {
        statusCode: 500,
        code: 'ESCALATION_RACE_UNRESOLVED',
        isOperational: false,
      });
    }
    return { escalation: winner, created: false };
  }
}

/** Finds ONE escalation by id, scoped to its workspace. */
export async function findEscalationInWorkspace(
  workspaceId: Types.ObjectId,
  escalationId: Types.ObjectId,
): Promise<EscalationDocument | null> {
  const filter: FilterQuery<EscalationDocument> = {
    ...tenantFilter(workspaceId),
    _id: escalationId,
  };
  assertTenantScope(filter, 'findEscalationInWorkspace');
  return EscalationModel.findOne(filter);
}

/**
 * The active handoff marker for a conversation — the read Prompt 14's agent
 * uses to pause AI answers after human ownership is established ("AI
 * responses paused after human handoff"). Scoped reads, no existence oracle.
 */
export async function findActiveEscalationByConversation(
  workspaceId: Types.ObjectId,
  conversationId: Types.ObjectId,
): Promise<EscalationDocument | null> {
  const filter: FilterQuery<EscalationDocument> = {
    ...tenantFilter(workspaceId),
    conversationId,
    status: { $in: [...ACTIVE_ESCALATION_STATUSES] as readonly string[] },
  };
  assertTenantScope(filter, 'findActiveEscalationByConversation');
  // Newest-wins is a defensive tiebreak only: the partial-unique index makes
  // active multiplicity impossible, so this returns at most one row anyway.
  return EscalationModel.findOne(filter).sort({ createdAt: -1, _id: -1 });
}

export interface EscalationListSpec {
  readonly workspaceId: Types.ObjectId;
  readonly page: number;
  readonly limit: number;
  readonly status?: EscalationStatus;
  readonly priority?: EscalationPriority;
  readonly triggerType?: EscalationTriggerType;
  readonly eligibleAssigneeId?: Types.ObjectId | null;
}

export interface EscalationListResult {
  readonly items: readonly EscalationDocument[];
  readonly total: number;
  readonly hasMore: boolean;
}

/** Queue/inbox listing, fully database-side (same pagination contract as tickets). */
export async function listEscalations(spec: EscalationListSpec): Promise<EscalationListResult> {
  const filter: FilterQuery<EscalationDocument> = {
    ...tenantFilter(spec.workspaceId),
  };
  if (spec.status !== undefined) filter['status'] = spec.status;
  if (spec.priority !== undefined) filter['priority'] = spec.priority;
  if (spec.triggerType !== undefined) filter['triggerType'] = spec.triggerType;
  if (spec.eligibleAssigneeId !== undefined) {
    filter['eligibleAssigneeId'] = spec.eligibleAssigneeId;
  }
  assertTenantScope(filter, 'listEscalations');

  const [items, total] = await Promise.all([
    EscalationModel.find(filter)
      .sort({ priorityRank: -1, createdAt: -1, _id: 1 })
      .skip((spec.page - 1) * spec.limit)
      .limit(spec.limit),
    EscalationModel.countDocuments(filter),
  ]);

  return { items, total, hasMore: spec.page * spec.limit < total };
}

/**
 * Guards every lifecycle mutation: the update ONLY lands when the document
 * is still in `fromStatus` — losing races (a concurrent assignment, an
 * already-resolved record) return null and become 409s at the service layer.
 * `expectedVersion` adds the OPTIMISTIC-CONCURRENCY guard the module
 * documents: pinning the state the service re-read (`__v`) makes even
 * same-status races (two concurrent ASSIGNED triage reassignments)
 * atomic — exactly one writer lands, the other returns null → 409. The
 * version bump rides in the SAME atomic write ($inc), so no
 * read-modify-write window is reintroduced.
 */
export async function transitionEscalation(
  workspaceId: Types.ObjectId,
  escalationId: Types.ObjectId,
  fromStatus: EscalationStatus,
  patch: {
    status: EscalationStatus;
    /** The `__v` the service read; pinning it closes the same-status race. */
    expectedVersion?: number;
    /** Lifecycle stamps applied/cleared by the transition (see escalation.service). */
    eligibleAssigneeId?: Types.ObjectId | null;
    acceptedById?: Types.ObjectId | null;
    resolvedById?: Types.ObjectId | null;
    resolvedAt?: Date | null;
    resolutionNote?: string | null;
    cancelledById?: Types.ObjectId | null;
    cancelledAt?: Date | null;
    cancelReason?: string | null;
    priority?: EscalationPriority;
    historyEntry: EscalationHistoryEntry;
  },
): Promise<EscalationDocument | null> {
  const filter: FilterQuery<EscalationDocument> = {
    ...tenantFilter(workspaceId),
    _id: escalationId,
    status: fromStatus,
    ...(patch.expectedVersion !== undefined ? { __v: patch.expectedVersion } : {}),
  };
  assertTenantScope(filter, 'transitionEscalation');

  const set: Record<string, unknown> = { status: patch.status };
  if (patch.eligibleAssigneeId !== undefined) set['eligibleAssigneeId'] = patch.eligibleAssigneeId;
  if (patch.acceptedById !== undefined) set['acceptedById'] = patch.acceptedById;
  if (patch.resolvedById !== undefined) set['resolvedById'] = patch.resolvedById;
  if (patch.resolvedAt !== undefined) set['resolvedAt'] = patch.resolvedAt;
  if (patch.resolutionNote !== undefined) set['resolutionNote'] = patch.resolutionNote;
  if (patch.cancelledById !== undefined) set['cancelledById'] = patch.cancelledById;
  if (patch.cancelledAt !== undefined) set['cancelledAt'] = patch.cancelledAt;
  if (patch.cancelReason !== undefined) set['cancelReason'] = patch.cancelReason;
  if (patch.priority !== undefined) set['priority'] = patch.priority;

  return EscalationModel.findOneAndUpdate(
    filter,
    {
      $set: set,
      $inc: { __v: 1 },
      // Newest-last append; the cap lives in the model hook ($slice mirrors it
      // here so the DB write itself is already bounded).
      $push: { history: { $each: [patch.historyEntry], $slice: -MAX_ESCALATION_HISTORY_ENTRIES } },
    },
    { new: true },
  );
}
