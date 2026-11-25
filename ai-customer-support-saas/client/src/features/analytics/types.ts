/**
 * Client mirrors of the Prompt 18 analytics read models
 * (`server/src/modules/analytics/analytics.types.ts`).
 *
 * Only the fields the dashboard renders are documented here; every shape is a
 * structural copy of the server DTO. The frontend never derives a business
 * metric that the backend already defines — durations, backlog and period
 * counts are consumed exactly as returned.
 */

export type AnalyticsRangeName = 'today' | '7d' | '30d' | '90d' | 'custom';
export type AnalyticsBucketUnit = 'day' | 'week' | 'month';

export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_FOR_CUSTOMER' | 'RESOLVED' | 'CLOSED';
export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export type TicketStatusCounts = Record<TicketStatus, number>;
export type TicketPriorityCounts = Record<TicketPriority, number>;
export type CustomerStatusCounts = Record<'active' | 'blocked', number>;
export type EscalationStatusCounts = Record<
  'PENDING' | 'ASSIGNED' | 'ACCEPTED' | 'RESOLVED' | 'CANCELLED',
  number
>;

/** Resolved window: `from` inclusive, `to` exclusive, always UTC. */
export interface AnalyticsPeriodDto {
  readonly range: AnalyticsRangeName;
  readonly from: string;
  readonly to: string;
  readonly bucket: AnalyticsBucketUnit;
  readonly timezone: 'UTC';
}

export interface TrendPointDto {
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

export interface OverviewPayload {
  readonly period: AnalyticsPeriodDto;
  readonly tickets: {
    readonly total: number;
    readonly open: number;
    readonly inProgress: number;
    readonly waitingForCustomer: number;
    readonly resolved: number;
    readonly closed: number;
    readonly byStatus: TicketStatusCounts;
    readonly byPriority: TicketPriorityCounts;
    readonly createdInPeriod: number;
    readonly resolvedInPeriod: number;
    readonly assignment: { readonly assigned: number; readonly unassigned: number };
    readonly topAssignees: ReadonlyArray<{ readonly userId: string; readonly tickets: number }>;
  };
  readonly customers: {
    readonly total: number;
    readonly newInPeriod: number;
    readonly byStatus: CustomerStatusCounts;
  };
  readonly conversations: {
    readonly total: number;
    readonly open: number;
    readonly closed: number;
    readonly createdInPeriod: number;
  };
  readonly escalations: {
    readonly total: number;
    readonly active: number;
    readonly createdInPeriod: number;
    readonly byStatus: EscalationStatusCounts;
  };
  readonly knowledgeBase: {
    readonly total: number;
    readonly published: number;
    readonly draft: number;
    readonly archived: number;
  };
  readonly ai: {
    readonly requests: number;
    readonly answered: number;
    readonly abstained: number;
    readonly failed: number;
    readonly citationBackedAnswers: number;
    readonly aiEscalations: number;
    readonly humanHandoffs: number;
  };
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
  /** Created-ticket trend over the window, zero-filled by the server. */
  readonly created: readonly TrendPointDto[];
  /** Resolution trend keyed on `resolvedAt`, zero-filled by the server. */
  readonly resolved: readonly TrendPointDto[];
  readonly resolutionTime: DurationStatsDto;
}

export interface PerformancePayload {
  readonly period: AnalyticsPeriodDto;
  readonly backlog: {
    readonly open: number;
    readonly inProgress: number;
    readonly waitingForCustomer: number;
    readonly totalBacklog: number;
    readonly unassigned: number;
    readonly byPriority: TicketPriorityCounts;
  };
  readonly resolutionTime: DurationStatsDto;
  readonly firstStaffReply: {
    readonly conversations: number;
    readonly averageMs: number | null;
  };
  readonly customerFirstResponse: {
    readonly available: false;
    readonly reason: string;
  };
  readonly escalationFrequency: {
    readonly escalationsCreated: number;
    readonly ticketsCreated: number;
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

/** The three workspace-scoped reads the dashboard composes per load. */
export interface DashboardAnalytics {
  readonly overview: OverviewPayload;
  readonly tickets: TicketAnalyticsPayload;
  readonly performance: PerformancePayload;
}

/** Query accepted by every analytics endpoint (backend union, minus `today`). */
export type AnalyticsRangeFilter =
  | { readonly range: '7d' | '30d' | '90d' }
  | { readonly range: 'custom'; readonly from: string; readonly to: string };
