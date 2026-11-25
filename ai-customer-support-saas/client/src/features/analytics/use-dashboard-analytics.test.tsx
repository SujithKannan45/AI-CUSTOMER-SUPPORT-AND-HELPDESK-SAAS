import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { HttpApiError } from '@/services/http-client.service';
import { makeDashboardAnalytics } from '@/test/fixtures';
import { analyticsService } from './analytics.service';
import { useDashboardAnalytics } from './use-dashboard-analytics';
import type { OverviewPayload, PerformancePayload, TicketAnalyticsPayload } from './types';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

const first = makeDashboardAnalytics();
const second = makeDashboardAnalytics({
  ticketTotal: 7,
  statusCounts: { OPEN: 3, IN_PROGRESS: 2, WAITING_FOR_CUSTOMER: 1, RESOLVED: 1, CLOSED: 0 },
});

let getOverview: MockInstance<typeof analyticsService.getOverview>;
let getTickets: MockInstance<typeof analyticsService.getTickets>;
let getPerformance: MockInstance<typeof analyticsService.getPerformance>;

describe('useDashboardAnalytics', () => {
  beforeEach(() => {
    getOverview = vi.spyOn(analyticsService, 'getOverview').mockResolvedValue(first.overview);
    getTickets = vi.spyOn(analyticsService, 'getTickets').mockResolvedValue(first.tickets);
    getPerformance = vi
      .spyOn(analyticsService, 'getPerformance')
      .mockResolvedValue(first.performance);
  });

  it('loads the three reads for the active workspace', async () => {
    const { result } = renderHook(() =>
      useDashboardAnalytics({ workspaceId: 'ws-1', preset: '30d' }),
    );

    expect(result.current.status).toBe('loading');
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.data?.overview.tickets.total).toBe(20);
    expect(getOverview).toHaveBeenCalledWith('ws-1', { range: '30d' }, expect.any(AbortSignal));
    expect(getTickets).toHaveBeenCalledWith(
      'ws-1',
      { range: '30d' },
      'day',
      expect.any(AbortSignal),
    );
    expect(result.current.lastUpdated).not.toBeNull();
  });

  it('does not call the API without a workspace', () => {
    const { result } = renderHook(() =>
      useDashboardAnalytics({ workspaceId: null, preset: '30d' }),
    );

    expect(result.current.status).toBe('idle');
    expect(getOverview).not.toHaveBeenCalled();
  });

  it('drops the previous workspace data immediately on a switch', async () => {
    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string }) =>
        useDashboardAnalytics({ workspaceId, preset: '30d' }),
      { initialProps: { workspaceId: 'ws-1' } },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    const pending = deferred<OverviewPayload>();
    getOverview.mockReturnValueOnce(pending.promise);

    rerender({ workspaceId: 'ws-2' });

    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBeNull();
  });

  it('never lets an earlier workspace response overwrite the current one', async () => {
    const oldOverview = deferred<OverviewPayload>();
    const oldTickets = deferred<TicketAnalyticsPayload>();
    const oldPerformance = deferred<PerformancePayload>();

    getOverview.mockImplementation((workspaceId) =>
      workspaceId === 'ws-1' ? oldOverview.promise : Promise.resolve(second.overview),
    );
    getTickets.mockImplementation((workspaceId) =>
      workspaceId === 'ws-1' ? oldTickets.promise : Promise.resolve(second.tickets),
    );
    getPerformance.mockImplementation((workspaceId) =>
      workspaceId === 'ws-1' ? oldPerformance.promise : Promise.resolve(second.performance),
    );

    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string }) =>
        useDashboardAnalytics({ workspaceId, preset: '30d' }),
      { initialProps: { workspaceId: 'ws-1' } },
    );

    await waitFor(() => {
      expect(getOverview).toHaveBeenCalledWith('ws-1', { range: '30d' }, expect.any(AbortSignal));
    });

    rerender({ workspaceId: 'ws-2' });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.data?.overview.tickets.total).toBe(7);

    await act(async () => {
      oldOverview.resolve(first.overview);
      oldTickets.resolve(first.tickets);
      oldPerformance.resolve(first.performance);
      await Promise.resolve();
    });

    expect(result.current.data?.overview.tickets.total).toBe(7);
    expect(result.current.workspaceId).toBe('ws-2');
  });

  it('sends custom windows with exclusive UTC bounds and a coarser bucket', async () => {
    renderHook(() =>
      useDashboardAnalytics({
        workspaceId: 'ws-1',
        preset: 'custom',
        customFrom: '2026-01-01',
        customTo: '2026-06-30',
      }),
    );

    await waitFor(() => {
      expect(getTickets).toHaveBeenCalledWith(
        'ws-1',
        {
          range: 'custom',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-07-01T00:00:00.000Z',
        },
        'month',
        expect.any(AbortSignal),
      );
    });
  });

  it('maps a 403 to a forbidden state without exposing the server body', async () => {
    getOverview.mockRejectedValue(
      new HttpApiError('internal detail', { status: 403, code: 'FORBIDDEN' }),
    );

    const { result } = renderHook(() =>
      useDashboardAnalytics({ workspaceId: 'ws-1', preset: '30d' }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.forbidden).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).not.toContain('internal detail');
  });

  it('refetches all reads on refresh', async () => {
    const { result } = renderHook(() =>
      useDashboardAnalytics({ workspaceId: 'ws-1', preset: '30d' }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(getOverview).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(getOverview).toHaveBeenCalledTimes(2);
      expect(result.current.status).toBe('ready');
    });
  });
});
