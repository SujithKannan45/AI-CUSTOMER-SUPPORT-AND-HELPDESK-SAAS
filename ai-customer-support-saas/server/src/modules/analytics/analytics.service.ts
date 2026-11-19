import { Types } from 'mongoose';

import { env } from '../../config/env.config.js';
import type { CustomerStatus } from '../customers/customer.types.js';
import type { EscalationStatus, EscalationTriggerType } from '../escalations/escalation.types.js';
import type { TicketPriority, TicketStatus } from '../tickets/ticket.types.js';

import { toCsv, safeFilename } from './analytics.csv.js';
import {
  bucketKey,
  bucketStarts,
  fillTrend,
  resolveAnalyticsWindow,
  roundMs,
  type ResolvedAnalyticsPeriod,
  type ResolvedAnalyticsWindow,
} from './analytics.date-range.js';
import {
  aggregateAgentAudit,
  aggregateAiEscalations,
  aggregateConversationOverview,
  aggregateCustomerOverview,
  aggregateEscalationOverview,
  aggregateFirstStaffReply,
  aggregateKnowledgeBaseStatusCounts,
  aggregateMessageVisibilityCounts,
  aggregateResolutionStats,
  aggregateTicketBacklog,
  aggregateTicketCreatedSeries,
  aggregateTicketOverview,
  aggregateTicketResolvedSeries,
  countConversationsCreated,
  findTicketReportRows,
  type AnalyticsWindow,
  type ResolutionStatsAggregation,
} from './analytics.repository.js';
import type {
  AiAnalyticsPayload,
  AiSummaryDto,
  AnalyticsBucketUnit,
  AnalyticsPeriodDto,
  CustomerStatusCounts,
  DurationStatsDto,
  EscalationStatusCounts,
  KnowledgeBaseOverviewDto,
  OverviewPayload,
  PerformancePayload,
  TicketAnalyticsPayload,
  TicketPriorityCounts,
  TicketStatusCounts,
} from './analytics.types.js';
import type {
  AnalyticsRangeQuery,
  AnalyticsTimeSeriesQuery,
  TicketReportQuery,
} from './analytics.validation.js';

/**
 * Analytics business layer (Prompt 18) — orchestrates workspace-scoped
 * aggregations and shapes the HTTP read models. Controllers stay one-liners;
 * the repository owns every pipeline.
 *
 * What is NOT here on purpose: estimates, extrapolations, `updatedAt` used as a
 * resolution timestamp, customer PII, ticket text, message content, AI prompts
 * or provider data. Each metric in the response can be traced to a persisted
 * source field (documented in docs/architecture.md).
 */

export interface AnalyticsRequestContext {
  /** Validated workspace context id (middleware), hex string. */
  readonly workspaceId: string;
}

const TICKET_STATUS_ZERO: TicketStatusCounts = {
  OPEN: 0,
  IN_PROGRESS: 0,
  WAITING_FOR_CUSTOMER: 0,
  RESOLVED: 0,
  CLOSED: 0,
};

const TICKET_PRIORITY_ZERO: TicketPriorityCounts = {
  LOW: 0,
  MEDIUM: 0,
  HIGH: 0,
  URGENT: 0,
};

const CUSTOMER_STATUS_ZERO: CustomerStatusCounts = { active: 0, blocked: 0 };

const ESCALATION_STATUS_ZERO: EscalationStatusCounts = {
  PENDING: 0,
  ASSIGNED: 0,
  ACCEPTED: 0,
  RESOLVED: 0,
  CANCELLED: 0,
};

function fillCounts<T extends string>(
  zero: Record<T, number>,
  rows: ReadonlyArray<{ _id: string; count: number }>,
): Record<T, number> {
  const result: Record<T, number> = { ...zero };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(result, row._id)) {
      result[row._id as T] = row.count;
    }
  }
  return result;
}

function toWindow(workspaceId: string, window: ResolvedAnalyticsWindow): AnalyticsWindow {
  return {
    workspaceId: new Types.ObjectId(workspaceId),
    from: window.from,
    to: window.to,
  };
}

function periodDto(
  window: ResolvedAnalyticsWindow,
  bucket: AnalyticsBucketUnit = 'day',
): AnalyticsPeriodDto {
  return {
    range: window.range,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    bucket,
    timezone: 'UTC',
  };
}

function durationStats(row: ResolutionStatsAggregation | null): DurationStatsDto {
  if (row === null || row.count === 0) {
    return { count: 0, averageMs: null, medianMs: null, minMs: null, maxMs: null };
  }
  return {
    count: row.count,
    averageMs: roundMs(row.averageMs),
    medianMs: roundMs(row.medianMs?.[0]),
    minMs: roundMs(row.minMs),
    maxMs: roundMs(row.maxMs),
  };
}

// ── Overview ────────────────────────────────────────────────────────────────

export async function getOverviewFlow(
  context: AnalyticsRequestContext,
  query: AnalyticsRangeQuery,
): Promise<OverviewPayload> {
  const resolved = resolveAnalyticsWindow(query);
  const window = toWindow(context.workspaceId, resolved);

  const [tickets, customers, conversations, escalations, kbRows, audit, aiEscalations] =
    await Promise.all([
      aggregateTicketOverview(window),
      aggregateCustomerOverview(window),
      aggregateConversationOverview(window),
      aggregateEscalationOverview(window),
      aggregateKnowledgeBaseStatusCounts(window.workspaceId),
      aggregateAgentAudit(window, 'day'),
      aggregateAiEscalations(window),
    ]);

  const ticketTotals = tickets.totals[0];
  const ticketStatus = fillCounts(TICKET_STATUS_ZERO, tickets.byStatus);
  const assignment = { assigned: 0, unassigned: 0 };
  for (const row of tickets.assignment) {
    if (row._id === 'assigned') assignment.assigned = row.count;
    if (row._id === 'unassigned') assignment.unassigned = row.count;
  }

  const customerTotals = customers.totals[0];
  const conversationTotals = conversations.totals[0];
  const escalationTotals = escalations.totals[0];

  const kbCounts = new Map(kbRows.map((row) => [row._id, row.count]));
  const knowledgeBase: KnowledgeBaseOverviewDto = {
    total: kbRows.reduce((sum, row) => sum + row.count, 0),
    published: kbCounts.get('PUBLISHED') ?? 0,
    draft: kbCounts.get('DRAFT') ?? 0,
    archived: kbCounts.get('ARCHIVED') ?? 0,
  };

  const auditTotals = audit.totals[0];
  const aiHandoffs = aiEscalations.totals[0]?.total ?? 0;
  const ai: AiSummaryDto = {
    requests: auditTotals?.requests ?? 0,
    answered: auditTotals?.answered ?? 0,
    abstained: auditTotals?.abstained ?? 0,
    failed: auditTotals?.failed ?? 0,
    citationBackedAnswers: auditTotals?.citationBacked ?? 0,
    aiEscalations: aiHandoffs,
    humanHandoffs: aiHandoffs,
  };

  return {
    period: periodDto(resolved),
    tickets: {
      total: ticketTotals?.total ?? 0,
      open: ticketStatus.OPEN,
      inProgress: ticketStatus.IN_PROGRESS,
      waitingForCustomer: ticketStatus.WAITING_FOR_CUSTOMER,
      resolved: ticketStatus.RESOLVED,
      closed: ticketStatus.CLOSED,
      byStatus: ticketStatus,
      byPriority: fillCounts(TICKET_PRIORITY_ZERO, tickets.byPriority),
      createdInPeriod: ticketTotals?.createdInPeriod ?? 0,
      resolvedInPeriod: ticketTotals?.resolvedInPeriod ?? 0,
      assignment,
      topAssignees: tickets.topAssignees.map((row) => ({
        userId: row._id.toHexString(),
        tickets: row.count,
      })),
    },
    customers: {
      total: customerTotals?.total ?? 0,
      newInPeriod: customerTotals?.newInPeriod ?? 0,
      byStatus: fillCounts(CUSTOMER_STATUS_ZERO, customers.byStatus),
    },
    conversations: {
      total: conversationTotals?.total ?? 0,
      open: (conversationTotals?.total ?? 0) - (conversationTotals?.closed ?? 0),
      closed: conversationTotals?.closed ?? 0,
      createdInPeriod: conversationTotals?.createdInPeriod ?? 0,
    },
    escalations: {
      total: escalationTotals?.total ?? 0,
      active: escalationTotals?.active ?? 0,
      createdInPeriod: escalationTotals?.createdInPeriod ?? 0,
      byStatus: fillCounts(ESCALATION_STATUS_ZERO, escalations.byStatus),
    },
    knowledgeBase,
    ai,
  };
}

// ── Ticket analytics ────────────────────────────────────────────────────────

export async function getTicketAnalyticsFlow(
  context: AnalyticsRequestContext,
  query: AnalyticsTimeSeriesQuery,
): Promise<TicketAnalyticsPayload> {
  const resolved = resolveAnalyticsWindow(query);
  const window = toWindow(context.workspaceId, resolved);

  const [overview, createdRows, resolvedRows, resolution] = await Promise.all([
    aggregateTicketOverview(window),
    aggregateTicketCreatedSeries(window, query.bucket),
    aggregateTicketResolvedSeries(window, query.bucket),
    aggregateResolutionStats(window),
  ]);

  const starts = bucketStarts(resolved.from, resolved.to, query.bucket);
  const createdCounts = new Map(createdRows.map((row) => [bucketKey(row._id), row.count]));
  const resolvedCounts = new Map(resolvedRows.map((row) => [bucketKey(row._id), row.count]));

  const totals = overview.totals[0];
  const assignment = { assigned: 0, unassigned: 0 };
  for (const row of overview.assignment) {
    if (row._id === 'assigned') assignment.assigned = row.count;
    if (row._id === 'unassigned') assignment.unassigned = row.count;
  }

  return {
    period: periodDto(resolved, query.bucket),
    tickets: {
      total: totals?.total ?? 0,
      createdInPeriod: totals?.createdInPeriod ?? 0,
      resolvedInPeriod: totals?.resolvedInPeriod ?? 0,
    },
    byStatus: fillCounts(TICKET_STATUS_ZERO, overview.byStatus),
    byPriority: fillCounts(TICKET_PRIORITY_ZERO, overview.byPriority),
    assignment,
    topAssignees: overview.topAssignees.map((row) => ({
      userId: row._id.toHexString(),
      tickets: row.count,
    })),
    created: fillTrend(starts, createdCounts),
    resolved: fillTrend(starts, resolvedCounts),
    resolutionTime: durationStats(resolution),
  };
}

// ── Performance ─────────────────────────────────────────────────────────────

export async function getPerformanceFlow(
  context: AnalyticsRequestContext,
  query: AnalyticsRangeQuery,
): Promise<PerformancePayload> {
  const resolved = resolveAnalyticsWindow(query);
  const window = toWindow(context.workspaceId, resolved);

  const [backlog, overview, resolution, firstReply, conversationsCreated, messageCounts] =
    await Promise.all([
      aggregateTicketBacklog(window),
      aggregateTicketOverview(window),
      aggregateResolutionStats(window),
      aggregateFirstStaffReply(window),
      countConversationsCreated(window),
      aggregateMessageVisibilityCounts(window),
    ]);

  const backlogTotals = backlog.totals[0];
  const backlogOpen = backlogTotals?.open ?? 0;
  const backlogInProgress = backlogTotals?.inProgress ?? 0;
  const backlogWaiting = backlogTotals?.waitingForCustomer ?? 0;

  const messages = { total: 0, public: 0, internal: 0 };
  for (const row of messageCounts) {
    messages.total += row.count;
    if (row._id === 'PUBLIC') messages.public = row.count;
    if (row._id === 'INTERNAL') messages.internal = row.count;
  }

  const escalationsCreated = (await aggregateEscalationOverview(window)).totals[0]?.createdInPeriod ?? 0;
  const ticketsCreated = overview.totals[0]?.createdInPeriod ?? 0;

  return {
    period: periodDto(resolved),
    backlog: {
      open: backlogOpen,
      inProgress: backlogInProgress,
      waitingForCustomer: backlogWaiting,
      totalBacklog: backlogOpen + backlogInProgress + backlogWaiting,
      unassigned: backlogTotals?.unassigned ?? 0,
      byPriority: fillCounts(TICKET_PRIORITY_ZERO, backlog.byPriority),
    },
    resolutionTime: durationStats(resolution),
    firstStaffReply: {
      conversations: firstReply?.count ?? 0,
      averageMs: roundMs(firstReply?.averageMs),
    },
    customerFirstResponse: {
      available: false,
      reason:
        'No customer-sender messages exist in this deployment (customer-portal authentication is not implemented), so no customer first-response timestamp can be measured.',
    },
    escalationFrequency: {
      escalationsCreated,
      ticketsCreated,
      perTicket: ticketsCreated === 0 ? null : Number((escalationsCreated / ticketsCreated).toFixed(4)),
    },
    conversationVolume: {
      conversationsCreated,
      messages,
    },
  };
}

// ── AI analytics ────────────────────────────────────────────────────────────

export async function getAiAnalyticsFlow(
  context: AnalyticsRequestContext,
  query: AnalyticsTimeSeriesQuery,
): Promise<AiAnalyticsPayload> {
  const resolved = resolveAnalyticsWindow(query);
  const window = toWindow(context.workspaceId, resolved);

  const [audit, aiEscalations] = await Promise.all([
    aggregateAgentAudit(window, query.bucket),
    aggregateAiEscalations(window),
  ]);

  const totals = audit.totals[0];

  const abstentionReasons: Record<string, number> = {};
  for (const row of audit.abstentionReasons) {
    if (row._id !== null) abstentionReasons[row._id] = row.count;
  }

  const aiEscalationsByTrigger: Partial<Record<EscalationTriggerType, number>> = {};
  for (const row of aiEscalations.byTrigger) {
    aiEscalationsByTrigger[row._id as EscalationTriggerType] = row.count;
  }

  const starts = bucketStarts(resolved.from, resolved.to, query.bucket);
  const answered = new Map<string, number>();
  const abstained = new Map<string, number>();
  const failed = new Map<string, number>();
  const bucketByKey = new Map(starts.map((start) => [start.toISOString(), start]));

  for (const row of audit.series) {
    const key = bucketKey(row._id.bucket);
    if (!bucketByKey.has(key)) continue; // outside the zero-filled window
    if (row._id.outcome === 'ANSWERED') answered.set(key, row.count);
    else if (row._id.outcome === 'ABSTAINED') abstained.set(key, row.count);
    else if (row._id.outcome === 'FAILED') failed.set(key, row.count);
  }

  const timeSeries = starts.map((start) => {
    const key = start.toISOString();
    return {
      bucket: key,
      answered: answered.get(key) ?? 0,
      abstained: abstained.get(key) ?? 0,
      failed: failed.get(key) ?? 0,
    };
  });

  const handoffs = aiEscalations.totals[0]?.total ?? 0;

  return {
    period: periodDto(resolved, query.bucket),
    aiProviderConfigured: env.AI_PROVIDER !== 'none',
    metrics: {
      requests: totals?.requests ?? 0,
      answered: totals?.answered ?? 0,
      abstained: totals?.abstained ?? 0,
      failed: totals?.failed ?? 0,
      citationBackedAnswers: totals?.citationBacked ?? 0,
      abstentionReasons,
      aiEscalations: handoffs,
      humanHandoffs: handoffs,
      aiEscalationsByTrigger,
    },
    timeSeries,
  };
}

// ── CSV report ──────────────────────────────────────────────────────────────

export interface TicketReportResult {
  readonly filename: string;
  readonly csv: string;
  readonly rowCount: number;
}

/**
 * Bounded ticket report: live tickets CREATED inside the window, capped at
 * 5,000 rows. Machine fields only — no subject, description, customer identity
 * or resolution note. Every cell passes `csvCell` (formula-injection guard).
 */
export async function getTicketReportFlow(
  context: AnalyticsRequestContext,
  query: TicketReportQuery,
): Promise<TicketReportResult> {
  const resolved = resolveAnalyticsWindow(query);
  const rows = await findTicketReportRows(toWindow(context.workspaceId, resolved));

  const csv = toCsv(
    [
      'number',
      'status',
      'priority',
      'created_at',
      'resolved_at',
      'resolution_minutes',
      'assigned',
    ],
    rows.map((row) => [
      row.number,
      row.status,
      row.priority,
      row.createdAt.toISOString(),
      row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
      row.resolutionMinutes,
      row.assigned,
    ]),
  );

  const day = (date: Date): string => date.toISOString().slice(0, 10);
  const filename = safeFilename(`tickets_${day(resolved.from)}_${day(resolved.to)}.csv`);

  return { filename, csv, rowCount: rows.length };
}

/** Re-exported for tests/consumers that need the ticket status vocabulary. */
export type AnalyticsTicketStatus = TicketStatus;
export type AnalyticsTicketPriority = TicketPriority;
export type AnalyticsCustomerStatus = CustomerStatus;
export type AnalyticsEscalationStatus = EscalationStatus;
export type AnalyticsResolvedPeriod = ResolvedAnalyticsPeriod;
