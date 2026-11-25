import { describe, expect, it, vi } from 'vitest';
import { httpClient } from '@/services/http-client.service';
import { makeDashboardAnalytics } from '@/test/fixtures';
import { analyticsService } from './analytics.service';

const fixture = makeDashboardAnalytics();

describe('analytics service', () => {
  it('builds the preset overview request with the workspace in the path', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(fixture.overview);

    await analyticsService.getOverview('ws-1', { range: '7d' });

    expect(get).toHaveBeenCalledWith('/api/v1/workspaces/ws-1/analytics/overview?range=7d', {});
  });

  it('adds the bucket for the ticket time series', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(fixture.tickets);

    await analyticsService.getTickets('ws-1', { range: '30d' }, 'day');

    expect(get).toHaveBeenCalledWith(
      '/api/v1/workspaces/ws-1/analytics/tickets?range=30d&bucket=day',
      {},
    );
  });

  it('sends custom bounds as ISO datetimes', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(fixture.performance);

    await analyticsService.getPerformance('ws-1', {
      range: 'custom',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-08T00:00:00.000Z',
    });

    expect(get).toHaveBeenCalledWith(
      '/api/v1/workspaces/ws-1/analytics/performance?range=custom&from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-08T00%3A00%3A00.000Z',
      {},
    );
  });

  it('forwards the abort signal so unmounted surfaces cancel their reads', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(fixture.overview);
    const controller = new AbortController();

    await analyticsService.getOverview('ws-1', { range: '90d' }, controller.signal);

    expect(get).toHaveBeenCalledWith('/api/v1/workspaces/ws-1/analytics/overview?range=90d', {
      signal: controller.signal,
    });
  });

  it('encodes the workspace id instead of interpolating it raw', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(fixture.overview);

    await analyticsService.getOverview('ws/../other', { range: '7d' });

    expect(get).toHaveBeenCalledWith(
      '/api/v1/workspaces/ws%2F..%2Fother/analytics/overview?range=7d',
      {},
    );
  });
});
