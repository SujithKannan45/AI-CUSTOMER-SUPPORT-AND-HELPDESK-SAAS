import { httpClient } from '@/services/http-client.service';
import type {
  AnalyticsBucketUnit,
  AnalyticsRangeFilter,
  OverviewPayload,
  PerformancePayload,
  TicketAnalyticsPayload,
} from './types';

/**
 * Workspace analytics endpoints (backend: `server/src/modules/analytics`).
 *
 * The workspace id is a routing input only: the server resolves the caller's
 * membership and the `analytics.view` permission on every request. Query keys
 * are limited to the validated contract — `range`, `from`, `to`, `bucket` —
 * so no client value can widen or reshape an aggregation.
 */
function analyticsPath(workspaceId: string, endpoint: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/analytics/${endpoint}`;
}

function buildSearch(filter: AnalyticsRangeFilter, bucket?: AnalyticsBucketUnit): string {
  const params = new URLSearchParams();
  params.set('range', filter.range);
  if (filter.range === 'custom') {
    params.set('from', filter.from);
    params.set('to', filter.to);
  }
  if (bucket !== undefined) params.set('bucket', bucket);
  return params.toString();
}

function requestOptions(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal !== undefined ? { signal } : {};
}

export const analyticsService = {
  /** GET …/analytics/overview — KPI snapshot for the workspace. */
  getOverview(
    workspaceId: string,
    filter: AnalyticsRangeFilter,
    signal?: AbortSignal,
  ): Promise<OverviewPayload> {
    return httpClient.get<OverviewPayload>(
      `${analyticsPath(workspaceId, 'overview')}?${buildSearch(filter)}`,
      requestOptions(signal),
    );
  },

  /** GET …/analytics/tickets — status mix, zero-filled trends, durations. */
  getTickets(
    workspaceId: string,
    filter: AnalyticsRangeFilter,
    bucket: AnalyticsBucketUnit,
    signal?: AbortSignal,
  ): Promise<TicketAnalyticsPayload> {
    return httpClient.get<TicketAnalyticsPayload>(
      `${analyticsPath(workspaceId, 'tickets')}?${buildSearch(filter, bucket)}`,
      requestOptions(signal),
    );
  },

  /** GET …/analytics/performance — backlog, durations, reply metrics. */
  getPerformance(
    workspaceId: string,
    filter: AnalyticsRangeFilter,
    signal?: AbortSignal,
  ): Promise<PerformancePayload> {
    return httpClient.get<PerformancePayload>(
      `${analyticsPath(workspaceId, 'performance')}?${buildSearch(filter)}`,
      requestOptions(signal),
    );
  },
};
