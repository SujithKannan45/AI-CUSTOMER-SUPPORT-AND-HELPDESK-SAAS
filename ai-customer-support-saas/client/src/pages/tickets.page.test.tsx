import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ToastProvider } from '@/app/providers/toast.provider';
import { useSessionStore } from '@/features/auth/auth.store';
import { ticketService } from '@/features/tickets/ticket.service';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { HttpApiError } from '@/services/http-client.service';
import {
  makeTicket,
  makeTicketList,
  makeWorkspace,
  resetAuthStores,
  TEST_TICKET_ID,
  TEST_USER,
} from '@/test/fixtures';
import { TicketsPage } from './tickets.page';

let list: MockInstance<typeof ticketService.list>;

function renderPage(): void {
  render(
    <ToastProvider>
      <MemoryRouter>
        <TicketsPage />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('TicketsPage', () => {
  beforeEach(() => {
    resetAuthStores();
    useSessionStore.setState({ status: 'authenticated', user: TEST_USER, error: null });
    useWorkspaceStore.setState({
      status: 'ready',
      items: [makeWorkspace('ws-1', 'Acme')],
      activeWorkspaceId: 'ws-1',
      error: null,
    });
    list = vi.spyOn(ticketService, 'list').mockResolvedValue(makeTicketList());
  });

  it('renders ticket fields the API returns', async () => {
    renderPage();

    expect(await screen.findByRole('link', { name: /Invoice shows the wrong total/ })).toHaveAttribute(
      'href',
      `/tickets/${TEST_TICKET_ID}`,
    );
    expect(screen.getByText('TKT-000001')).toBeInTheDocument();
    expect(screen.getByText('1 ticket')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getByText('Open')).toBeInTheDocument();
    expect(within(table).getByText('High')).toBeInTheDocument();
    expect(within(table).getByText('Unassigned')).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith(
      'ws-1',
      { page: 1, limit: 20, sort: 'createdAt', order: 'desc' },
      expect.any(AbortSignal),
    );
  });

  it('shows a loading state before the first page arrives', () => {
    list.mockReturnValue(new Promise(() => undefined));

    renderPage();

    expect(screen.getByText('Loading tickets…')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows an empty workspace state', async () => {
    list.mockResolvedValue(makeTicketList([], { total: 0 }));

    renderPage();

    expect(await screen.findByText('No tickets yet')).toBeInTheDocument();
  });

  it('renders a retryable error and reloads on retry', async () => {
    const user = userEvent.setup();
    list
      .mockRejectedValueOnce(new HttpApiError('boom', { status: 500, code: 'INTERNAL' }))
      .mockResolvedValue(makeTicketList());

    renderPage();

    expect(await screen.findByText('Tickets unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByRole('link', { name: /Invoice shows the wrong total/ })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('renders a non-retryable authorization state for a 403', async () => {
    list.mockRejectedValue(new HttpApiError('forbidden detail', { status: 403, code: 'FORBIDDEN' }));

    renderPage();

    expect(await screen.findByText('Ticket access required')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('sends the debounced search term', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: /Invoice shows the wrong total/ });

    await user.type(screen.getByRole('searchbox'), 'invoice');

    await waitFor(() => {
      expect(list).toHaveBeenLastCalledWith(
        'ws-1',
        expect.objectContaining({ search: 'invoice', page: 1 }),
        expect.any(AbortSignal),
      );
    });
  });

  it('sends status and priority filters to the server', async () => {
    renderPage();
    await screen.findByRole('link', { name: /Invoice shows the wrong total/ });

    fireEvent.change(screen.getByLabelText('Filter by ticket status'), {
      target: { value: 'WAITING_FOR_CUSTOMER' },
    });
    await waitFor(() => {
      expect(list).toHaveBeenLastCalledWith(
        'ws-1',
        expect.objectContaining({ status: 'WAITING_FOR_CUSTOMER', page: 1 }),
        expect.any(AbortSignal),
      );
    });

    fireEvent.change(screen.getByLabelText('Filter by ticket priority'), {
      target: { value: 'URGENT' },
    });
    await waitFor(() => {
      expect(list).toHaveBeenLastCalledWith(
        'ws-1',
        expect.objectContaining({ priority: 'URGENT', page: 1 }),
        expect.any(AbortSignal),
      );
    });
  });

  it('resets filters back to the default view', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: /Invoice shows the wrong total/ });

    fireEvent.change(screen.getByLabelText('Filter by ticket status'), {
      target: { value: 'CLOSED' },
    });
    await user.click(await screen.findByRole('button', { name: 'Reset' }));

    await waitFor(() => {
      expect(list).toHaveBeenLastCalledWith(
        'ws-1',
        { page: 1, limit: 20, sort: 'createdAt', order: 'desc' },
        expect.any(AbortSignal),
      );
    });
  });

  it('paginates on the server and labels the current page', async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(makeTicketList([makeTicket()], { total: 45, limit: 20 }));

    renderPage();
    await screen.findByRole('link', { name: /Invoice shows the wrong total/ });

    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Page 2' }));

    await waitFor(() => {
      expect(list).toHaveBeenLastCalledWith(
        'ws-1',
        expect.objectContaining({ page: 2 }),
        expect.any(AbortSignal),
      );
    });
  });

  it('refreshes the current page on demand', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: /Invoice shows the wrong total/ });

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2);
    });
  });
});
