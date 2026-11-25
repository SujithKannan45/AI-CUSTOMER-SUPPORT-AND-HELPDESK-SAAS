import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyticsService } from './analytics.service';
import { bucketForFilter, customBounds } from './date-range';
import { describeAnalyticsError } from './errors';
import type { AnalyticsRangeFilter, DashboardAnalytics } from './types';

export type DashboardStatus = 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';

export interface DashboardAnalyticsState {
  readonly status: DashboardStatus;
  readonly data: DashboardAnalytics | null;
  readonly error: string | null;
  readonly forbidden: boolean;
  /** Workspace the current data (or failure) belongs to. */
  readonly workspaceId: string | null;
  readonly lastUpdated: string | null;
  readonly refresh: () => void;
}

interface InternalState {
  status: DashboardStatus;
  data: DashboardAnalytics | null;
  error: string | null;
  forbidden: boolean;
  workspaceId: string | null;
  filterKey: string | null;
  lastUpdated: string | null;
}

export interface DashboardSelectionInput {
  readonly workspaceId: string | null;
  /** Preset id, or `custom` when `customFrom`/`customTo` are supplied. */
  readonly preset: '7d' | '30d' | '90d' | 'custom';
  readonly customFrom?: string;
  readonly customTo?: string;
}

const INITIAL_STATE: InternalState = {
  status: 'idle',
  data: null,
  error: null,
  forbidden: false,
  workspaceId: null,
  filterKey: null,
  lastUpdated: null,
};

function filterKeyOf(filter: AnalyticsRangeFilter): string {
  return filter.range === 'custom'
    ? `custom:${filter.from}:${filter.to}`
    : `preset:${filter.range}`;
}

/**
 * Loads the dashboard's three analytics reads as one logical request.
 *
 * Tenant safety: the hook is keyed on the active workspace id. A workspace
 * change clears the previous data immediately (it is never shown under the new
 * workspace) and every response is accepted only when it belongs to the latest
 * request sequence — an older workspace or range can never overwrite the
 * current one, even if it resolves later.
 *
 * Aborts are best-effort cancellation; the sequence guard is the correctness
 * mechanism (a response may already be in flight when the effect cleans up).
 */
export function useDashboardAnalytics({
  workspaceId,
  preset,
  customFrom,
  customTo,
}: DashboardSelectionInput): DashboardAnalyticsState {
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<InternalState>(INITIAL_STATE);
  const requestSeq = useRef(0);

  const filter = useMemo<AnalyticsRangeFilter>(() => {
    if (preset !== 'custom') return { range: preset };
    return { range: 'custom', ...customBounds(customFrom ?? '', customTo ?? '') };
  }, [preset, customFrom, customTo]);

  const filterKey = filterKeyOf(filter);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (workspaceId === null) {
      requestSeq.current += 1;
      setState(INITIAL_STATE);
      return;
    }

    const seq = ++requestSeq.current;
    const controller = new AbortController();
    const bucket = bucketForFilter(filter);

    setState((previous) => {
      const sameScope =
        previous.data !== null &&
        previous.workspaceId === workspaceId &&
        previous.filterKey === filterKey;

      if (sameScope) {
        return { ...previous, status: 'refreshing', error: null, forbidden: false };
      }

      return {
        status: 'loading',
        data: null,
        error: null,
        forbidden: false,
        workspaceId,
        filterKey,
        lastUpdated: null,
      };
    });

    const load = async (): Promise<void> => {
      try {
        const [overview, tickets, performance] = await Promise.all([
          analyticsService.getOverview(workspaceId, filter, controller.signal),
          analyticsService.getTickets(workspaceId, filter, bucket, controller.signal),
          analyticsService.getPerformance(workspaceId, filter, controller.signal),
        ]);

        if (seq !== requestSeq.current || controller.signal.aborted) return;

        setState({
          status: 'ready',
          data: { overview, tickets, performance },
          error: null,
          forbidden: false,
          workspaceId,
          filterKey,
          lastUpdated: new Date().toISOString(),
        });
      } catch (error) {
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        const description = describeAnalyticsError(error);
        setState({
          status: 'error',
          data: null,
          error: description.message,
          forbidden: description.forbidden,
          workspaceId,
          filterKey,
          lastUpdated: null,
        });
      }
    };

    void load();

    return () => {
      controller.abort();
    };
  }, [workspaceId, filter, filterKey, reloadToken]);

  /**
   * Synchronous tenant guard: while a render still reflects an older
   * workspace or window (before the effect runs), report loading with no data
   * rather than painting the previous workspace's numbers for one frame.
   */
  const scopeIsCurrent =
    workspaceId !== null && state.workspaceId === workspaceId && state.filterKey === filterKey;
  const staleScope = !scopeIsCurrent && (state.data !== null || state.status === 'error');
  const visible = workspaceId === null || staleScope
    ? {
        ...state,
        status: workspaceId === null ? ('idle' as const) : ('loading' as const),
        data: null,
        error: null,
        forbidden: false,
        lastUpdated: null,
      }
    : state;

  return {
    status: visible.status,
    data: visible.data,
    error: visible.error,
    forbidden: visible.forbidden,
    workspaceId: visible.workspaceId,
    lastUpdated: visible.lastUpdated,
    refresh,
  };
}

