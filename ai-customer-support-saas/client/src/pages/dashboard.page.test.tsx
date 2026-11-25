import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useSessionStore } from '@/features/auth/auth.store';
import { analyticsService } from '@/features/analytics/analytics.service';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { HttpApiError } from '@/services/http-client.service';
import { makeDashboardAnalytics, makeWorkspace, resetAuthStores, TEST_USER } from '@/test/fixtures';
import { DashboardPage } from './dashboard.page';

const fixture = makeDashboardAnalytics();
const secondWorkspace = makeDashboardAnalytics({
  ticketTotal: 7,
  statusCounts: { OPEN: 3, IN_PROGRESS: 2, WAITING_FOR_CUSTOMER: 1, RESOLVED: 1, CLOSED: 0 },
});

let getOverview: MockInstance<typeof analyticsService.getOverview>;
let getTickets: MockInstance<typeof analyticsService.getTickets>;
let getPerformance: MockInstance<typeof analyticsService.getPerformance>;

function renderDashboard(): void {
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

function mockDashboard(data: typeof fixture): void {
  getOverview = vi.spyOn(analyticsService, 'getOverview').mockResolvedValue(data.overview);
  getTickets = vi.spyOn(analyticsService, 'getTickets').mockResolvedValue(data.tickets);
  getPerformance = vi.spyOn(analyticsService, 'getPerformance').mockResolvedValue(data.performance);
}

describe('DashboardPage', () => {
  beforeEach(() => {
    resetAuthStores();
    useSessionStore.setState({ status: 'authenticated', user: TEST_USER, error: null });
    useWorkspaceStore.setState({
      status: 'ready',
      items: [makeWorkspace('ws-1', 'Acme')],
      activeWorkspaceId: 'ws-1',
      error: null,
    });
    mockDashboard(fixture);
  });

  it('renders KPI values, status distribution and trend data from the API', async () => {
    renderDashboard();

    expect(await screen.findByTestId('kpi-total-tickets')).toHaveTextContent('20');
    expect(screen.getByTestId('kpi-backlog')).toHaveTextContent('14');
    expect(screen.getByTestId('kpi-created')).toHaveTextContent('6');
    expect(screen.getByTestId('kpi-resolved')).toHaveTextContent('3');
    expect(screen.getByTestId('kpi-resolution-time')).toHaveTextContent('1h 30m');
    expect(screen.getByTestId('kpi-customers')).toHaveTextContent('12');

    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();

    const statuses = screen.getByRole('list', { name: 'Tickets by status' });
    expect(within(statuses).getByText('Waiting for customer')).toBeInTheDocument();
    expect(within(statuses).getByText('8')).toBeInTheDocument();

    expect(screen.getByRole('img', { name: /Ticket trend/ })).toBeInTheDocument();
    expect(screen.getByText('Resolution performance')).toBeInTheDocument();
    expect(screen.getByText('First staff reply')).toBeInTheDocument();
  });

  it('shows the loading state before analytics arrive', () => {
    getOverview.mockReturnValue(new Promise(() => undefined));

    renderDashboard();

    expect(screen.getByText('Loading analytics…')).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-total-tickets')).toBeNull();
  });

  it('shows a workspace empty state instead of fabricated metrics', async () => {
    mockDashboard(makeDashboardAnalytics({ empty: true }));

    renderDashboard();

    expect(await screen.findByText('No analytics yet')).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-total-tickets')).toBeNull();
  });

  it('shows a retryable error and reloads on retry', async () => {
    const user = userEvent.setup();
    getOverview
      .mockRejectedValueOnce(new HttpApiError('boom', { status: 500, code: 'INTERNAL' }))
      .mockResolvedValue(fixture.overview);

    renderDashboard();

    expect(await screen.findByText('Analytics unavailable')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('could not load this data');

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByTestId('kpi-total-tickets')).toHaveTextContent('20');
    expect(getOverview).toHaveBeenCalledTimes(2);
  });

  it('renders the authorization state for a 403 without a retry loop', async () => {
    getOverview.mockRejectedValue(
      new HttpApiError('forbidden detail', { status: 403, code: 'FORBIDDEN' }),
    );

    renderDashboard();

    expect(await screen.findByText('Analytics access required')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    expect(screen.queryByText(/forbidden detail/)).toBeNull();
  });

  it('reloads with the selected preset range', async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByTestId('kpi-total-tickets');

    await user.click(screen.getByRole('button', { name: 'Last 90 days' }));

    await waitFor(() => {
      expect(getOverview).toHaveBeenLastCalledWith(
        'ws-1',
        { range: '90d' },
        expect.any(AbortSignal),
      );
    });
    expect(screen.getByRole('button', { name: 'Last 90 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('applies a validated custom range', async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByTestId('kpi-total-tickets');

    await user.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-10' } });
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(getOverview).toHaveBeenLastCalledWith(
        'ws-1',
        {
          range: 'custom',
          from: '2026-08-01T00:00:00.000Z',
          to: '2026-08-11T00:00:00.000Z',
        },
        expect.any(AbortSignal),
      );
    });
  });

  it('refuses an inverted custom range without calling the API', async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByTestId('kpi-total-tickets');

    await user.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-01' } });
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(screen.getByRole('alert')).toHaveTextContent('start date must be on or before');
    expect(getOverview).toHaveBeenCalledTimes(1);
  });

  it('refetches when Refresh is pressed', async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByTestId('kpi-total-tickets');

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(getOverview).toHaveBeenCalledTimes(2);
    });
  });

  it('loads the newly selected workspace and never shows the old workspace values', async () => {
    renderDashboard();
    await screen.findByTestId('kpi-total-tickets');

    getOverview.mockImplementation((workspaceId) =>
      Promise.resolve(workspaceId === 'ws-2' ? secondWorkspace.overview : fixture.overview),
    );
    getTickets.mockImplementation((workspaceId) =>
      Promise.resolve(workspaceId === 'ws-2' ? secondWorkspace.tickets : fixture.tickets),
    );
    getPerformance.mockImplementation((workspaceId) =>
      Promise.resolve(workspaceId === 'ws-2' ? secondWorkspace.performance : fixture.performance),
    );

    act(() => {
      useWorkspaceStore.setState({
        items: [makeWorkspace('ws-1', 'Acme'), makeWorkspace('ws-2', 'Globex')],
        activeWorkspaceId: 'ws-2',
        status: 'ready',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('kpi-total-tickets')).toHaveTextContent('7');
    });
    expect(screen.getByTestId('kpi-total-tickets')).not.toHaveTextContent('20');
    expect(screen.getByText('Globex')).toBeInTheDocument();
    expect(getOverview).toHaveBeenLastCalledWith('ws-2', { range: '30d' }, expect.any(AbortSignal));
  });
});
