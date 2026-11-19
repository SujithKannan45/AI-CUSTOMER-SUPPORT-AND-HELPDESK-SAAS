import type { CustomerStatus } from '../customers/customer.types.js';
import type { EscalationStatus, EscalationTriggerType } from '../escalations/escalation.types.js';
import type { TicketPriority, TicketStatus } from '../tickets/ticket.types.js';

/**
 * Analytics & reporting domain vocabulary + HTTP read models (Prompt 18).
 *
 * Design law: every metric here is derived from PERSISTED records that the
 * existing modules already write. Nothing is estimated, inferred from
 * unrelated data, or synthesized. Where a metric cannot be computed honestly
 * (e.g. customer first-response time — no customer-sender messages exist until
 * customer-portal authentication ships) the response states that explicitly
 * instead of returning a fabricated value.
 *
 * Consistency law: this deployment has NO multi-document transactions. Each
 * analytics response is a set of independent aggregation reads over the same
 * workspace; it is NOT a cross-collection snapshot. Concurrent writes can make
 * two metrics in one response reflect instants a few milliseconds apart —
 * documented, never claimed as transactional consistency.
 */

/** Date-range presets offered by the API (plus `custom` with from/to). */
export const ANALYTICS_RANGES = ['today', '7d', '30d', '90d', 'custom'] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

/** Time-series bucket granularity (UTC-aligned). */
export const ANALYTICS_BUCKETS = ['day', 'week', 'month'] as const;
export type AnalyticsBucketUnit = (typeof ANALYTICS_BUCKETS)[number];

/** Upper bound for a single analytics window (inclusive of endpoints). */
export const ANALYTICS_MAX_SPAN_DAYS = 366;

/**
 * Resolved request window. `from` is inclusive, `to` is EXCLUSIVE — one
 * consistent convention across every analytics endpoint, so adjacent ranges
 * never double-count a boundary instant. All timestamps are UTC.
 */
export interface AnalyticsPeriodDto {
  /** The preset the caller asked for (`custom` when from/to were supplied). */
  readonly range: AnalyticsRange;
  /** Inclusive lower bound, ISO-8601 UTC. */
  readonly from: string;
  /** Exclusive upper bound, ISO-8601 UTC. */
  readonly to: string;
  readonly bucket: AnalyticsBucketUnit;
  /** Analytics always computes in UTC (documented limitation, see docs). */
  readonly timezone: 'UTC';
}

export type TicketStatusCounts = Record<TicketStatus, number>;
export type TicketPriorityCounts = Record<TicketPriority, number>;
export type CustomerStatusCounts = Record<CustomerStatus, number>;
export type EscalationStatusCounts = Record<EscalationStatus, number>;

// ── Overview ─────────────────────────────────────────────────────────────────

export interface TicketOverviewDto {
  readonly total: number;
  readonly open: number;
  readonly inProgress: number;
  readonly waitingForCustomer: number;
  readonly resolved: number;
  readonly closed: number;
  readonly byStatus: TicketStatusCounts;
  readonly byPriority: TicketPriorityCounts;
  /** Tickets whose `createdAt` falls inside the window. */
  readonly createdInPeriod: number;
  /** Tickets whose `resolvedAt` falls inside the window (never `updatedAt`). */
  readonly resolvedInPeriod: number;
  readonly assignment: { readonly assigned: number; readonly unassigned: number };
  /** Bounded top-10, deterministic; agent user ids only (no names/PII). */
  readonly topAssignees: ReadonlyArray<{ readonly userId: string; readonly tickets: number }>;
}

export interface CustomerOverviewDto {
  readonly total: number;
  readonly newInPeriod: number;
  /** Actual schema statuses: `active` | `blocked` (there is no `inactive`). */
  readonly byStatus: CustomerStatusCounts;
}

export interface ConversationOverviewDto {
  /**
   * Conversations do NOT carry a status of their own (one primary thread per
   * ticket, lifecycle inherited from the ticket). `open`/`closed` are derived:
   * closed = parent ticket status RESOLVED or CLOSED; open = any other live
   * ticket status.
   */
  readonly total: number;
  readonly open: number;
  readonly closed: number;
  readonly createdInPeriod: number;
}

export interface EscalationOverviewDto {
  readonly total: number;
  /** PENDING + ASSIGNED + ACCEPTED (the active-handoff statuses). */
  readonly active: number;
  readonly createdInPeriod: number;
  readonly byStatus: EscalationStatusCounts;
}

export interface KnowledgeBaseOverviewDto {
  readonly total: number;
  /** First-class `status` values; articles have no soft-delete stamp. */
  readonly published: number;
  readonly draft: number;
  readonly archived: number;
}

export interface AiSummaryDto {
  /** Every `agent_response` audit row in the window = one ask (≥ 1 provider call). */
  readonly requests: number;
  readonly answered: number;
  readonly abstained: number;
  /** Failed asks (provider/retrieval/config failures) — not successful answers. */
  readonly failed: number;
  /** ANSWERED asks whose validated citation count was > 0. */
  readonly citationBackedAnswers: number;
  /** Escalations created in the window by the AI handoff rules. */
  readonly aiEscalations: number;
  /** Same population as `aiEscalations` (named for the handoff outcome). */
  readonly humanHandoffs: number;
}

export interface OverviewPayload {
  readonly period: AnalyticsPeriodDto;
  readonly tickets: TicketOverviewDto;
  readonly customers: CustomerOverviewDto;
  readonly conversations: ConversationOverviewDto;
  readonly escalations: EscalationOverviewDto;
  readonly knowledgeBase: KnowledgeBaseOverviewDto;
  readonly ai: AiSummaryDto;
}

// ── Ticket analytics ────────────────────────────────────────────────────────

export interface TrendPointDto {
  /** UTC bucket start, ISO-8601. */
  readonly bucket: string;
  readonly count: number;
}

export interface DurationStatsDto {
  readonly count: number;
  readonly averageMs: number | null;
  readonly medianMs: number | null;
  readonly minMs: number | null;
  readonly maxMs: number | null;
}

export interface TicketAnalyticsPayload {
  readonly period: AnalyticsPeriodDto;
  readonly tickets: {
    readonly total: number;
    readonly createdInPeriod: number;
    readonly resolvedInPeriod: number;
  };
  readonly byStatus: TicketStatusCounts;
  readonly byPriority: TicketPriorityCounts;
  readonly assignment: { readonly assigned: number; readonly unassigned: number };
  readonly topAssignees: ReadonlyArray<{ readonly userId: string; readonly tickets: number }>;
  /** Created-ticket trend over the window (zero-filled buckets). */
  readonly created: readonly TrendPointDto[];
  /** Resolution trend keyed on `resolvedAt` (zero-filled buckets). */
  readonly resolved: readonly TrendPointDto[];
  /**
   * Resolution durations for tickets whose `resolvedAt` falls in the window.
   * Duration = resolvedAt − createdAt (real stamps only; negative durations
   * are excluded). Median is MongoDB's approximate percentile.
   */
  readonly resolutionTime: DurationStatsDto;
}

// ── Performance ─────────────────────────────────────────────────────────────

export interface PerformancePayload {
  readonly period: AnalyticsPeriodDto;
  readonly backlog: {
    readonly open: number;
    readonly inProgress: number;
    readonly waitingForCustomer: number;
    readonly totalBacklog: number;
    /** Live open-ish tickets with no assignee (agentId null). */
    readonly unassigned: number;
    readonly byPriority: TicketPriorityCounts;
  };
  readonly resolutionTime: DurationStatsDto;
  /**
   * DEFINITION: conversation creation → first PUBLIC AGENT message, for
   * conversations whose first qualifying reply landed inside the window.
   * INTERNAL notes are excluded. This is NOT a customer first-response time:
   * no customer-sender messages exist in this deployment.
   */
  readonly firstStaffReply: {
    readonly conversations: number;
    readonly averageMs: number | null;
  };
  /** Honest availability flag for a metric the data model cannot support yet. */
  readonly customerFirstResponse: {
    readonly available: false;
    readonly reason: string;
  };
  readonly escalationFrequency: {
    readonly escalationsCreated: number;
    readonly ticketsCreated: number;
    /** Escalations per ticket created in the window; null when 0 tickets. */
    readonly perTicket: number | null;
  };
  readonly conversationVolume: {
    readonly conversationsCreated: number;
    readonly messages: {
      readonly total: number;
      readonly public: number;
      readonly internal: number;
    };
  };
}

// ── AI analytics ────────────────────────────────────────────────────────────

export type AbstentionReasonCounts = Record<string, number>;
export type EscalationTriggerCounts = Partial<Record<EscalationTriggerType, number>>;

export interface AiTimeSeriesPointDto {
  readonly bucket: string;
  readonly answered: number;
  readonly abstained: number;
  readonly failed: number;
}

export interface AiAnalyticsPayload {
  readonly period: AnalyticsPeriodDto;
  /**
   * Whether a chat provider is CONFIGURED (`AI_PROVIDER !== 'none'`). This is
   * configuration state, not proof of live provider usage: provider calls are
   * not recorded individually, and this deployment's verification runs use
   * the deterministic mock seam.
   */
  readonly aiProviderConfigured: boolean;
  readonly metrics: {
    readonly requests: number;
    readonly answered: number;
    readonly abstained: number;
    readonly failed: number;
    readonly citationBackedAnswers: number;
    /** Machine abstention reasons (e.g. NO_KNOWLEDGE, LOW_RELEVANCE). */
    readonly abstentionReasons: AbstentionReasonCounts;
    readonly aiEscalations: number;
    readonly humanHandoffs: number;
    readonly aiEscalationsByTrigger: EscalationTriggerCounts;
  };
  readonly timeSeries: readonly AiTimeSeriesPointDto[];
}

// ── Export ──────────────────────────────────────────────────────────────────

/**
 * One CSV row. Deliberately machine fields only: no ticket subject/description,
 * no customer identity, no resolution note, no message content. Free-text
 * fields are excluded by design, so the export cannot leak ticket content even
 * though it is workspace-authorized.
 */
export interface TicketReportRow {
  readonly number: string;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolutionMinutes: number | null;
  readonly assigned: boolean;
}
