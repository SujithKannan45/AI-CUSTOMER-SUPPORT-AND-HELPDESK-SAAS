import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ToastProvider } from '@/app/providers/toast.provider';
import { useSessionStore } from '@/features/auth/auth.store';
import { customerService } from '@/features/customers/customer.service';
import { ticketService } from '@/features/tickets/ticket.service';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { HttpApiError } from '@/services/http-client.service';
import {
  makeCustomer,
  makeTicket,
  makeWorkspace,
  resetAuthStores,
  TEST_TICKET_ID,
  TEST_USER,
} from '@/test/fixtures';
import type { WorkspaceRole } from '@/features/workspace/types';
import { TicketDetailPage } from './ticket-detail.page';

let get: MockInstance<typeof ticketService.get>;
let setStatus: MockInstance<typeof ticketService.setStatus>;
let setPriority: MockInstance<typeof ticketService.setPriority>;
let resolve: MockInstance<typeof ticketService.resolve>;
let reopen: MockInstance<typeof ticketService.reopen>;

function useRole(role: WorkspaceRole): void {
  useWorkspaceStore.setState({
    status: 'ready',
    items: [makeWorkspace('ws-1', 'Acme', role)],
    activeWorkspaceId: 'ws-1',
    error: null,
  });
}

function renderPage(path = `/tickets/${TEST_TICKET_ID}`): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tickets/:ticketId" element={<TicketDetailPage />} />
          <Route path="/customers/:customerId" element={<div>Customer detail marker</div>} />
          <Route path="/tickets" element={<div>Ticket list marker</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('TicketDetailPage', () => {
  beforeEach(() => {
    resetAuthStores();
    useSessionStore.setState({ status: 'authenticated', user: TEST_USER, error: null });
    useRole('owner');
    get = vi.spyOn(ticketService, 'get').mockResolvedValue({ ticket: makeTicket() });
    setStatus = vi
      .spyOn(ticketService, 'setStatus')
      .mockResolvedValue({ ticket: makeTicket({ status: 'IN_PROGRESS' }) });
    setPriority = vi
      .spyOn(ticketService, 'setPriority')
      .mockResolvedValue({ ticket: makeTicket({ priority: 'URGENT' }) });
    resolve = vi
      .spyOn(ticketService, 'resolve')
      .mockResolvedValue({ ticket: makeTicket({ status: 'RESOLVED' }) });
    reopen = vi
      .spyOn(ticketService, 'reopen')
      .mockResolvedValue({ ticket: makeTicket({ status: 'OPEN' }) });
    vi.spyOn(customerService, 'get').mockResolvedValue({ customer: makeCustomer() });
  });

  it('renders the ticket and its linked customer', async () => {
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Invoice shows the wrong total' }),
    ).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('ws-1', TEST_TICKET_ID, expect.any(AbortSignal));
    expect(screen.getAllByText('TKT-000001').length).toBeGreaterThan(0);
    expect(
      screen.getByText('The September invoice is 20 EUR too high.'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Jordan Lee' })).toBeInTheDocument();
  });

  it('offers only the transitions the backend allows from the current status', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Invoice shows the wrong total' });

    const options = within(screen.getByLabelText('Status')).getAllByRole('option');
    const labels = options.map((option) => option.textContent);

    expect(labels).toEqual(['Change status…', 'In progress', 'Waiting for customer', 'Closed']);
    expect(labels).not.toContain('Resolved');
  });

  it('changes status through the API and refetches the ticket', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Invoice shows the wrong total' });

    await user.selectOptions(screen.getByLabelText('Status'), 'IN_PROGRESS');

    await waitFor(() => {
      expect(setStatus).toHaveBeenCalledWith('ws-1', TEST_TICKET_ID, 'IN_PROGRESS');
    });
    await waitFor(() => {
      expect(get).toHaveBeenCalledTimes(2);
    });
  });

  it('changes priority through the API', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Invoice shows the wrong total' });

    await user.selectOptions(screen.getByLabelText('Priority'), 'URGENT');

    await waitFor(() => {
      expect(setPriority).toHaveBeenCalledWith('ws-1', TEST_TICKET_ID, 'URGENT');
    });
  });

  it('resolves with a note and closes the dialog', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Invoice shows the wrong total' });

    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    await user.type(screen.getByLabelText('Resolution note'), 'Refunded the difference');
    await user.click(screen.getByRole('button', { name: 'Resolve ticket' }));

    await waitFor(() => {
      expect(resolve).toHaveBeenCalledWith('ws-1', TEST_TICKET_ID, 'Refunded the difference');
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('reopens a resolved ticket', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({
      ticket: makeTicket({ status: 'RESOLVED', resolvedAt: '2026-09-07T10:00:00.000Z' }),
    });

    renderPage();
    await screen.findByRole('heading', { name: 'Invoice shows the wrong total' });

    await user.click(screen.getByRole('button', { name: 'Reopen' }));

    await waitFor(() => {
      expect(reopen).toHaveBeenCalledWith('ws-1', TEST_TICKET_ID);
    });
  });

  it('surfaces a rejected transition without leaking the server body', async () => {
    const user = userEvent.setup();
    setStatus.mockRejectedValue(
      new HttpApiError('Cannot change ticket status from OPEN to CLOSED', {
        status: 409,
        code: 'INVALID_STATUS_TRANSITION',
      }),
    );

    renderPage();
    await screen.findByRole('heading', { name: 'Invoice shows the wrong total' });

    await user.selectOptions(screen.getByLabelText('Status'), 'CLOSED');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('rejected that status change');
    expect(alert).not.toHaveTextContent('Cannot change ticket status');
  });

  it('is read-only for a viewer', async () => {
    useRole('viewer');
    renderPage();
    await screen.findByRole('heading', { name: 'Invoice shows the wrong total' });

    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
    expect(screen.queryByLabelText('Status')).toBeNull();
    expect(screen.getByText(/can read tickets but not change them/i)).toBeInTheDocument();
  });

  it('is read-only for an agent who neither opened nor is assigned the ticket', async () => {
    useRole('agent');
    renderPage();
    await screen.findByRole('heading', { name: 'Invoice shows the wrong total' });

    expect(screen.queryByLabelText('Status')).toBeNull();
    expect(screen.getByText(/only the assigned agent, the agent who opened/i)).toBeInTheDocument();
  });

  it('lets the assigned agent manage the ticket', async () => {
    useRole('agent');
    get.mockResolvedValue({ ticket: makeTicket({ agentId: TEST_USER.id }) });

    renderPage();
    await screen.findByRole('heading', { name: 'Invoice shows the wrong total' });

    expect(screen.getByLabelText('Status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
  });

  it('rejects a malformed ticket id without calling the API', async () => {
    renderPage('/tickets/xyz');

    expect(await screen.findByText('Invalid ticket link')).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('renders the not-found state for an unknown or archived ticket', async () => {
    get.mockRejectedValue(new HttpApiError('not found', { status: 404, code: 'NOT_FOUND' }));

    renderPage();

    expect(await screen.findByText('Ticket not found')).toBeInTheDocument();
  });
});
