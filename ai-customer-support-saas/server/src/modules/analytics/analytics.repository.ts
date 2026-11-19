import type { PipelineStage, Types } from 'mongoose';

import { AuditLogModel } from '../audit-logs/audit-log.model.js';
import { ConversationModel, MessageModel } from '../conversations/conversation.model.js';
import { CustomerModel } from '../customers/customer.model.js';
import { EscalationModel } from '../escalations/escalation.model.js';
import { KbArticleModel } from '../knowledge-base/kb.model.js';
import { TicketModel } from '../tickets/ticket.model.js';

import type { AnalyticsBucketUnit, TicketReportRow } from './analytics.types.js';
import { MAX_REPORT_ROWS } from './analytics.validation.js';

/**
 * Analytics persistence layer (Prompt 18) — the only place analytics reads
 * MongoDB. Controllers never see a pipeline and services never see a model.
 *
 * Tenant law: EVERY pipeline's FIRST stage is a `$match` carrying the
 * server-derived `workspaceId` (and the window bounds where applicable), so
 * no aggregation can read another tenant's slice. Aggregations bypass Mongoose
 * query hooks (documented Mongoose behaviour), which is why live-record scopes
 * (`deletedAt: null`) are composed EXPLICITLY here instead of relying on the
 * models' pre-query hooks.
 *
 * Correctness law: counts are produced by `$group` over single collections or
 * by a bounded `$lookup` with a verified parent — no `$unwind` fan-out, so no
 * row is counted twice. Bench cost is bounded by the workspace slice, the
 * 366-day window and the per-response caps; no pipeline loads a collection
 * into application memory.
 *
 * Consistency honesty: each call is an independent aggregation. There is no
 * multi-document transaction in this deployment, so a response assembled from
 * several calls is not a cross-collection snapshot.
 */

export interface AnalyticsWindow {
  readonly workspaceId: Types.ObjectId;
  readonly from: Date;
  readonly to: Date;
}

/** UTC-aligned `$dateTrunc` expression (week starts Monday, matching JS). */
function truncatedDate(
  field: string,
  unit: AnalyticsBucketUnit,
): Record<string, unknown> {
  return {
    $dateTrunc: {
      date: `$${field}`,
      unit,
      timezone: 'UTC',
      ...(unit === 'week' ? { startOfWeek: 'monday' } : {}),
    },
  };
}

/** Exact-stage helper keeping the tenant match literally first. */
function windowMatch(window: AnalyticsWindow, extra: Record<string, unknown>): Record<string, unknown> {
  return { workspaceId: window.workspaceId, ...extra };
}

export interface BucketCount {
  readonly _id: Date;
  readonly count: number;
}

// ── Ticket overview ─────────────────────────────────────────────────────────

export interface TicketOverviewAggregation {
  readonly totals: ReadonlyArray<{
    total: number;
    createdInPeriod: number;
    resolvedInPeriod: number;
  }>;
  readonly byStatus: ReadonlyArray<{ _id: string; count: number }>;
  readonly byPriority: ReadonlyArray<{ _id: string; count: number }>;
  readonly assignment: ReadonlyArray<{ _id: string; count: number }>;
  readonly topAssignees: ReadonlyArray<{ _id: Types.ObjectId; count: number }>;
}

export async function aggregateTicketOverview(
  window: AnalyticsWindow,
): Promise<TicketOverviewAggregation> {
  const { from, to } = window;
  const [facet] = await TicketModel.aggregate<TicketOverviewAggregation>([
    { $match: windowMatch(window, { deletedAt: null }) },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              createdInPeriod: {
                $sum: {
                  $cond: [
                    { $and: [{ $gte: ['$createdAt', from] }, { $lt: ['$createdAt', to] }] },
                    1,
                    0,
                  ],
                },
              },
              resolvedInPeriod: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $ne: ['$resolvedAt', null] },
                        { $gte: ['$resolvedAt', from] },
                        { $lt: ['$resolvedAt', to] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        byPriority: [{ $group: { _id: '$priority', count: { $sum: 1 } } }],
        assignment: [
          {
            $group: {
              _id: { $cond: [{ $eq: ['$agentId', null] }, 'unassigned', 'assigned'] },
              count: { $sum: 1 },
            },
          },
        ],
        topAssignees: [
          { $match: { agentId: { $ne: null } } },
          { $group: { _id: '$agentId', count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
          { $limit: 10 },
        ],
      },
    },
  ])
    .option({ allowDiskUse: true })
    .exec();

  return (
    facet ?? {
      totals: [],
      byStatus: [],
      byPriority: [],
      assignment: [],
      topAssignees: [],
    }
  );
}

// ── Backlog (performance) ───────────────────────────────────────────────────

export interface BacklogAggregation {
  readonly totals: ReadonlyArray<{
    open: number;
    inProgress: number;
    waitingForCustomer: number;
    unassigned: number;
  }>;
  readonly byPriority: ReadonlyArray<{ _id: string; count: number }>;
}

/** Live, open-ish tickets (OPEN/IN_PROGRESS/WAITING_FOR_CUSTOMER). */
export async function aggregateTicketBacklog(
  window: AnalyticsWindow,
): Promise<BacklogAggregation> {
  const [facet] = await TicketModel.aggregate<BacklogAggregation>([
    {
      $match: windowMatch(window, {
        deletedAt: null,
        status: { $in: ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER'] },
      }),
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              open: { $sum: { $cond: [{ $eq: ['$status', 'OPEN'] }, 1, 0] } },
              inProgress: { $sum: { $cond: [{ $eq: ['$status', 'IN_PROGRESS'] }, 1, 0] } },
              waitingForCustomer: {
                $sum: { $cond: [{ $eq: ['$status', 'WAITING_FOR_CUSTOMER'] }, 1, 0] },
              },
              unassigned: { $sum: { $cond: [{ $eq: ['$agentId', null] }, 1, 0] } },
            },
          },
        ],
        byPriority: [{ $group: { _id: '$priority', count: { $sum: 1 } } }],
      },
    },
  ])
    .option({ allowDiskUse: true })
    .exec();

  return facet ?? { totals: [], byPriority: [] };
}

// ── Customer overview ───────────────────────────────────────────────────────

export interface CustomerOverviewAggregation {
  readonly totals: ReadonlyArray<{ total: number; newInPeriod: number }>;
  readonly byStatus: ReadonlyArray<{ _id: string; count: number }>;
}

export async function aggregateCustomerOverview(
  window: AnalyticsWindow,
): Promise<CustomerOverviewAggregation> {
  const { from, to } = window;
  const [facet] = await CustomerModel.aggregate<CustomerOverviewAggregation>([
    { $match: windowMatch(window, { deletedAt: null }) },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              newInPeriod: {
                $sum: {
                  $cond: [
                    { $and: [{ $gte: ['$createdAt', from] }, { $lt: ['$createdAt', to] }] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
      },
    },
  ])
    .option({ allowDiskUse: true })
    .exec();

  return facet ?? { totals: [], byStatus: [] };
}

// ── Conversation overview ───────────────────────────────────────────────────

export interface ConversationOverviewAggregation {
  readonly totals: ReadonlyArray<{
    total: number;
    closed: number;
    createdInPeriod: number;
  }>;
}

export async function aggregateConversationOverview(
  window: AnalyticsWindow,
): Promise<ConversationOverviewAggregation> {
  const { workspaceId, from, to } = window;
  const [facet] = await ConversationModel.aggregate<ConversationOverviewAggregation>([
    { $match: { workspaceId } },
    // Parent-ticket verification: a conversation whose ticket is archived (or
    // foreign) is excluded, matching the live-ticket read law.
    {
      $lookup: {
        from: 'tickets',
        let: { ticketId: '$ticketId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$ticketId'] },
                  { $eq: ['$workspaceId', workspaceId] },
                  { $eq: ['$deletedAt', null] },
                ],
              },
            },
          },
          { $project: { status: 1 } },
        ],
        as: 'ticket',
      },
    },
    { $addFields: { ticketStatus: { $arrayElemAt: ['$ticket.status', 0] } } },
    { $match: { ticketStatus: { $ne: null } } },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              // Derivation (documented): conversations inherit the ticket
              // lifecycle; there is no conversation status field.
              closed: {
                $sum: {
                  $cond: [{ $in: ['$ticketStatus', ['RESOLVED', 'CLOSED']] }, 1, 0],
                },
              },
              createdInPeriod: {
                $sum: {
                  $cond: [
                    { $and: [{ $gte: ['$createdAt', from] }, { $lt: ['$createdAt', to] }] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
      },
    },
  ])
    .option({ allowDiskUse: true })
    .exec();

  return facet ?? { totals: [] };
}

// ── Escalation overview ─────────────────────────────────────────────────────

export interface EscalationOverviewAggregation {
  readonly totals: ReadonlyArray<{ total: number; active: number; createdInPeriod: number }>;
  readonly byStatus: ReadonlyArray<{ _id: string; count: number }>;
}

export async function aggregateEscalationOverview(
  window: AnalyticsWindow,
): Promise<EscalationOverviewAggregation> {
  const { from, to } = window;
  const [facet] = await EscalationModel.aggregate<EscalationOverviewAggregation>([
    { $match: { workspaceId: window.workspaceId } },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              active: {
                $sum: {
                  $cond: [
                    { $in: ['$status', ['PENDING', 'ASSIGNED', 'ACCEPTED']] },
                    1,
                    0,
                  ],
                },
              },
              createdInPeriod: {
                $sum: {
                  $cond: [
                    { $and: [{ $gte: ['$createdAt', from] }, { $lt: ['$createdAt', to] }] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
      },
    },
  ])
    .option({ allowDiskUse: true })
    .exec();

  return facet ?? { totals: [], byStatus: [] };
}

// ── Knowledge base overview ─────────────────────────────────────────────────

export async function aggregateKnowledgeBaseStatusCounts(
  workspaceId: Types.ObjectId,
): Promise<ReadonlyArray<{ _id: string; count: number }>> {
  return KbArticleModel.aggregate<{ _id: string; count: number }>([
    { $match: { workspaceId } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
}

// ── Ticket trends + resolution durations ────────────────────────────────────

export async function aggregateTicketCreatedSeries(
  window: AnalyticsWindow,
  unit: AnalyticsBucketUnit,
): Promise<ReadonlyArray<BucketCount>> {
  return TicketModel.aggregate<BucketCount>([
    {
      $match: windowMatch(window, {
        deletedAt: null,
        createdAt: { $gte: window.from, $lt: window.to },
      }),
    },
    { $group: { _id: truncatedDate('createdAt', unit), count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
}

export async function aggregateTicketResolvedSeries(
  window: AnalyticsWindow,
  unit: AnalyticsBucketUnit,
): Promise<ReadonlyArray<BucketCount>> {
  return TicketModel.aggregate<BucketCount>([
    {
      $match: windowMatch(window, {
        deletedAt: null,
        resolvedAt: { $gte: window.from, $lt: window.to },
      }),
    },
    { $group: { _id: truncatedDate('resolvedAt', unit), count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
}

export interface ResolutionStatsAggregation {
  readonly count: number;
  readonly averageMs: number;
  readonly medianMs: ReadonlyArray<number> | null;
  readonly minMs: number;
  readonly maxMs: number;
}

/**
 * Resolution durations for tickets RESOLVED inside the window.
 *
 * Definition: `resolvedAt − createdAt`. Only real stamps are used; a ticket
 * with `resolvedAt: null` is excluded (never `updatedAt` as a substitute), and
 * negative durations (clock/data anomalies) are excluded. Median is MongoDB's
 * approximate percentile over the same population.
 */
export async function aggregateResolutionStats(
  window: AnalyticsWindow,
): Promise<ResolutionStatsAggregation | null> {
  // `$percentile` is a MongoDB 7.0 accumulator that Mongoose 8's pipeline
  // typings do not yet model; the cast is a TYPING gap, not a runtime shortcut
  // (the verified server is MongoDB 7 and the driver accepts the stage).
  const pipeline = [
    {
      $match: windowMatch(window, {
        deletedAt: null,
        resolvedAt: { $gte: window.from, $lt: window.to },
      }),
    },
    { $addFields: { durationMs: { $subtract: ['$resolvedAt', '$createdAt'] } } },
    { $match: { durationMs: { $gte: 0 } } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        averageMs: { $avg: '$durationMs' },
        minMs: { $min: '$durationMs' },
        maxMs: { $max: '$durationMs' },
        medianMs: {
          $percentile: { input: '$durationMs', p: [0.5], method: 'approximate' },
        },
      },
    },
  ] as unknown as PipelineStage[];

  const [row] = await TicketModel.aggregate<ResolutionStatsAggregation>(pipeline)
    .option({ allowDiskUse: true })
    .exec();

  return row ?? null;
}

// ── Performance ─────────────────────────────────────────────────────────────

export interface FirstStaffReplyAggregation {
  readonly count: number;
  readonly averageMs: number;
}

/**
 * First staff reply: the FIRST PUBLIC AGENT message of each live-ticket
 * conversation (found without a date filter so "first" is the first overall),
 * then filtered to replies that landed inside the window. INTERNAL notes never
 * qualify (excluded in the lookup's `$match`), and conversations with no
 * qualifying reply are omitted rather than counted as zero.
 */
export async function aggregateFirstStaffReply(
  window: AnalyticsWindow,
): Promise<FirstStaffReplyAggregation | null> {
  const { workspaceId, from, to } = window;
  const [row] = await ConversationModel.aggregate<FirstStaffReplyAggregation>([
    { $match: { workspaceId } },
    {
      $lookup: {
        from: 'tickets',
        let: { ticketId: '$ticketId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$ticketId'] },
                  { $eq: ['$workspaceId', workspaceId] },
                  { $eq: ['$deletedAt', null] },
                ],
              },
            },
          },
          { $project: { _id: 1 } },
        ],
        as: 'ticket',
      },
    },
    { $match: { 'ticket.0': { $exists: true } } },
    {
      $lookup: {
        from: 'messages',
        let: { conversationId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$conversationId', '$$conversationId'] },
                  { $eq: ['$workspaceId', workspaceId] },
                  { $eq: ['$visibility', 'PUBLIC'] },
                  { $eq: ['$senderType', 'AGENT'] },
                ],
              },
            },
          },
          { $sort: { createdAt: 1, _id: 1 } },
          { $limit: 1 },
          { $project: { createdAt: 1 } },
        ],
        as: 'firstReply',
      },
    },
    { $match: { 'firstReply.0': { $exists: true } } },
    { $addFields: { firstReplyAt: { $arrayElemAt: ['$firstReply.createdAt', 0] } } },
    { $match: { firstReplyAt: { $gte: from, $lt: to } } },
    { $addFields: { durationMs: { $subtract: ['$firstReplyAt', '$createdAt'] } } },
    { $match: { durationMs: { $gte: 0 } } },
    { $group: { _id: null, count: { $sum: 1 }, averageMs: { $avg: '$durationMs' } } },
  ])
    .option({ allowDiskUse: true })
    .exec();

  return row ?? null;
}

export async function countConversationsCreated(
  window: AnalyticsWindow,
): Promise<number> {
  return ConversationModel.countDocuments({
    workspaceId: window.workspaceId,
    createdAt: { $gte: window.from, $lt: window.to },
  });
}

export async function aggregateMessageVisibilityCounts(
  window: AnalyticsWindow,
): Promise<ReadonlyArray<{ _id: string; count: number }>> {
  return MessageModel.aggregate<{ _id: string; count: number }>([
    {
      $match: windowMatch(window, {
        createdAt: { $gte: window.from, $lt: window.to },
      }),
    },
    { $group: { _id: '$visibility', count: { $sum: 1 } } },
  ]);
}

// ── AI analytics (existing audit trail) ─────────────────────────────────────

export interface AgentAuditAggregation {
  readonly totals: ReadonlyArray<{
    requests: number;
    answered: number;
    abstained: number;
    failed: number;
    citationBacked: number;
  }>;
  readonly abstentionReasons: ReadonlyArray<{ _id: string | null; count: number }>;
  readonly series: ReadonlyArray<{
    _id: { bucket: Date; outcome: string | null };
    count: number;
  }>;
}

/**
 * Agent activity from the EXISTING `audit_logs` trail (Prompt 14 writes one
 * `agent_response` row per ask: `agent.question_answered` with
 * `metadata.outcome` ANSWERED/ABSTAINED, or `agent.question_failed` with
 * outcome FAILED). Requests = all rows; a provider retry inside one ask does
 * not create a second row, so retries are never counted as extra answers.
 * The trail is content-free — no question, answer, prompt or passage text.
 */
export async function aggregateAgentAudit(
  window: AnalyticsWindow,
  unit: AnalyticsBucketUnit,
): Promise<AgentAuditAggregation> {
  const [facet] = await AuditLogModel.aggregate<AgentAuditAggregation>([
    {
      $match: windowMatch(window, {
        resourceType: 'agent_response',
        createdAt: { $gte: window.from, $lt: window.to },
      }),
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              requests: { $sum: 1 },
              answered: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$action', 'agent.question_answered'] },
                        { $eq: ['$metadata.outcome', 'ANSWERED'] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              abstained: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$action', 'agent.question_answered'] },
                        { $eq: ['$metadata.outcome', 'ABSTAINED'] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              failed: {
                $sum: {
                  $cond: [{ $eq: ['$action', 'agent.question_failed'] }, 1, 0],
                },
              },
              citationBacked: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$action', 'agent.question_answered'] },
                        { $eq: ['$metadata.outcome', 'ANSWERED'] },
                        { $gt: ['$metadata.citationsCount', 0] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
        abstentionReasons: [
          { $match: { action: 'agent.question_answered', 'metadata.outcome': 'ABSTAINED' } },
          { $group: { _id: '$metadata.abstentionReason', count: { $sum: 1 } } },
        ],
        series: [
          {
            $group: {
              _id: {
                bucket: truncatedDate('createdAt', unit),
                outcome: '$metadata.outcome',
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { '_id.bucket': 1 } },
        ],
      },
    },
  ])
    .option({ allowDiskUse: true })
    .exec();

  return facet ?? { totals: [], abstentionReasons: [], series: [] };
}

export interface AiEscalationAggregation {
  readonly totals: ReadonlyArray<{ total: number }>;
  readonly byTrigger: ReadonlyArray<{ _id: string; count: number }>;
}

/**
 * AI-triggered escalations: `initiatedBy.actorType === 'AI_AGENT'` (written by
 * the Prompt 15 trigger rules). Manual staff escalations (actorType STAFF) are
 * excluded, which is also what prevents double-counting a human action as an
 * AI handoff.
 */
export async function aggregateAiEscalations(
  window: AnalyticsWindow,
): Promise<AiEscalationAggregation> {
  const [facet] = await EscalationModel.aggregate<AiEscalationAggregation>([
    {
      $match: windowMatch(window, {
        createdAt: { $gte: window.from, $lt: window.to },
        'initiatedBy.actorType': 'AI_AGENT',
      }),
    },
    {
      $facet: {
        totals: [{ $group: { _id: null, total: { $sum: 1 } } }],
        byTrigger: [{ $group: { _id: '$triggerType', count: { $sum: 1 } } }],
      },
    },
  ]).exec();

  return facet ?? { totals: [], byTrigger: [] };
}

// ── Report export ───────────────────────────────────────────────────────────

/**
 * Bounded ticket report rows (created inside the window). Projection limits the
 * cursor to machine fields; the cap keeps generation and response size bounded.
 */
export async function findTicketReportRows(
  window: AnalyticsWindow,
): Promise<ReadonlyArray<TicketReportRow>> {
  const rows = await TicketModel.aggregate<
    Omit<TicketReportRow, 'resolutionMinutes' | 'assigned'> & {
      agentId: Types.ObjectId | null;
    }
  >([
    {
      $match: windowMatch(window, {
        deletedAt: null,
        createdAt: { $gte: window.from, $lt: window.to },
      }),
    },
    {
      $project: {
        _id: 0,
        number: 1,
        status: 1,
        priority: 1,
        createdAt: 1,
        resolvedAt: 1,
        agentId: 1,
      },
    },
    { $sort: { createdAt: 1, number: 1 } },
    { $limit: MAX_REPORT_ROWS },
  ])
    .option({ allowDiskUse: true })
    .exec();

  return rows.map((row) => ({
    number: row.number,
    status: row.status,
    priority: row.priority,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolutionMinutes:
      row.resolvedAt === null
        ? null
        : Math.max(0, Math.round((row.resolvedAt.getTime() - row.createdAt.getTime()) / 60_000)),
    assigned: row.agentId !== null,
  }));
}
