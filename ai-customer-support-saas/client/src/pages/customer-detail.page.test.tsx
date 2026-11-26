import { render, screen, waitFor } from '@testing-library/react';
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
  makeTicketList,
  makeWorkspace,
  resetAuthStores,
  TEST_CUSTOMER_ID,
  TEST_TICKET_ID,
  TEST_USER,
} from '@/test/fixtures';
import { CustomerDetailPage } from './customer-detail.page';

let get: MockInstance<typeof customerService.get>;
let update: MockInstance<typeof customerService.update>;
let archive: MockInstance<typeof customerService.archive>;
let listTickets: MockInstance<typeof ticketService.list>;

function renderPage(path = `/customers/${TEST_CUSTOMER_ID}`): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/customers/:customerId" element={<CustomerDetailPage />} />
          <Route path="/customers" element={<div>Customer directory marker</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('CustomerDetailPage', () => {
  beforeEach(() => {
    resetAuthStores();
    useSessionStore.setState({ status: 'authenticated', user: TEST_USER, error: null });
    useWorkspaceStore.setState({
      status: 'ready',
      items: [makeWorkspace('ws-1', 'Acme')],
      activeWorkspaceId: 'ws-1',
      error: null,
    });
    get = vi.spyOn(customerService, 'get').mockResolvedValue({ customer: makeCustomer() });
    update = vi
      .spyOn(customerService, 'update')
      .mockResolvedValue({ customer: makeCustomer({ name: 'Jordan Lee Jr' }) });
    archive = vi.spyOn(customerService, 'archive').mockResolvedValue({
      customer: makeCustomer({ archivedAt: '2026-09-12T00:00:00.000Z' }),
    });
    listTickets = vi.spyOn(ticketService, 'list').mockResolvedValue(makeTicketList());
  });

  it('renders the customer API fields and related tickets', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Jordan Lee' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('ws-1', TEST_CUSTOMER_ID, expect.any(AbortSignal));
    expect(screen.getAllByText('jordan@example.com').length).toBeGreaterThan(0);
    expect(screen.getByText('+1 555 010 0100')).toBeInTheDocument();
    expect(screen.getByText('crmId')).toBeInTheDocument();

    const related = await screen.findByRole('list', { name: 'Related tickets' });
    const link = screen.getByRole('link', { name: /Invoice shows the wrong total/ });
    expect(link).toHaveAttribute('href', `/tickets/${TEST_TICKET_ID}`);
    expect(related).toBeInTheDocument();
    expect(listTickets).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ customerId: TEST_CUSTOMER_ID, limit: 5 }),
      expect.any(AbortSignal),
    );
  });

  it('rejects a malformed id without calling the API', async () => {
    renderPage('/customers/not-an-id');

    expect(await screen.findByText('Invalid customer link')).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('renders the not-found state for an unknown or archived customer', async () => {
    get.mockRejectedValue(new HttpApiError('not found', { status: 404, code: 'NOT_FOUND' }));

    renderPage();

    expect(await screen.findByText('Customer not found')).toBeInTheDocument();
  });

  it('hides edit and archive from roles without customer.update', async () => {
    useWorkspaceStore.setState({
      status: 'ready',
      items: [makeWorkspace('ws-1', 'Acme', 'agent')],
      activeWorkspaceId: 'ws-1',
      error: null,
    });

    renderPage();
    await screen.findByRole('heading', { name: 'Jordan Lee' });

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('patches only the changed field and refetches the customer', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Jordan Lee' });

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const nameInput = screen.getByLabelText(/^Name/);
    await user.clear(nameInput);
    await user.type(nameInput, 'Jordan Lee Jr');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith('ws-1', TEST_CUSTOMER_ID, { name: 'Jordan Lee Jr' });
    });
    await waitFor(() => {
      expect(get).toHaveBeenCalledTimes(2);
    });
  });

  it('archives after confirmation and returns to the directory', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Jordan Lee' });

    await user.click(screen.getByRole('button', { name: 'Archive' }));

    expect(await screen.findByText('Archive Jordan Lee?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archive customer' }));

    await waitFor(() => {
      expect(archive).toHaveBeenCalledWith('ws-1', TEST_CUSTOMER_ID);
    });
    expect(await screen.findByText('Customer directory marker')).toBeInTheDocument();
  });

  it('shows a retryable error for a failed read', async () => {
    const user = userEvent.setup();
    get
      .mockRejectedValueOnce(new HttpApiError('boom', { status: 500, code: 'INTERNAL' }))
      .mockResolvedValue({ customer: makeCustomer() });

    renderPage();

    expect(await screen.findByText('Customer unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByRole('heading', { name: 'Jordan Lee' })).toBeInTheDocument();
    expect(makeTicket().number).toBe('TKT-000001');
  });
});
